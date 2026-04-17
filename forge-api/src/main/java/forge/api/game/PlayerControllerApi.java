package forge.api.game;

import com.google.common.collect.Iterables;
import com.google.common.collect.ListMultimap;
import com.google.common.collect.Multimap;
import forge.LobbyPlayer;
import forge.ai.ComputerUtil;
import forge.ai.ComputerUtilMana;
import forge.card.ColorSet;
import forge.card.ICardFace;
import forge.card.MagicColor;
import forge.card.mana.ManaCost;
import forge.card.mana.ManaCostShard;
import forge.deck.Deck;
import forge.deck.DeckSection;
import forge.game.*;
import forge.game.ability.effects.RollDiceEffect;
import forge.game.card.*;
import forge.game.combat.Combat;
import forge.game.combat.CombatUtil;
import forge.game.ability.AbilityUtils;
import forge.game.ability.ApiType;
import forge.game.ability.effects.CharmEffect;
import forge.game.cost.Cost;
import forge.game.cost.CostAdjustment;
import forge.game.cost.CostPart;
import forge.game.cost.CostPartMana;
import forge.game.cost.CostPayment;
import forge.game.keyword.KeywordInterface;
import forge.game.mana.Mana;
import forge.game.mana.ManaConversionMatrix;
import forge.game.mana.ManaCostBeingPaid;
import forge.game.player.*;
import forge.game.replacement.ReplacementEffect;
import forge.game.spellability.*;
import forge.game.staticability.StaticAbility;
import forge.game.staticability.StaticAbilityMustAttack;
import forge.game.trigger.WrappedAbility;
import forge.game.zone.PlayerZone;
import forge.game.zone.ZoneType;
import forge.item.PaperCard;
import forge.util.Aggregates;
import forge.util.ITriggerEvent;
import forge.util.MyRandom;
import forge.util.collect.FCollectionView;
import org.apache.commons.lang3.tuple.ImmutablePair;
import org.apache.commons.lang3.tuple.Pair;

import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;

/**
 * A PlayerController that blocks at key decision points and waits for REST API input.
 * All other decisions (mana payment, triggers, ordering) are handled automatically.
 */
public class PlayerControllerApi extends PlayerController {

    private final GameSession session;
    private final int playerIndex;
    private volatile byte pendingManaColorMask = 0;

    public PlayerControllerApi(Game game, Player player, LobbyPlayer lobbyPlayer,
                               GameSession session, int playerIndex) {
        super(game, player, lobbyPlayer);
        this.session = session;
        this.playerIndex = playerIndex;
    }

    // ── MAIN interactive decision ─────────────────────────────────────────────

    @Override
    public List<SpellAbility> chooseSpellAbilityToPlay() {
        forge.game.phase.PhaseType phase = getGame().getPhaseHandler().getPhase();
        boolean isMyTurn = getGame().getPhaseHandler().isPlayerTurn(player);
        boolean hasStack = !getGame().getStack().isEmpty();

        // Brief pause at MAIN1 start so the UI can show the turn transition
        if (isMyTurn && phase == forge.game.phase.PhaseType.MAIN1) {
            try { Thread.sleep(900); } catch (InterruptedException ignored) {}
        }

        Map<String, SpellAbility> idToSa = new LinkedHashMap<>();
        List<Map<String, Object>> allOptions = new ArrayList<>();

        for (ZoneType zone : Arrays.asList(ZoneType.Hand, ZoneType.Command,
                ZoneType.Graveyard, ZoneType.Exile)) {
            try { addPlayableAbilities(player.getCardsIn(zone), idToSa, allOptions); }
            catch (Exception e) { System.err.println("[API] Error building options for zone " + zone + ": " + e); }
        }
        for (Card c : player.getCardsIn(ZoneType.Battlefield)) {
            int saIdx = 0;
            try {
                for (SpellAbility sa : c.getAllPossibleAbilities(player, true)) {
                    String saId = "C" + c.getId() + ":SA" + saIdx;
                    idToSa.put(saId, sa);
                    try {
                        Map<String, Object> opt = buildSaOption(saId, c, sa, "BATTLEFIELD");
                        if (sa.isManaAbility()) opt.put("isMana", true);
                        allOptions.add(opt);
                    } catch (Exception e) { System.err.println("[API] buildSaOption error for " + c.getName() + ": " + e); }
                    saIdx++;
                }
            } catch (Exception e) { System.err.println("[API] Error building BF options for " + c.getName() + ": " + e); }
        }

        // Partner lock (Duel Commander): once one commander is cast, permanently lock the other(s)
        List<Card> cmdrs = player.getCommanders();
        if (cmdrs.size() >= 2) {
            // First check if session already has a stored lock (persists across CHOOSE_ACTION calls)
            Set<Integer> locked = session.getLockedPartnerIds();
            if (locked == null || locked.isEmpty()) {
                // Try to detect first cast using getCommanderCast
                Set<Integer> castIds = new java.util.HashSet<>();
                for (Card c : cmdrs) {
                    if (player.getCommanderCast(c) > 0) castIds.add(c.getId());
                }
                // Also detect by checking if any commander is NOT in the command zone (on stack or battlefield)
                for (Card c : cmdrs) {
                    if (c.getZone() == null || c.getZone().getZoneType() != ZoneType.Command) {
                        castIds.add(c.getId());
                    }
                }
                if (!castIds.isEmpty()) {
                    Set<Integer> toLock = new java.util.HashSet<>();
                    for (Card c : cmdrs) {
                        if (!castIds.contains(c.getId())) toLock.add(c.getId());
                    }
                    if (!toLock.isEmpty()) {
                        session.setLockedPartnerIds(toLock);
                        locked = toLock;
                        System.err.println("[API] Partner lock: castIds=" + castIds + " locked=" + toLock);
                    }
                }
            }
            if (locked != null && !locked.isEmpty()) {
                final Set<Integer> finalLocked = locked;
                Set<String> idsToRemove = new java.util.HashSet<>();
                for (Map.Entry<String, SpellAbility> entry : idToSa.entrySet()) {
                    Card card = entry.getValue().getHostCard();
                    if (card.getZone() != null
                            && card.getZone().getZoneType() == ZoneType.Command
                            && finalLocked.contains(card.getId())) {
                        idsToRemove.add(entry.getKey());
                    }
                }
                if (!idsToRemove.isEmpty()) {
                    allOptions.removeIf(o -> idsToRemove.contains(o.get("id")));
                    idsToRemove.forEach(idToSa::remove);
                }
            }
        }

        Map<String, Object> data = new LinkedHashMap<>();
        // Send ALL options (including mana) so bf card clicks can find mana abilities
        data.put("options", allOptions);
        if (hasStack) data.put("responding", true);
        if (!isMyTurn) data.put("opponentTurn", true);
        if (phase != null) data.put("phase", phase.name());

        // Always ask the player — no auto-pass. Player 1 manually validates every priority window.
        session.publishDecision("CHOOSE_ACTION", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(10, TimeUnit.MINUTES);

        if (response == null) return null;
        String choice = (String) response.get("choice");
        if (choice == null || choice.equals("pass")) return null;

        Object manaColorObj = response.get("manaColor");
        if (manaColorObj instanceof String) {
            String mc = (String) manaColorObj;
            pendingManaColorMask = switch (mc) {
                case "W" -> MagicColor.WHITE;
                case "U" -> MagicColor.BLUE;
                case "B" -> MagicColor.BLACK;
                case "R" -> MagicColor.RED;
                case "G" -> MagicColor.GREEN;
                default  -> 0;
            };
        }

        SpellAbility sa = idToSa.get(choice);
        if (sa == null) return null;
        return Collections.singletonList(sa);
    }

    private void addPlayableAbilities(CardCollectionView cards,
                                      Map<String, SpellAbility> idToSa,
                                      List<Map<String, Object>> options) {
        for (Card c : cards) {
            int saIdx = 0;
            try {
                for (SpellAbility sa : c.getAllPossibleAbilities(player, true)) {
                    String saId = "C" + c.getId() + ":SA" + saIdx;
                    idToSa.put(saId, sa);
                    String zone = c.getZone() != null ? c.getZone().getZoneType().name() : "UNKNOWN";
                    try { options.add(buildSaOption(saId, c, sa, zone)); }
                    catch (Exception e) { System.err.println("[API] buildSaOption error for " + c.getName() + ": " + e); }
                    saIdx++;
                }
            } catch (Exception e) { System.err.println("[API] getAllPossibleAbilities error for " + c.getName() + ": " + e); }
        }
    }

    private Map<String, Object> buildSaOption(String saId, Card c, SpellAbility sa, String zone) {
        Map<String, Object> opt = new LinkedHashMap<>();
        opt.put("id", saId);
        opt.put("card", c.getName());
        opt.put("cardId", c.getId());
        opt.put("zone", zone);
        opt.put("isLand", sa.isLandAbility());
        try {
            // Apply static cost adjustments (ReduceCost, etc.) for accurate display
            forge.game.cost.Cost adjustedCost =
                    forge.game.cost.CostAdjustment.adjust(sa.getPayCosts(), sa, false);
            opt.put("manaCost", adjustedCost.getTotalMana().toString());
        } catch (Exception ignored) {
            try { opt.put("manaCost", sa.getPayCosts().getTotalMana().toString()); } catch (Exception ignored2) {}
        }
        opt.put("description", sa.toString());
        // MDFC back-face land play detection (compare by name to avoid CardStateName classpath issues)
        boolean isBackFaceLand = false;
        try {
            isBackFaceLand = sa.isLandAbility()
                    && sa.getCardState() != null
                    && sa.getCardState().getView() != null
                    && "Backside".equals(sa.getCardState().getView().getState().name());
        } catch (Throwable ignored) {}
        if (isBackFaceLand) {
            opt.put("isBackFaceLand", true);
            try { opt.put("backFaceName", sa.getCardState().getName()); } catch (Exception ignored) {}
        }
        // Color identity of the face being played (for MDFC/land display)
        if (sa.isLandAbility()) {
            try {
                CardState faceState = (sa.getCardState() != null) ? sa.getCardState() : c.getCurrentState();
                ColorSet cs = faceState.getColor();
                java.util.List<String> colors = new java.util.ArrayList<>();
                if (cs.hasWhite())  colors.add("W");
                if (cs.hasBlue())   colors.add("U");
                if (cs.hasBlack())  colors.add("B");
                if (cs.hasRed())    colors.add("R");
                if (cs.hasGreen())  colors.add("G");
                if (!colors.isEmpty()) opt.put("faceColors", colors);
            } catch (Exception ignored) {}
        }
        return opt;
    }

    // ── Combat ────────────────────────────────────────────────────────────────

    @Override
    public void declareAttackers(Player attacker, Combat combat) {
        List<Map<String, Object>> attackerOptions = new ArrayList<>();
        List<Integer> requiredIds = new ArrayList<>();
        for (Card c : attacker.getCreaturesInPlay()) {
            if (CombatUtil.canAttack(c)) {
                Map<String, Object> opt = new LinkedHashMap<>();
                opt.put("id", c.getId());
                opt.put("name", c.getName());
                opt.put("power", c.getNetPower());
                opt.put("toughness", c.getNetToughness());
                // MustAttack (e.g. DRC with delirium, Goad effects)
                if (!StaticAbilityMustAttack.entitiesMustAttack(c).isEmpty()) {
                    requiredIds.add(c.getId());
                    opt.put("mustAttack", true);
                }
                attackerOptions.add(opt);
            }
        }

        List<Map<String, Object>> defenderOptions = new ArrayList<>();
        for (GameEntity def : combat.getDefenders()) {
            Map<String, Object> opt = new LinkedHashMap<>();
            if (def instanceof Player) {
                opt.put("id", "P" + def.getId());
                opt.put("name", ((Player) def).getName());
                opt.put("type", "player");
            } else if (def instanceof Card) {
                opt.put("id", "C" + def.getId());
                opt.put("name", ((Card) def).getName());
                opt.put("type", "card");
            }
            defenderOptions.add(opt);
        }

        // No creatures can attack — skip silently
        if (attackerOptions.isEmpty()) return;

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("attackers", attackerOptions);
        data.put("defenders", defenderOptions);
        if (!requiredIds.isEmpty()) data.put("requiredAttackers", requiredIds);
        session.publishDecision("DECLARE_ATTACKERS", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(10, TimeUnit.MINUTES);
        if (response == null) return;

        // Expected format: assignments = ["5:P1", "7:P1"]  (cardId:targetId)
        Object assignmentsRaw = response.get("assignments");
        if (!(assignmentsRaw instanceof List)) return;

        Map<Integer, Card> cardsById = new HashMap<>();
        for (Card c : attacker.getCreaturesInPlay()) cardsById.put(c.getId(), c);

        Map<String, GameEntity> targetMap = new HashMap<>();
        for (GameEntity def : combat.getDefenders()) {
            if (def instanceof Player) targetMap.put("P" + def.getId(), def);
            else if (def instanceof Card) targetMap.put("C" + def.getId(), def);
        }

        for (Object a : (List<?>) assignmentsRaw) {
            if (!(a instanceof String)) continue;
            String[] parts = ((String) a).split(":");
            if (parts.length != 2) continue;
            try {
                int cardId = Integer.parseInt(parts[0]);
                Card attackerCard = cardsById.get(cardId);
                GameEntity target = targetMap.get(parts[1]);
                if (attackerCard != null && target != null && CombatUtil.canAttack(attackerCard, target)) {
                    combat.addAttacker(attackerCard, target);
                }
            } catch (NumberFormatException ignored) {}
        }
    }

    @Override
    public void declareBlockers(Player defender, Combat combat) {
        List<Map<String, Object>> blockerOptions = new ArrayList<>();
        for (Card c : defender.getCreaturesInPlay()) {
            if (CombatUtil.canBlock(c, combat)) {
                Map<String, Object> opt = new LinkedHashMap<>();
                opt.put("id", c.getId());
                opt.put("name", c.getName());
                opt.put("power", c.getNetPower());
                opt.put("toughness", c.getNetToughness());
                blockerOptions.add(opt);
            }
        }

        List<Map<String, Object>> attackerList = new ArrayList<>();
        for (Card a : combat.getAttackers()) {
            Map<String, Object> opt = new LinkedHashMap<>();
            opt.put("id", a.getId());
            opt.put("name", a.getName());
            opt.put("power", a.getNetPower());
            opt.put("toughness", a.getNetToughness());
            attackerList.add(opt);
        }

        // No creatures can block — skip silently
        if (blockerOptions.isEmpty()) return;

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("blockers", blockerOptions);
        data.put("attackers", attackerList);
        session.publishDecision("DECLARE_BLOCKERS", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(10, TimeUnit.MINUTES);
        if (response == null) return;

        // Expected format: assignments = ["3:5", "4:5"]  (blockerId:attackerId)
        Object assignmentsRaw = response.get("assignments");
        if (!(assignmentsRaw instanceof List)) return;

        Map<Integer, Card> defenderCards = new HashMap<>();
        for (Card c : defender.getCreaturesInPlay()) defenderCards.put(c.getId(), c);
        Map<Integer, Card> attackerById = new HashMap<>();
        for (Card a : combat.getAttackers()) attackerById.put(a.getId(), a);

        for (Object a : (List<?>) assignmentsRaw) {
            if (!(a instanceof String)) continue;
            String[] parts = ((String) a).split(":");
            if (parts.length != 2) continue;
            try {
                int blockerId = Integer.parseInt(parts[0]);
                int attackId = Integer.parseInt(parts[1]);
                Card blocker = defenderCards.get(blockerId);
                Card attackerCard = attackerById.get(attackId);
                if (blocker != null && attackerCard != null && CombatUtil.canBlock(attackerCard, blocker)) {
                    combat.addBlocker(attackerCard, blocker);
                }
            } catch (NumberFormatException ignored) {}
        }
    }

    // ── Mulligan ──────────────────────────────────────────────────────────────

    @Override
    public boolean mulliganKeepHand(Player firstPlayer, int cardsToReturn) {
        List<Map<String, Object>> hand = new ArrayList<>();
        for (Card c : firstPlayer.getCardsIn(ZoneType.Hand)) {
            Map<String, Object> card = new LinkedHashMap<>();
            card.put("id", c.getId());
            card.put("name", c.getName());
            try { card.put("manaCost", c.getManaCost().toString()); } catch (Exception ignored) {}
            hand.add(card);
        }
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("hand", hand);
        data.put("cardsToReturn", cardsToReturn);
        session.publishDecision("MULLIGAN", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(5, TimeUnit.MINUTES);
        if (response == null) return true; // auto-keep on timeout
        Object keep = response.get("keep");
        if (keep instanceof Boolean) return (Boolean) keep;
        if (keep instanceof String) return !"false".equalsIgnoreCase((String) keep) && !"mulligan".equalsIgnoreCase((String) keep);
        return true;
    }

    // ── Damage assignment (auto: assign all to first blocker) ─────────────────

    @Override
    public Map<Card, Integer> assignCombatDamage(Card attacker, CardCollectionView blockers,
                                                  CardCollectionView remaining, int damageDealt,
                                                  GameEntity defender, boolean overrideOrder) {
        Map<Card, Integer> result = new HashMap<>();
        if (blockers.isEmpty()) {
            // no blockers, damage goes to defender (handled by engine)
        } else {
            // Assign all remaining damage to first blocker
            Card first = blockers.get(0);
            result.put(first, damageDealt);
        }
        return result;
    }

    // ── Mana payment: auto-pay via AI logic ───────────────────────────────────

    @Override
    public boolean payManaCost(ManaCost toPay, CostPartMana costPartMana, SpellAbility sa,
                               String prompt, ManaConversionMatrix matrix, boolean effect) {
        // Mode debug : mana infini — skip le paiement réel, gère juste {X}
        if (session.isDebug()) {
            if (toPay.countX() > 0 && sa.getXManaCostPaid() == null) {
                int x = chooseNumber(sa, "Valeur de X", 0, 20);
                sa.setXManaCostPaid(x);
            }
            return true;
        }
        ManaCostBeingPaid cost = new ManaCostBeingPaid(toPay);
        // Apply ReduceCost static abilities (e.g. Embercleave) — mirrors calculateManaCost in ComputerUtilMana
        try { CostAdjustment.adjust(cost, sa, player, null, false, effect); } catch (Exception ignored) {}
        System.err.println("[API] payManaCost: " + toPay + " (adjusted: " + cost + ") for " + sa.getHostCard().getName()
                + " | pool=" + player.getManaPool()
                + " | lands=" + player.getCardsIn(ZoneType.Battlefield).stream()
                    .filter(forge.game.card.Card::isLand).map(forge.game.card.Card::getName)
                    .collect(java.util.stream.Collectors.joining(", ")));
        // Phyrexian mana: ask how many symbols to pay with life (0..phyCount)
        if (cost.containsPhyrexianMana()) {
            ManaCostBeingPaid tempCost = new ManaCostBeingPaid(toPay);
            int phyCount = 0;
            while (tempCost.payPhyrexian()) phyCount++;

            if (phyCount > 0) {
                // Find max we can pay with life
                int maxWithLife = 0;
                for (int i = phyCount; i >= 1; i--) {
                    if (player.canPayLife(i * 2, false, sa)) { maxWithLife = i; break; }
                }
                int chosen = 0;
                if (maxWithLife > 0) {
                    String cardName = sa.getHostCard() != null ? sa.getHostCard().getName() : "";
                    if (phyCount == 1) {
                        // Single symbol: simple yes/no
                        Map<String, Object> data = new LinkedHashMap<>();
                        data.put("prompt", "Mana phyrexian (" + cardName + ") : payer 2 PV au lieu de mana coloré ?");
                        data.put("card", cardName);
                        session.publishDecision("CONFIRM_ACTION", playerIndex, data);
                        Map<String, Object> response = session.awaitDecision(5, TimeUnit.MINUTES);
                        if (response != null && "yes".equals(response.get("choice"))) chosen = 1;
                    } else {
                        // Multiple symbols: choose how many (0..maxWithLife)
                        chosen = chooseNumber(sa,
                                cardName + " — Combien de mana phyrexian payer avec des PV ? (×2 PV chacun, max " + (maxWithLife * 2) + " PV)",
                                0, maxWithLife);
                    }
                }
                if (chosen > 0) {
                    for (int i = 0; i < chosen; i++) cost.payPhyrexian();
                    player.payLife(chosen * 2, sa, false);
                }
            }
        }

        boolean ok = ComputerUtilMana.payManaCost(cost, sa, player, effect);
        System.err.println("[API] payManaCost result=" + ok + " remaining=" + cost
                + " | pool after=" + player.getManaPool());
        return ok;
    }

    // ── Trigger and stack handling: delegate to AI logic ─────────────────────

    @Override
    public void playSpellAbilityNoStack(SpellAbility effectSA, boolean mayChoseNewTargets) {
        effectSA.setActivatingPlayer(player);

        // Charm triggered abilities (e.g. Hullbreaker Horror) need mode selection before resolving.
        // In the normal cast path this is handled by ComputerUtil/HumanPlaySpellAbility, but
        // triggered abilities resolve via playSpellAbilityNoStack and skip that path.
        if (effectSA.getApi() == ApiType.Charm) {
            if (!CharmEffect.makeChoices(effectSA)) {
                // 603.3c: trigger with no chosen modes is removed from the stack
                return;
            }
        }

        // Pay costs interactively (e.g. Inti's discard cost) instead of using AI
        CostPayment pay = new CostPayment(effectSA.getPayCosts(), effectSA);
        boolean paid = pay.payComputerCosts(new ApiCostDecision(player, effectSA,
                (cards, prompt) -> pickCardsInteractive(cards, prompt, 1, 1, false),
                (min, max) -> chooseNumber(effectSA, "Payer X points de vie", min, max)));
        if (paid) {
            AbilityUtils.resolve(effectSA);
        }
    }

    @Override
    public void orderAndPlaySimultaneousSa(List<SpellAbility> activePlayerSAs) {
        for (SpellAbility sa : activePlayerSAs) {
            try {
                Card host = sa.getHostCard();
                String cardName = host != null ? host.getName() : "(null host)";
                System.err.println("[API] orderAndPlaySimultaneousSa: " + cardName
                        + " | " + sa.getDescription() + " | trigger=" + sa.isTrigger()
                        + " | usesTargeting=" + sa.usesTargeting());
                // If the trigger requires targets, ask the player before putting it on the stack
                if (sa.isTrigger() && sa.usesTargeting()) {
                    boolean ok = chooseTargetsFor(sa);
                    int numTargeted = sa.getTargets() != null ? sa.getTargets().size() : 0;
                    System.err.println("[API] chooseTargetsFor result=" + ok
                            + " numTargeted=" + numTargeted);
                    forge.game.spellability.TargetRestrictions tgt = sa.getTargetRestrictions();
                    if (!ok && tgt != null && host != null && tgt.getMinTargets(host, sa) > 0) {
                        System.err.println("[API] Skipping trigger (no valid targets)");
                        continue;
                    }
                }
                getGame().getStack().add(sa);
            } catch (Exception e) {
                System.err.println("[API] orderAndPlaySimultaneousSa ERROR for "
                        + (sa.getHostCard() != null ? sa.getHostCard().getName() : "?") + ": " + e);
                e.printStackTrace(System.err);
                // Fall back: still try to add to stack to avoid hanging
                try { getGame().getStack().add(sa); } catch (Exception ignored) {}
            }
        }
    }

    @Override
    public boolean playTrigger(Card host, WrappedAbility wrapperAbility, boolean isMandatory) {
        System.err.println("[API] playTrigger: " + host.getName()
                + " | mandatory=" + isMandatory
                + " | desc=" + wrapperAbility.getDescription());
        // Mandatory triggers (lore counters, upkeep effects, ETB, etc.) always fire
        if (isMandatory) return true;
        // Optional triggers: ask the player
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("card", host.getName());
        data.put("description", wrapperAbility.getDescription());
        data.put("prompt", "Déclencher : " + wrapperAbility.getDescription() + " ?");
        data.put("optional", true);
        session.publishDecision("CONFIRM_TRIGGER", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(5, TimeUnit.MINUTES);
        if (response == null) return true; // auto-yes on timeout
        Object choice = response.get("choice");
        return !"no".equals(choice) && !"false".equals(String.valueOf(choice));
    }

    @Override
    public boolean playSaFromPlayEffect(SpellAbility tgtSA) {
        if (tgtSA instanceof Spell) {
            if (tgtSA.canPlay() || !tgtSA.getPayCosts().isMandatory()) {
                ComputerUtil.playStack(tgtSA, player, getGame());
            } else return false;
        }
        return true;
    }

    @Override
    public boolean playChosenSpellAbility(SpellAbility sa) {
        if (sa.isLandAbility()) {
            // For MDFC back-face lands, set the correct card state before playing
            try { sa.getHostCard().setSplitStateToPlayAbility(sa); } catch (Exception ignored) {}
            if (!player.playLand(sa.getHostCard(), false, sa)) {
                System.err.println("[API] playLand=false for " + sa.getHostCard().getName());
                return false;
            }
            System.err.println("[API] Land played: " + sa.getHostCard().getName()
                    + " zone=" + sa.getHostCard().getZone());
        } else {
            System.err.println("[API] playChosenSpellAbility: " + sa.getHostCard().getName()
                    + " zone=" + sa.getHostCard().getZone()
                    + " cost=" + sa.getPayCosts());
            // Capture original zone BEFORE handlePlayingSpellAbility moves the card to Stack
            ZoneType originalZone = sa.getHostCard().getZone() != null
                    ? sa.getHostCard().getZone().getZoneType() : ZoneType.Hand;
            // Traverse the full SA chain (handles Charm/modal spells whose sub-abilities carry targeting)
            Runnable targetChooser = () -> chooseTargetsForChain(sa);
            boolean ok = ComputerUtil.handlePlayingSpellAbility(player, sa, targetChooser,
                    finalSa -> new ApiCostDecision(player, finalSa,
                            (cards, prompt) -> pickCardsInteractive(cards, prompt, 1, 1, false),
                            (min, max) -> chooseNumber(finalSa, "Payer X points de vie", min, max)));
            System.err.println("[API] after handlePlaying: " + sa.getHostCard().getName()
                    + " zone=" + sa.getHostCard().getZone() + " ok=" + ok);
            if (!ok) {
                // Forge bug (ComputerUtil.java:132): card is moved to Stack BEFORE paying costs.
                // If payment fails the recovery logic doesn't fire for cards from Hand.
                // Rescue the card back to its original zone.
                Card hostCard = sa.getHostCard();
                if (hostCard != null && hostCard.getZone() != null
                        && hostCard.getZone().getZoneType() == ZoneType.Stack) {
                    System.err.println("[API] Rescuing stuck card " + hostCard.getName()
                            + " from Stack → " + originalZone);
                    getGame().getAction().moveTo(originalZone, hostCard, sa, null);
                }
                return false;
            }
        }
        return true;
    }

    @Override
    public boolean chooseTargetsFor(SpellAbility sa) {
        forge.game.spellability.TargetRestrictions tgt = sa.getTargetRestrictions();
        if (tgt == null) return true;
        Card saHost = sa.getHostCard();
        if (saHost == null) return true; // can't determine targets without host

        int minT = tgt.getMinTargets(saHost, sa);
        int maxT = tgt.getMaxTargets(saHost, sa);

        // Collect all valid targets
        List<Map<String, Object>> validTargets = new ArrayList<>();

        // Players
        for (Player p : getGame().getPlayers()) {
            if (sa.canTarget(p)) {
                Map<String, Object> t = new LinkedHashMap<>();
                t.put("kind", "player");
                t.put("id", "P" + p.getId());
                t.put("name", p.getName());
                validTargets.add(t);
            }
        }

        // Cards on battlefield, graveyard, hand, exile
        for (ZoneType zone : Arrays.asList(ZoneType.Battlefield, ZoneType.Graveyard,
                ZoneType.Hand, ZoneType.Exile)) {
            for (Card c : getGame().getCardsIn(zone)) {
                if (sa.canTarget(c)) {
                    Map<String, Object> t = new LinkedHashMap<>();
                    t.put("kind", "card");
                    t.put("id", c.getId());
                    t.put("name", c.getName());
                    t.put("zone", zone.name());
                    validTargets.add(t);
                }
            }
        }

        // Stack zone: Forge targets SpellAbility objects (not Card objects).
        // canTarget(SpellAbility) delegates to SpellAbility.canBeTargetedBy → canTargetSpellAbility,
        // which correctly handles TargetType$Spell for any spell type (creatures, instants, etc.)
        for (SpellAbilityStackInstance si : getGame().getStack()) {
            SpellAbility stackSa = si.getSpellAbility();
            if (sa.canTarget(stackSa)) {
                Map<String, Object> t = new LinkedHashMap<>();
                t.put("kind", "card");
                t.put("id", si.getSourceCard().getId()); // Use host card ID for frontend stack-item matching
                t.put("name", si.getSourceCard().getName());
                t.put("zone", "Stack");
                validTargets.add(t);
            }
        }

        if (validTargets.isEmpty()) return minT == 0;

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("validTargets", validTargets);
        data.put("min", minT);
        data.put("max", maxT);
        data.put("spell", sa.getHostCard().getName());
        data.put("sourceCardId", sa.getHostCard().getId());
        data.put("description", sa.getDescription());

        // Divided-as-you-choose (Forked Bolt, Fury, Arc Trail…)
        boolean isDivided = sa.isDividedAsYouChoose();
        if (isDivided) {
            Integer totalDmg = sa.getDividedValue();
            if (totalDmg == null) {
                // clearTargets() is Forge's own initializer for dividedValue
                try { sa.clearTargets(); totalDmg = sa.getDividedValue(); } catch (Exception ignored) {}
            }
            if (totalDmg == null) {
                // Fallback: evaluate the SVar param directly
                String divParam = sa.getParam("DividedAsYouChoose");
                if (divParam != null) {
                    try { totalDmg = forge.game.ability.AbilityUtils.calculateAmount(sa.getHostCard(), divParam, sa); }
                    catch (Exception ignored) {}
                }
            }
            if (totalDmg == null) {
                // Last resort: parse as literal integer
                String divParam = sa.getParam("DividedAsYouChoose");
                if (divParam != null) {
                    try { totalDmg = Integer.parseInt(divParam.trim()); }
                    catch (NumberFormatException ignored) {}
                }
            }
            System.err.println("[API] chooseTargetsFor " + saHost.getName()
                    + " isDivided=true divParam=" + sa.getParam("DividedAsYouChoose")
                    + " totalDmg=" + totalDmg);
            data.put("isDivided", true);
            data.put("dividedTotal", totalDmg != null ? totalDmg : 0);
        }

        session.publishDecision("CHOOSE_TARGETS", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(5, TimeUnit.MINUTES);

        if (response == null) return minT == 0;
        Object chosenRaw = response.get("targets");
        if (!(chosenRaw instanceof List)) return minT == 0;

        List<?> chosenList = (List<?>) chosenRaw;
        for (Object entry : chosenList) {
            applyTargetById(sa, entry.toString());
        }

        // Apply divided allocations if provided
        if (isDivided) {
            Object allocRaw = response.get("dividedAllocations");
            if (allocRaw instanceof Map<?,?> allocMap) {
                for (Object targetId : chosenList) {
                    Object amtObj = allocMap.get(targetId.toString());
                    if (amtObj instanceof Number) {
                        int amt = ((Number) amtObj).intValue();
                        // Find the corresponding GameObject and allocate
                        applyDividedAllocation(sa, targetId.toString(), amt);
                    }
                }
            } else {
                // No explicit allocation: distribute evenly (last target gets remainder)
                Integer total = sa.getDividedValue();
                if (total != null && !chosenList.isEmpty()) {
                    int perTarget = total / chosenList.size();
                    int remainder = total % chosenList.size();
                    for (int i = 0; i < chosenList.size(); i++) {
                        int amt = perTarget + (i == chosenList.size() - 1 ? remainder : 0);
                        applyDividedAllocation(sa, chosenList.get(i).toString(), amt);
                    }
                }
            }
        }

        return sa.getTargets().size() >= minT;
    }

    /**
     * Traverse the full SA chain and call chooseTargetsFor on each sub-ability that uses targeting.
     * Required for Charm/modal spells where targeting is defined on sub-abilities, not the main SA.
     */
    private void chooseTargetsForChain(SpellAbility sa) {
        SpellAbility cur = sa;
        while (cur != null) {
            if (cur.usesTargeting()) {
                boolean ok = chooseTargetsFor(cur);
                if (!ok) return; // targeting cancelled or no valid targets
            }
            cur = cur.getSubAbility();
        }
    }

    private void applyTarget(SpellAbility sa, Map<String, Object> t) {
        applyTargetById(sa, t.get("id").toString());
    }

    private void applyTargetById(SpellAbility sa, String id) {
        try {
            if (id.startsWith("P")) {
                int pid = Integer.parseInt(id.substring(1));
                for (Player p : getGame().getPlayers()) {
                    if (p.getId() == pid) { sa.getTargets().add(p); return; }
                }
            } else {
                int cid = Integer.parseInt(id);
                // Stack first: Forge uses SpellAbility as the target for spells on the stack
                for (SpellAbilityStackInstance si : getGame().getStack()) {
                    if (si.getSourceCard().getId() == cid) {
                        sa.getTargets().add(si.getSpellAbility());
                        return;
                    }
                }
                // Other zones: Card objects
                for (ZoneType zone : Arrays.asList(ZoneType.Battlefield, ZoneType.Graveyard,
                        ZoneType.Hand, ZoneType.Exile)) {
                    for (Card c : getGame().getCardsIn(zone)) {
                        if (c.getId() == cid) { sa.getTargets().add(c); return; }
                    }
                }
            }
        } catch (NumberFormatException ignored) {}
    }

    /** Apply a divided damage allocation to the appropriate GameObject in sa's targets. */
    private void applyDividedAllocation(SpellAbility sa, String id, int amount) {
        try {
            if (id.startsWith("P")) {
                int pid = Integer.parseInt(id.substring(1));
                for (Player p : getGame().getPlayers()) {
                    if (p.getId() == pid) { sa.addDividedAllocation(p, amount); return; }
                }
            } else {
                int cid = Integer.parseInt(id);
                for (SpellAbilityStackInstance si : getGame().getStack()) {
                    if (si.getSourceCard().getId() == cid) {
                        sa.addDividedAllocation(si.getSpellAbility(), amount); return;
                    }
                }
                for (ZoneType zone : Arrays.asList(ZoneType.Battlefield, ZoneType.Graveyard,
                        ZoneType.Hand, ZoneType.Exile)) {
                    for (Card c : getGame().getCardsIn(zone)) {
                        if (c.getId() == cid) { sa.addDividedAllocation(c, amount); return; }
                    }
                }
            }
        } catch (NumberFormatException ignored) {}
    }

    @Override
    public SpellAbility getAbilityToPlay(Card hostCard, List<SpellAbility> abilities, ITriggerEvent triggerEvent) {
        return Iterables.getFirst(abilities, null);
    }

    // ── Simple/default implementations ───────────────────────────────────────

    @Override
    public List<PaperCard> sideboard(Deck deck, GameType gameType, String message) { return null; }

    @Override
    public List<PaperCard> chooseCardsYouWonToAddToDeck(List<PaperCard> losses) { return losses; }

    @Override
    public Map<GameEntity, Integer> divideShield(Card effectSource, Map<GameEntity, Integer> affected, int shieldAmount) {
        return affected;
    }

    @Override
    public Map<Byte, Integer> specifyManaCombo(SpellAbility sa, ColorSet colorSet, int manaAmount, boolean different) {
        // Build list of available colors from colorSet
        byte[] allColors = { MagicColor.WHITE, MagicColor.BLUE, MagicColor.BLACK, MagicColor.RED, MagicColor.GREEN };
        List<Byte> available = new ArrayList<>();
        for (byte c : allColors) {
            if (colorSet.hasAnyColor(c)) available.add(c);
        }
        if (available.isEmpty()) {
            Map<Byte, Integer> r = new HashMap<>();
            r.put(MagicColor.COLORLESS, manaAmount);
            return r;
        }
        if (available.size() == 1) {
            Map<Byte, Integer> r = new HashMap<>();
            r.put(available.get(0), manaAmount);
            return r;
        }

        // Build all valid combinations (multisets of size manaAmount from available colors)
        List<Map<Byte, Integer>> combos = new ArrayList<>();
        buildManaCombos(available, manaAmount, different, new HashMap<>(), combos);

        if (combos.size() == 1) return combos.get(0);

        // Format each combo as a label like "RR", "RW", "WW"
        List<String> labels = new ArrayList<>();
        for (Map<Byte, Integer> combo : combos) {
            StringBuilder sb = new StringBuilder();
            for (byte c : allColors) {
                int cnt = combo.getOrDefault(c, 0);
                for (int i = 0; i < cnt; i++) sb.append(MagicColor.toShortString(c));
            }
            labels.add(sb.toString());
        }

        String card = sa != null && sa.getHostCard() != null ? sa.getHostCard().getName() : "";
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("prompt", "Choisir la production de mana");
        data.put("card", card);
        data.put("options", labels);
        session.publishDecision("CHOOSE_MANA_COMBO", playerIndex, data);
        Map<String, Object> resp = session.awaitDecision(5, TimeUnit.MINUTES);

        int idx = 0;
        if (resp != null && resp.get("choice") instanceof String chosen) {
            idx = labels.indexOf(chosen);
            if (idx < 0) idx = 0;
        } else if (resp != null && resp.get("index") instanceof Number n) {
            idx = Math.max(0, Math.min(n.intValue(), combos.size() - 1));
        }
        return combos.get(idx);
    }

    private void buildManaCombos(List<Byte> colors, int remaining, boolean different,
                                  Map<Byte, Integer> current, List<Map<Byte, Integer>> out) {
        if (remaining == 0) { out.add(new HashMap<>(current)); return; }
        for (int i = 0; i < colors.size(); i++) {
            byte c = colors.get(i);
            if (different && current.containsKey(c)) continue;
            current.merge(c, 1, Integer::sum);
            // Only iterate from i onward to avoid duplicate combos (e.g. RW == WR)
            buildManaCombos(colors.subList(i, colors.size()), remaining - 1, different, current, out);
            current.merge(c, -1, Integer::sum);
            if (current.get(c) == 0) current.remove(c);
        }
    }

    @Override
    public CardCollectionView choosePermanentsToSacrifice(SpellAbility sa, int min, int max,
                                                          CardCollectionView validTargets, String message) {
        if (validTargets == null || validTargets.isEmpty()) return new CardCollection();
        // Only one valid target and mandatory — no real choice
        if (validTargets.size() == 1 && min >= 1) return new CardCollection(validTargets);
        String prompt = (message != null && !message.isBlank()) ? message
                : "Sacrifier " + (min == max ? min : min + "–" + max) + " permanent(s)";
        return pickCardsInteractive(validTargets, prompt, min, max, min == 0);
    }

    @Override
    public CardCollectionView choosePermanentsToDestroy(SpellAbility sa, int min, int max,
                                                        CardCollectionView validTargets, String message) {
        if (validTargets == null || validTargets.isEmpty()) return new CardCollection();
        if (validTargets.size() == 1 && min >= 1) return new CardCollection(validTargets);
        String prompt = (message != null && !message.isBlank()) ? message
                : "Détruire " + (min == max ? min : min + "–" + max) + " permanent(s)";
        return pickCardsInteractive(validTargets, prompt, min, max, min == 0);
    }

    @Override
    public Integer announceRequirements(SpellAbility ability, String announce) { return 0; }

    @Override
    public TargetChoices chooseNewTargetsFor(SpellAbility ability, Predicate<GameObject> filter, boolean optional) {
        if (ability == null) return null;
        ability.clearTargets();
        boolean ok = chooseTargetsFor(ability);
        if (!ok && !optional) return null;
        return ability.getTargets();
    }

    @Override
    public Pair<SpellAbilityStackInstance, GameObject> chooseTarget(SpellAbility sa,
                                                                     List<Pair<SpellAbilityStackInstance, GameObject>> allTargets) {
        return Iterables.getFirst(allTargets, null);
    }

    @Override
    public boolean helpPayForAssistSpell(ManaCostBeingPaid cost, SpellAbility sa, int max, int requested) { return true; }

    @Override
    public Player choosePlayerToAssistPayment(FCollectionView<Player> optionList, SpellAbility sa, String title, int max) {
        return Iterables.getFirst(optionList, null);
    }

    @Override
    public CardCollectionView chooseCardsForEffect(CardCollectionView sourceList, SpellAbility sa, String title,
                                                   int min, int max, boolean isOptional, Map<String, Object> params) {
        if (sourceList == null || sourceList.isEmpty()) return new CardCollection();
        return pickCardsInteractive(sourceList, title, min, max, isOptional);
    }

    @Override
    public CardCollection chooseCardsForEffectMultiple(Map<String, CardCollection> validMap, SpellAbility sa,
                                                       String title, boolean isOptional) {
        if (validMap == null || validMap.isEmpty())
            return isOptional ? new CardCollection() : new CardCollection();
        // Flatten all options into a single list and let the player pick one group
        for (Map.Entry<String, CardCollection> entry : validMap.entrySet()) {
            CardCollection group = entry.getValue();
            if (!group.isEmpty()) {
                CardCollectionView picked = pickCardsInteractive(group, title + " — " + entry.getKey(),
                        isOptional ? 0 : 1, 1, isOptional);
                if (!picked.isEmpty()) return new CardCollection(picked);
            }
        }
        return new CardCollection();
    }

    @Override
    public <T extends GameEntity> T chooseSingleEntityForEffect(FCollectionView<T> optionList,
                                                                 DelayedReveal delayedReveal, SpellAbility sa,
                                                                 String title, boolean isOptional, Player relatedPlayer,
                                                                 Map<String, Object> params) {
        if (delayedReveal != null) reveal(delayedReveal);
        if (optionList == null || optionList.isEmpty()) return null;
        // Only Card and Player entities are serializable interactively
        List<Map<String, Object>> options = new ArrayList<>();
        List<T> indexed = new ArrayList<>();
        for (T entity : optionList) {
            Map<String, Object> entry = new LinkedHashMap<>();
            if (entity instanceof Card c) {
                entry.putAll(serializeCard(c));
            } else if (entity instanceof Player pl) {
                entry.put("id", "P" + pl.getId());
                entry.put("name", pl.getName());
                entry.put("type", "Player");
            } else {
                // Unknown entity type — fall back to default
                return isOptional ? null : Iterables.getFirst(optionList, null);
            }
            options.add(entry);
            indexed.add(entity);
        }
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("cards", options);
        data.put("prompt", title != null ? title : "Choisir");
        data.put("optional", isOptional);
        data.put("destination", "HAND"); // unused but required by modal
        session.publishDecision("CHOOSE_CARD", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(5, TimeUnit.MINUTES);
        if (response == null) return isOptional ? null : indexed.get(0);
        Object idObj = response.get("cardId");
        if (idObj instanceof Number id) {
            int idInt = id.intValue();
            for (T entity : indexed) {
                if (entity instanceof Card c && c.getId() == idInt) return entity;
            }
        } else if (idObj instanceof String sid && sid.startsWith("P")) {
            try {
                int pid = Integer.parseInt(sid.substring(1));
                for (T entity : indexed) {
                    if (entity instanceof Player pl && pl.getId() == pid) return entity;
                }
            } catch (NumberFormatException ignored) {}
        }
        return isOptional ? null : indexed.get(0);
    }

    /** Interactive card picker: publishes CHOOSE_CARD and waits for player response. */
    private CardCollectionView pickCardsInteractive(CardCollectionView sourceList,
                                                     String title, int min, int max, boolean isOptional) {
        List<Map<String, Object>> cards = new ArrayList<>();
        List<Card> indexed = new ArrayList<>();
        for (Card c : sourceList) {
            cards.add(serializeCard(c));
            indexed.add(c);
        }
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("cards", cards);
        data.put("prompt", title != null ? title : "Choisir une carte");
        data.put("optional", isOptional || min == 0);
        data.put("min", min);
        data.put("max", max > 1 ? max : 1);
        data.put("destination", "HAND");
        // Multi-select mode when max > 1
        if (max > 1) data.put("multiSelect", true);
        session.publishDecision("CHOOSE_CARD", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(5, TimeUnit.MINUTES);
        if (response == null) return isOptional ? new CardCollection() : takeFirst(sourceList, min);
        // Multi-select response: { cardIds: [id1, id2, ...] }
        Object idsObj = response.get("cardIds");
        if (idsObj instanceof List<?> idList) {
            CardCollection result = new CardCollection();
            for (Object idObj : idList) {
                if (idObj instanceof Number) {
                    int id = ((Number) idObj).intValue();
                    for (Card c : indexed) { if (c.getId() == id) { result.add(c); break; } }
                }
            }
            if (!result.isEmpty()) return result;
        }
        // Single-select response: { cardId: id }
        Object idObj = response.get("cardId");
        if (idObj instanceof Number) {
            int id = ((Number) idObj).intValue();
            for (Card c : indexed) { if (c.getId() == id) return new CardCollection(Collections.singletonList(c)); }
        }
        return isOptional ? new CardCollection() : takeFirst(sourceList, min);
    }

    @Override
    public <T extends GameEntity> List<T> chooseEntitiesForEffect(FCollectionView<T> optionList, int min, int max,
                                                                   DelayedReveal delayedReveal, SpellAbility sa,
                                                                   String title, Player relatedPlayer,
                                                                   Map<String, Object> params) {
        if (delayedReveal != null) reveal(delayedReveal);
        if (optionList == null || optionList.isEmpty()) return new ArrayList<>();
        boolean isOptional = min <= 0;

        List<Map<String, Object>> cards = new ArrayList<>();
        List<T> indexed = new ArrayList<>();
        for (T entity : optionList) {
            if (entity instanceof Card c) {
                cards.add(serializeCard(c));
                indexed.add(entity);
            }
        }
        if (cards.isEmpty()) return new ArrayList<>();

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("cards", cards);
        data.put("prompt", title != null ? title : "Choisir");
        data.put("optional", isOptional);
        data.put("min", min);
        data.put("max", max);
        data.put("destination", "HAND");
        session.publishDecision("CHOOSE_CARD", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(5, TimeUnit.MINUTES);
        if (response == null) return isOptional ? new ArrayList<>() : new ArrayList<>(List.of(indexed.get(0)));

        Object idObj = response.get("cardId");
        if (idObj == null) return isOptional ? new ArrayList<>() : new ArrayList<>(List.of(indexed.get(0)));
        long chosenId = ((Number) idObj).longValue();
        for (T entity : indexed) {
            if (entity instanceof Card c && c.getId() == chosenId) return new ArrayList<>(List.of(entity));
        }
        return isOptional ? new ArrayList<>() : new ArrayList<>(List.of(indexed.get(0)));
    }

    @Override
    public List<SpellAbility> chooseSpellAbilitiesForEffect(List<SpellAbility> spells, SpellAbility sa,
                                                            String title, int num, Map<String, Object> params) {
        return spells.subList(0, Math.min(num, spells.size()));
    }

    @Override
    public SpellAbility chooseSingleSpellForEffect(List<SpellAbility> spells, SpellAbility sa,
                                                   String title, Map<String, Object> params) {
        return Iterables.getFirst(spells, null);
    }

    @Override
    public boolean confirmAction(SpellAbility sa, PlayerActionConfirmMode mode, String message,
                                 List<String> options, Card cardToShow, Map<String, Object> params) {
        // mode == null: ask player only when there's a meaningful yes/no question (e.g. Ponder shuffle)
        if (mode == null) {
            if (message == null || message.isBlank()) return true;
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("prompt", message);
            if (cardToShow != null) data.put("card", cardToShow.getName());
            session.publishDecision("CONFIRM_ACTION", playerIndex, data);
            Map<String, Object> response = session.awaitDecision(5, TimeUnit.MINUTES);
            if (response == null) return false;
            Object choice = response.get("choice");
            return "yes".equals(choice) || "true".equals(String.valueOf(choice));
        }
        switch (mode) {
            case OptionalChoose:
            case Tribute:
            case ChangeZoneGeneral:
            case ChangeZoneToAltDestination:
                // Ask player
                break;
            default:
                return true;
        }
        Map<String, Object> data = new LinkedHashMap<>();
        // For commander zone replacement, build a clear short prompt
        String prompt = message;
        if (mode == PlayerActionConfirmMode.ChangeZoneToAltDestination) {
            if (cardToShow != null) {
                prompt = cardToShow.getName() + " est allé(e) dans une autre zone — remettre en zone de commandement ?";
            } else {
                prompt = "Commandant changé de zone — remettre en zone de commandement ?";
            }
        }
        data.put("prompt", prompt != null ? prompt : "Confirmer ?");
        if (cardToShow != null) data.put("card", cardToShow.getName());
        data.put("options", options != null ? options : List.of("Oui", "Non"));
        session.publishDecision("CONFIRM_ACTION", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(5, TimeUnit.MINUTES);
        if (response == null) return false; // safe default: don't do the action
        Object choice = response.get("choice");
        return "yes".equals(choice) || "true".equals(String.valueOf(choice));
    }

    @Override
    public boolean confirmBidAction(SpellAbility sa, PlayerActionConfirmMode bidlife, String string,
                                    int bid, Player winner) { return false; }

    @Override
    public boolean confirmReplacementEffect(ReplacementEffect replacementEffect, SpellAbility effectSA,
                                            GameEntity affected, String question) {
        // Mandatory replacement effects (e.g. "enters tapped") auto-confirm — no player choice
        if (replacementEffect == null || !replacementEffect.hasParam("Optional")) return true;
        if (question == null || question.isBlank()) return true;
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("prompt", question);
        if (affected instanceof Card c) data.put("card", c.getName());
        session.publishDecision("CONFIRM_ACTION", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(5, TimeUnit.MINUTES);
        if (response == null) return true;
        Object choice = response.get("choice");
        return !"no".equals(choice) && !"false".equals(String.valueOf(choice));
    }

    @Override
    public boolean confirmStaticApplication(Card hostCard, PlayerActionConfirmMode mode,
                                            String message, String logic) { return true; }

    @Override
    public boolean confirmTrigger(WrappedAbility wrapper) {
        SpellAbility sa = wrapper.getWrappedAbility();
        Card host = sa != null ? sa.getHostCard() : wrapper.getHostCard();
        // Ask the player only when the trigger has a non-zero cost (e.g. Inti's discard)
        Cost cost = sa != null ? sa.getPayCosts() : null;
        boolean hasCost = cost != null && !cost.isOnlyManaCost();
        if (!hasCost) return true;
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("card", host != null ? host.getName() : "?");
        data.put("description", wrapper.getDescription());
        data.put("cost", cost.toString());
        data.put("prompt", "Payer " + cost + " pour : " + wrapper.getDescription() + " ?");
        data.put("optional", true);
        session.publishDecision("CONFIRM_TRIGGER", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(5, TimeUnit.MINUTES);
        if (response == null) return true;
        Object choice = response.get("choice");
        return !"no".equals(choice) && !"false".equals(String.valueOf(choice));
    }

    @Override
    public List<Card> exertAttackers(List<Card> attackers) {
        if (attackers == null || attackers.isEmpty()) return new ArrayList<>();
        CardCollectionView picked = pickCardsInteractive(
                new CardCollection(attackers), "Exerter des attaquants (optionnel)", 0, attackers.size(), true);
        return picked == null ? new ArrayList<>() : new ArrayList<>(picked);
    }

    @Override
    public List<Card> enlistAttackers(List<Card> attackers) {
        if (attackers == null || attackers.isEmpty()) return new ArrayList<>();
        CardCollectionView picked = pickCardsInteractive(
                new CardCollection(attackers), "Enrôler des attaquants (optionnel)", 0, attackers.size(), true);
        return picked == null ? new ArrayList<>() : new ArrayList<>(picked);
    }

    @Override
    public CardCollection orderBlockers(Card attacker, CardCollection blockers) { return blockers; }

    @Override
    public CardCollection orderBlocker(Card attacker, Card blocker, CardCollection oldBlockers) {
        CardCollection all = new CardCollection(oldBlockers);
        all.add(blocker);
        return all;
    }

    @Override
    public CardCollection orderAttackers(Card blocker, CardCollection attackers) { return attackers; }

    @Override
    public void reveal(CardCollectionView cards, ZoneType zone, Player owner, String messagePrefix, boolean addMsgSuffix) {
        if (cards == null || cards.isEmpty()) return;
        List<Map<String, Object>> cardList = new ArrayList<>();
        for (Card c : cards) cardList.add(serializeCard(c));
        Map<String, Object> data = new LinkedHashMap<>();
        String title = (messagePrefix != null && !messagePrefix.isEmpty()) ? messagePrefix : "Cartes révélées";
        data.put("prompt", title + " (" + cards.size() + " carte" + (cards.size() > 1 ? "s" : "") + ")");
        data.put("cards", cardList);
        session.publishDecision("REVEAL_CARDS", playerIndex, data);
        try { session.awaitDecision(10, TimeUnit.MINUTES); } catch (Exception ignored) {}
    }

    @Override
    public void reveal(List<CardView> cards, ZoneType zone, PlayerView owner, String messagePrefix, boolean addMsgSuffix) {}

    @Override
    public void notifyOfValue(SpellAbility saSource, GameObject relatedTarget, String value) {}

    @Override
    public ImmutablePair<CardCollection, CardCollection> arrangeForScry(CardCollection topN) {
        return arrangeCards("ARRANGE_SCRY", topN, "TOP", "BOTTOM");
    }

    @Override
    public ImmutablePair<CardCollection, CardCollection> arrangeForSurveil(CardCollection topN) {
        return arrangeCards("ARRANGE_SURVEIL", topN, "TOP", "GRAVE");
    }

    /** Shared helper for scry/surveil: publish decision, wait, return (left=top/keep, right=bottom/grave). */
    private ImmutablePair<CardCollection, CardCollection> arrangeCards(String decisionType,
            CardCollection topN, String keepZone, String discardZone) {
        List<Map<String, Object>> cards = new ArrayList<>();
        List<Card> indexed = new ArrayList<>(topN);
        for (Card c : indexed) {
            cards.add(serializeCard(c));
        }
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("cards", cards);
        data.put("keepZone", keepZone);
        data.put("discardZone", discardZone);
        session.publishDecision(decisionType, playerIndex, data);
        Map<String, Object> resp = session.awaitDecision(5, TimeUnit.MINUTES);

        CardCollection toKeep = new CardCollection();
        CardCollection toDiscard = new CardCollection();
        if (resp != null) {
            Object decisionsObj = resp.get("decisions");
            if (decisionsObj instanceof List<?> decisions) {
                // Build lookup by card id
                Map<Long, Card> byId = new LinkedHashMap<>();
                for (Card c : indexed) byId.put((long) c.getId(), c);
                for (Object item : decisions) {
                    if (item instanceof Map<?,?> d) {
                        if (!(d.get("cardId") instanceof Number)) continue;
                        long id = ((Number) d.get("cardId")).longValue();
                        String zone = String.valueOf(d.get("zone"));
                        Card c = byId.get(id);
                        if (c == null) continue;
                        if (discardZone.equals(zone)) toDiscard.add(c);
                        else toKeep.add(c);
                    }
                }
                // Any card not in response → default keep
                for (Card c : indexed) {
                    if (!toKeep.contains(c) && !toDiscard.contains(c)) toKeep.add(c);
                }
            }
        }
        if (toKeep.isEmpty() && toDiscard.isEmpty()) {
            // Timed out → default keep all
            return ImmutablePair.of(topN, null);
        }
        return ImmutablePair.of(toKeep.isEmpty() ? null : toKeep,
                                toDiscard.isEmpty() ? null : toDiscard);
    }

    @Override
    public boolean willPutCardOnTop(Card c) { return true; }

    @Override
    public CardCollectionView orderMoveToZoneList(CardCollectionView cards, ZoneType destinationZone,
                                                   SpellAbility source) {
        System.err.println("[API] orderMoveToZoneList: zone=" + destinationZone + " cards=" + cards.size()
                + " source=" + (source != null && source.getHostCard() != null ? source.getHostCard().getName() : "null"));
        // Only ask for library order (Ponder, Brainstorm, etc.) — other zones auto-order
        if (cards.size() <= 1 || destinationZone != ZoneType.Library) return cards;

        List<Map<String, Object>> cardList = new ArrayList<>();
        for (Card c : cards) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", c.getId());
            m.put("name", c.getName());
            cardList.add(m);
        }
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("cards", cardList);
        data.put("prompt", "Arrange les cartes de haut en bas (gauche = dessus de la bibliothèque)");
        data.put("spell", source != null && source.getHostCard() != null ? source.getHostCard().getName() : "");
        session.publishDecision("ORDER_ZONE", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(5, TimeUnit.MINUTES);
        if (response == null) return cards;

        Object orderedRaw = response.get("order");
        if (!(orderedRaw instanceof List)) return cards;

        // Build map id→card
        Map<Integer, Card> byId = new LinkedHashMap<>();
        for (Card c : cards) byId.put(c.getId(), c);

        // Frontend sends display order [top, …, bottom]; engine puts each card at pos 0
        // so we must reverse: last element of returned list ends up on top
        List<?> displayOrder = (List<?>) orderedRaw;
        CardCollection ordered = new CardCollection();
        for (int i = displayOrder.size() - 1; i >= 0; i--) {
            try {
                int id = Integer.parseInt(displayOrder.get(i).toString());
                Card c = byId.remove(id);
                if (c != null) ordered.add(c);
            } catch (NumberFormatException ignored) {}
        }
        // Append any card not included in response (safety)
        for (Card c : byId.values()) ordered.add(c);
        return ordered;
    }

    @Override
    public CardCollectionView chooseCardsToDiscardFrom(Player playerDiscard, SpellAbility sa,
                                                       CardCollection validCards, int min, int max) {
        if (validCards == null || validCards.isEmpty()) return new CardCollection();
        String prompt = "Défausser " + (min == max ? min : min + "–" + max) + " carte(s)";
        return pickCardsInteractive(validCards, prompt, min, max, min == 0);
    }

    @Override
    public CardCollectionView chooseCardsToDiscardUnlessType(int min, CardCollectionView hand,
                                                             String param, SpellAbility sa) {
        if (hand == null || hand.isEmpty()) return new CardCollection();
        return pickCardsInteractive(hand, "Défausser " + min + " carte(s) (sauf " + param + ")", min, min, false);
    }

    @Override
    public CardCollection chooseCardsToDiscardToMaximumHandSize(int numDiscard) {
        CardCollectionView hand = player.getCardsIn(ZoneType.Hand);
        if (hand.isEmpty()) return new CardCollection();
        return (CardCollection) pickCardsInteractive(hand,
                "Défausser jusqu'à " + numDiscard + " carte(s) pour respecter la limite de main", numDiscard, numDiscard, false);
    }

    @Override
    public CardCollectionView chooseCardsToDelve(int genericAmount, CardCollection grave) {
        if (grave == null || grave.isEmpty() || genericAmount <= 0) return CardCollection.EMPTY;
        String prompt = "Delve — Exiler jusqu'à " + genericAmount + " carte(s) du cimetière (réduit le coût générique)";
        CardCollectionView chosen = pickCardsInteractive(grave, prompt, 0, genericAmount, true);
        return chosen == null ? CardCollection.EMPTY : new CardCollection(chosen);
    }

    @Override
    public Map<Card, ManaCostShard> chooseCardsForConvokeOrImprovise(SpellAbility sa, ManaCost manaCost,
                                                                     CardCollectionView untappedCards, boolean artifacts,
                                                                     boolean creatures, Integer maxReduction) {
        return new HashMap<>();
    }

    @Override
    public List<Card> chooseCardsForSplice(SpellAbility sa, List<Card> cards) { return new ArrayList<>(); }

    @Override
    public CardCollectionView chooseCardsToRevealFromHand(int min, int max, CardCollectionView valid) {
        return takeFirst(valid, min);
    }

    @Override
    public List<SpellAbility> chooseSaToActivateFromOpeningHand(List<SpellAbility> usableFromOpeningHand) {
        return usableFromOpeningHand;
    }

    @Override
    public Player chooseStartingPlayer(boolean isFirstGame) {
        // Find the opponent
        Player opponent = null;
        for (Player p : getGame().getPlayers()) {
            if (p != player) { opponent = p; break; }
        }
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("isFirstGame", isFirstGame);
        data.put("chooserName", player.getName());
        data.put("opponentName", opponent != null ? opponent.getName() : "AI");
        session.publishDecision("CHOOSE_STARTING_PLAYER", playerIndex, data);
        Map<String, Object> resp = session.awaitDecision(5, TimeUnit.MINUTES);
        boolean goFirst = true;
        if (resp != null && resp.get("goFirst") instanceof Boolean b) goFirst = b;
        return goFirst ? player : (opponent != null ? opponent : player);
    }

    @Override
    public void notifyTossResult(String tossWinnerName, String firstPlayerName, boolean isFirstGame) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("isFirstGame", isFirstGame);
        data.put("tossWinnerName", tossWinnerName);
        data.put("firstPlayerName", firstPlayerName);
        session.publishDecision("TOSS_RESULT", playerIndex, data);
        session.awaitDecision(2, TimeUnit.MINUTES);
    }

    @Override
    public PlayerZone chooseStartingHand(List<PlayerZone> zones) {
        return zones.isEmpty() ? null : zones.get(0);
    }

    @Override
    public Mana chooseManaFromPool(List<Mana> manaChoices) { return Iterables.getFirst(manaChoices, null); }

    @Override
    public String chooseSomeType(String kindOfType, SpellAbility sa, Collection<String> validTypes, boolean isOptional) {
        if (validTypes == null || validTypes.isEmpty()) return null;
        if (validTypes.size() == 1) return validTypes.iterator().next();
        List<String> types = new ArrayList<>(validTypes);
        String prompt = kindOfType != null ? "Nommer un " + kindOfType : "Nommer un type";
        String cardName = sa != null && sa.getHostCard() != null ? sa.getHostCard().getName() : null;
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("prompt", prompt);
        data.put("types", types);
        data.put("optional", isOptional);
        if (cardName != null) data.put("card", cardName);
        session.publishDecision("CHOOSE_TYPE", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(5, TimeUnit.MINUTES);
        if (response == null) return isOptional ? null : types.get(0);
        Object v = response.get("type");
        String chosen = v instanceof String s ? s : null;
        return (chosen != null && types.contains(chosen)) ? chosen : (isOptional ? null : types.get(0));
    }

    @Override
    public String chooseSector(Card assignee, String ai, List<String> sectors) {
        return Iterables.getFirst(sectors, "Alpha");
    }

    @Override
    public List<Card> chooseContraptionsToCrank(List<Card> contraptions) { return contraptions; }

    @Override
    public int chooseSprocket(Card assignee, boolean forceDifferent) {
        return forceDifferent && assignee.getSprocket() == 1 ? 2 : 1;
    }

    @Override
    public PlanarDice choosePDRollToIgnore(List<PlanarDice> rolls) {
        return Aggregates.random(rolls);
    }

    @Override
    public Integer chooseRollToIgnore(List<Integer> rolls) { return Aggregates.random(rolls); }

    @Override
    public List<Integer> chooseDiceToReroll(List<Integer> rolls) { return new ArrayList<>(); }

    @Override
    public Integer chooseRollToModify(List<Integer> rolls) { return Aggregates.random(rolls); }

    @Override
    public RollDiceEffect.DieRollResult chooseRollToSwap(List<RollDiceEffect.DieRollResult> rolls) {
        return Aggregates.random(rolls);
    }

    @Override
    public String chooseRollSwapValue(List<String> swapChoices, Integer currentResult, int power, int toughness) {
        return Aggregates.random(swapChoices);
    }

    @Override
    public Object vote(SpellAbility sa, String prompt, List<Object> options,
                       ListMultimap<Object, Player> votes, Player forPlayer, boolean optional) {
        if (options == null || options.isEmpty()) return null;
        if (options.size() == 1) return options.get(0);
        List<String> labels = new ArrayList<>();
        for (Object o : options) labels.add(o.toString());
        String cardName = sa != null && sa.getHostCard() != null ? sa.getHostCard().getName() : null;
        String chosen = chooseOption(prompt != null ? prompt : "Voter", labels, optional, cardName);
        for (int i = 0; i < labels.size(); i++) {
            if (labels.get(i).equals(chosen)) return options.get(i);
        }
        return optional ? null : options.get(0);
    }

    @Override
    public CardCollectionView tuckCardsViaMulligan(Player mulliganingPlayer, int cardsToReturn) {
        if (cardsToReturn <= 0) return new CardCollection();

        List<Card> handList = new ArrayList<>(mulliganingPlayer.getCardsIn(ZoneType.Hand));
        List<Map<String, Object>> hand = new ArrayList<>();
        for (Card c : handList) {
            Map<String, Object> card = new LinkedHashMap<>();
            card.put("id", c.getId());
            card.put("name", c.getName());
            try { card.put("manaCost", c.getManaCost().toString()); } catch (Exception ignored) {}
            hand.add(card);
        }

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("hand", hand);
        data.put("cardsToReturn", cardsToReturn);
        data.put("prompt", "Choisir " + cardsToReturn + " carte(s) à mettre en dessous de la bibliothèque");
        session.publishDecision("MULLIGAN_TUCK", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(10, TimeUnit.MINUTES);

        CardCollection result = new CardCollection();
        if (response != null) {
            Object idsRaw = response.get("cardIds");
            if (idsRaw instanceof List<?> ids) {
                Set<Integer> chosen = new HashSet<>();
                for (Object id : ids) {
                    try { chosen.add(Integer.parseInt(id.toString())); } catch (NumberFormatException ignored) {}
                }
                for (Card c : handList) {
                    if (chosen.contains(c.getId()) && result.size() < cardsToReturn) result.add(c);
                }
            }
        }
        // Fill remaining with first cards if player didn't select enough
        for (Card c : handList) {
            if (result.size() >= cardsToReturn) break;
            if (!result.contains(c)) result.add(c);
        }
        return result;
    }

    @Override
    public boolean confirmMulliganScry(Player p) { return false; }

    @Override
    public List<AbilitySub> chooseModeForAbility(SpellAbility sa, List<AbilitySub> possible,
                                                  int min, int num, boolean allowRepeat) {
        if (possible.isEmpty()) return new ArrayList<>();
        List<Map<String, Object>> modes = new ArrayList<>();
        for (int i = 0; i < possible.size(); i++) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("index", i);
            try { m.put("description", possible.get(i).getDescription()); }
            catch (Exception e) { m.put("description", "Mode " + (i+1)); }
            modes.add(m);
        }
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("modes", modes);
        data.put("min", min);
        data.put("num", num);
        data.put("allowRepeat", allowRepeat);
        data.put("card", sa.getHostCard() != null ? sa.getHostCard().getName() : "");
        session.publishDecision("CHOOSE_MODE", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(5, TimeUnit.MINUTES);
        List<AbilitySub> chosen;
        if (response == null) {
            chosen = new ArrayList<>(possible.subList(0, Math.min(num, possible.size())));
        } else {
            Object raw = response.get("indices");
            chosen = new ArrayList<>();
            if (raw instanceof List<?> idxList) {
                for (Object o : idxList) {
                    int i = ((Number) o).intValue();
                    if (i >= 0 && i < possible.size()) chosen.add(possible.get(i));
                }
            }
            if (chosen.isEmpty() && min > 0) {
                // min=0 means optional (e.g. Hullbreaker Horror) — empty is valid
                chosen = new ArrayList<>(possible.subList(0, Math.min(num, possible.size())));
            }
        }
        // For each chosen mode that requires targeting, gather targets now.
        // CharmEffect chains these as sub-abilities and never calls chooseTargetsFor on them.
        // When allowRepeat=true the same AbilitySub object can appear multiple times in chosen;
        // we clone each entry independently so chooseTargetsFor doesn't overwrite earlier targets.
        for (int i = 0; i < chosen.size(); i++) {
            AbilitySub sub = chosen.get(i);
            if (sub.usesTargeting()) {
                AbilitySub clone = (AbilitySub) sub.copy(sa.getActivatingPlayer());
                clone.setActivatingPlayer(sa.getActivatingPlayer());
                chooseTargetsFor(clone);
                chosen.set(i, clone);
            }
        }
        return chosen;
    }

    @Override
    public int chooseNumberForCostReduction(SpellAbility sa, int min, int max) { return max; }

    @Override
    public int chooseNumberForKeywordCost(SpellAbility sa, Cost cost, KeywordInterface keyword,
                                          String prompt, int max) { return 0; }

    @Override
    public int chooseNumber(SpellAbility sa, String title, int min, int max) {
        if (min >= max) return min;
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("prompt", title != null ? title : "Choisir un nombre");
        data.put("min", min);
        data.put("max", max);
        data.put("card", sa != null && sa.getHostCard() != null ? sa.getHostCard().getName() : "");
        session.publishDecision("CHOOSE_NUMBER", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(5, TimeUnit.MINUTES);
        if (response == null) return min;
        Object val = response.get("number");
        if (val instanceof Number) return Math.max(min, Math.min(max, ((Number) val).intValue()));
        return min;
    }

    @Override
    public int chooseNumber(SpellAbility sa, String title, List<Integer> values, Player relatedPlayer) {
        if (values == null || values.isEmpty()) return 0;
        if (values.size() == 1) return values.get(0);
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("prompt", title != null ? title : "Choisir un nombre");
        data.put("values", values);
        data.put("card", sa != null && sa.getHostCard() != null ? sa.getHostCard().getName() : "");
        session.publishDecision("CHOOSE_NUMBER", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(5, TimeUnit.MINUTES);
        if (response == null) return values.get(0);
        Object val = response.get("number");
        if (val instanceof Number) {
            int n = ((Number) val).intValue();
            return values.contains(n) ? n : values.get(0);
        }
        return values.get(0);
    }

    @Override
    public boolean chooseBinary(SpellAbility sa, String question, BinaryChoiceType kindOfChoice,
                                Boolean defaultChoice) {
        if (question == null || question.isBlank()) return defaultChoice != null ? defaultChoice : true;
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("prompt", question);
        data.put("kindOfChoice", kindOfChoice != null ? kindOfChoice.name() : "YesOrNo");
        if (sa != null && sa.getHostCard() != null) data.put("card", sa.getHostCard().getName());
        session.publishDecision("CHOOSE_BINARY", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(5, TimeUnit.MINUTES);
        if (response == null) return defaultChoice != null ? defaultChoice : false;
        Object v = response.get("choice");
        return "yes".equals(v) || "true".equals(String.valueOf(v));
    }

    @Override
    public boolean chooseFlipResult(SpellAbility sa, Player flipper, boolean[] results, boolean call) {
        return MyRandom.getRandom().nextBoolean();
    }

    @Override
    public byte chooseColor(String message, SpellAbility sa, ColorSet colors) {
        byte pending = pendingManaColorMask;
        if (pending != 0) {
            // Use requested color if it's in the available set; keep mask for subsequent calls (e.g. Amount$ 2)
            for (MagicColor.Color c : colors) {
                if (c.getColorMask() == pending) return pending;
            }
        }
        return Iterables.getFirst(colors, MagicColor.Color.WHITE).getColorMask();
    }

    @Override
    public byte chooseColorAllowColorless(String message, Card c, ColorSet colors) {
        byte pending = pendingManaColorMask;
        if (pending != 0) {
            // Keep mask for subsequent calls within the same activation
            for (MagicColor.Color col : colors) {
                if (col.getColorMask() == pending) return pending;
            }
        }
        return Iterables.getFirst(colors, MagicColor.Color.COLORLESS).getColorMask();
    }

    @Override
    public ColorSet chooseColors(String message, SpellAbility sa, int min, int max, ColorSet options) {
        return options;
    }

    @Override
    public ICardFace chooseSingleCardFace(SpellAbility sa, String message, Predicate<ICardFace> cpp, String name) {
        return null;
    }

    @Override
    public ICardFace chooseSingleCardFace(SpellAbility sa, List<ICardFace> faces, String message) {
        return Iterables.getFirst(faces, null);
    }

    @Override
    public CardState chooseSingleCardState(SpellAbility sa, List<CardState> states, String message,
                                           Map<String, Object> params) {
        return Iterables.getFirst(states, null);
    }

    @Override
    public boolean chooseCardsPile(SpellAbility sa, CardCollectionView pile1, CardCollectionView pile2,
                                   String faceUp) {
        return true;
    }

    @Override
    public CounterType chooseCounterType(List<CounterType> options, SpellAbility sa, String prompt,
                                         Map<String, Object> params) {
        if (options == null || options.isEmpty()) return null;
        if (options.size() == 1) return options.get(0);
        List<String> labels = new ArrayList<>();
        for (CounterType ct : options) labels.add(ct.getName());
        String cardName = sa != null && sa.getHostCard() != null ? sa.getHostCard().getName() : null;
        String chosen = chooseOption(prompt != null ? prompt : "Choisir un type de marqueur", labels, false, cardName);
        for (int i = 0; i < labels.size(); i++) {
            if (labels.get(i).equals(chosen)) return options.get(i);
        }
        return options.get(0);
    }

    @Override
    public String chooseKeywordForPump(List<String> options, SpellAbility sa, String prompt, Card tgtCard) {
        if (options == null || options.isEmpty()) return null;
        if (options.size() == 1) return options.get(0);
        String cardName = sa != null && sa.getHostCard() != null ? sa.getHostCard().getName() : null;
        String chosen = chooseOption(prompt != null ? prompt : "Choisir un mot-clé", options, false, cardName);
        return chosen != null ? chosen : options.get(0);
    }

    @Override
    public boolean confirmPayment(CostPart costPart, String string, SpellAbility sa) { return true; }

    @Override
    public ReplacementEffect chooseSingleReplacementEffect(List<ReplacementEffect> possibleReplacers) {
        return Iterables.getFirst(possibleReplacers, null);
    }

    @Override
    public StaticAbility chooseSingleStaticAbility(String prompt, List<StaticAbility> possibleStatics) {
        return Iterables.getFirst(possibleStatics, null);
    }

    @Override
    public String chooseProtectionType(String string, SpellAbility sa, List<String> choices) {
        if (choices == null || choices.isEmpty()) return null;
        if (choices.size() == 1) return choices.get(0);
        String cardName = sa != null && sa.getHostCard() != null ? sa.getHostCard().getName() : null;
        String chosen = chooseOption(string != null ? string : "Choisir une protection", choices, false, cardName);
        return chosen != null ? chosen : choices.get(0);
    }

    @Override
    public void revealAnte(String message, Multimap<Player, PaperCard> removedAnteCards) {}

    @Override
    public void revealAISkipCards(String message, Map<Player, Map<DeckSection, List<? extends PaperCard>>> deckCards) {}

    @Override
    public void revealUnsupported(Map<Player, List<PaperCard>> unsupported) {}

    @Override
    public void resetAtEndOfTurn() {}

    @Override
    public List<OptionalCostValue> chooseOptionalCosts(SpellAbility chosen, List<OptionalCostValue> optionalCostValues) {
        return new ArrayList<>();
    }

    @Override
    public List<CostPart> orderCosts(List<CostPart> costs) { return costs; }

    @Override
    public boolean payCostToPreventEffect(Cost cost, SpellAbility sa, boolean alreadyPaid,
                                          FCollectionView<Player> allPayers) {
        if (alreadyPaid) return false;
        boolean isSwitched = sa.hasParam("UnlessSwitched");
        String costDesc = cost.toString().trim();
        Map<String, Object> data = new LinkedHashMap<>();
        String prompt = isSwitched
                ? "Voulez-vous payer " + costDesc + " pour déclencher l'effet ?"
                : "Voulez-vous payer " + costDesc + " pour empêcher l'effet ?";
        data.put("prompt", prompt);
        data.put("costDesc", costDesc);
        data.put("card", sa.getHostCard().getName());
        session.publishDecision("CONFIRM_COST", playerIndex, data);
        Map<String, Object> resp = session.awaitDecision(5, TimeUnit.MINUTES);
        if (resp == null) return false;
        Object v = resp.get("confirmed");
        boolean confirmed = v instanceof Boolean ? (Boolean) v : Boolean.parseBoolean(String.valueOf(v));
        if (!confirmed) return false;
        // Use Forge's CostPayment to actually pay the cost (handles energy, life, mana, etc.)
        // Pass null callbacks — interactive overrides not needed here (user already confirmed above)
        try {
            final CostPayment pay = new CostPayment(cost, sa);
            return pay.payComputerCosts(new ApiCostDecision(player, sa, null, null));
        } catch (Exception e) {
            System.err.println("[API] payCostToPreventEffect error: " + e);
        }
        return false;
    }

    @Override
    public boolean payCostDuringRoll(Cost cost, SpellAbility sa, FCollectionView<Player> allPayers) { return false; }

    @Override
    public boolean payCombatCost(Card card, Cost cost, SpellAbility sa, String prompt) { return false; }

    @Override
    public String chooseCardName(SpellAbility sa, Predicate<ICardFace> cpp, String valid, String message) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("prompt", message != null ? message : "Nommer une carte");
        if (sa != null && sa.getHostCard() != null) data.put("card", sa.getHostCard().getName());
        session.publishDecision("CHOOSE_CARD_NAME", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(10, TimeUnit.MINUTES);
        if (response == null) return "";
        Object v = response.get("cardName");
        return v instanceof String s ? s : "";
    }

    @Override
    public String chooseCardName(SpellAbility sa, List<ICardFace> faces, String message) {
        if (faces == null || faces.isEmpty()) return "";
        if (faces.size() == 1) return faces.get(0).getName();
        List<String> names = new ArrayList<>();
        for (ICardFace f : faces) names.add(f.getName());
        String cardName = sa != null && sa.getHostCard() != null ? sa.getHostCard().getName() : null;
        String chosen = chooseOption(message != null ? message : "Nommer une carte", names, false, cardName);
        return chosen != null ? chosen : names.get(0);
    }

    @Override
    public Card chooseSingleCardForZoneChange(ZoneType destination, List<ZoneType> origin, SpellAbility sa,
                                              CardCollection fetchList, DelayedReveal delayedReveal,
                                              String selectPrompt, boolean isOptional, Player decider) {
        if (delayedReveal != null) reveal(delayedReveal);
        if (fetchList == null || fetchList.isEmpty()) return null;
        List<Map<String, Object>> cards = new ArrayList<>();
        for (Card c : fetchList) cards.add(serializeCard(c));
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("cards", cards);
        data.put("prompt", selectPrompt != null ? selectPrompt : "Choisir une carte");
        data.put("optional", isOptional);
        data.put("destination", destination != null ? destination.name() : "");
        session.publishDecision("CHOOSE_CARD", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(10, TimeUnit.MINUTES);
        if (response == null) return isOptional ? null : Iterables.getFirst(fetchList, null);
        Object idObj = response.get("cardId");
        if (idObj instanceof Number) {
            int id = ((Number) idObj).intValue();
            for (Card c : fetchList) { if (c.getId() == id) return c; }
        }
        return isOptional ? null : Iterables.getFirst(fetchList, null);
    }

    @Override
    public List<Card> chooseCardsForZoneChange(ZoneType destination, List<ZoneType> origin, SpellAbility sa,
                                               CardCollection fetchList, int min, int max,
                                               DelayedReveal delayedReveal, String selectPrompt, Player decider) {
        if (delayedReveal != null) reveal(delayedReveal);
        if (fetchList == null || fetchList.isEmpty()) return new ArrayList<>();
        String prompt = selectPrompt != null ? selectPrompt
                : "Choisir " + (min == max ? min : min + "–" + max) + " carte(s) pour " + destination.name();
        CardCollectionView picked = pickCardsInteractive(fetchList, prompt, min, Math.max(min, max), min == 0);
        return picked == null ? new ArrayList<>() : new ArrayList<>(picked);
    }

    @Override
    public void autoPassCancel() {}

    @Override
    public void awaitNextInput() {}

    @Override
    public void cancelAwaitNextInput() {}

    // ── Helpers ───────────────────────────────────────────────────────────────

    private CardCollectionView takeFirst(CardCollectionView source, int n) {
        if (source == null || source.isEmpty() || n == 0) return new CardCollection();
        int take = Math.min(n, source.size());
        return new CardCollection(source.subList(0, take));
    }

    /** Serialize a Card to a map for frontend display. */
    private Map<String, Object> serializeCard(Card c) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", c.getId());
        m.put("name", c.getName());
        try { m.put("manaCost", c.getManaCost().toString()); } catch (Exception ignored) {}
        try { m.put("type", c.getType().toString()); } catch (Exception ignored) {}
        m.put("zone", c.getZone() != null ? c.getZone().getZoneType().name() : "UNKNOWN");
        try { if (c.getOwner() != null) m.put("owner", c.getOwner().getName()); } catch (Exception ignored) {}
        return m;
    }

    /** Publish CHOOSE_OPTION and return the player's chosen string, or fallback. */
    private String chooseOption(String prompt, List<String> options, boolean optional, String cardName) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("prompt", prompt);
        data.put("options", options);
        data.put("optional", optional);
        if (cardName != null && !cardName.isEmpty()) data.put("card", cardName);
        session.publishDecision("CHOOSE_OPTION", playerIndex, data);
        Map<String, Object> response = session.awaitDecision(5, TimeUnit.MINUTES);
        if (response == null) return optional ? null : options.get(0);
        Object v = response.get("choice");
        String chosen = v instanceof String s ? s : null;
        return (chosen != null && options.contains(chosen)) ? chosen : (optional ? null : options.get(0));
    }
}
