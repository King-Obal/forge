package forge.api.game;

import forge.game.Game;
import forge.game.GameLogEntry;
import forge.game.card.Card;
import forge.game.combat.Combat;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.SpellAbilityStackInstance;
import forge.game.spellability.TargetChoices;
import forge.game.zone.ZoneType;

import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Represents a single interactive game session.
 * The game runs on a background thread; REST calls interact via CompletableFuture.
 */
public class GameSession {

    private final String id;
    private volatile Game game;
    private volatile Thread gameThread; // stored so it can be interrupted on cleanup
    // controllers registered once game starts (set via setController)
    private final Object[] controllers = new Object[2]; // PlayerControllerApi, stored as Object to avoid circular dependency

    // The pending decision (published by game thread, consumed by REST client)
    private volatile Map<String, Object> pendingDecision;
    private volatile CompletableFuture<Map<String, Object>> pendingFuture;

    private volatile boolean gameOver = false;
    private volatile String gameError = null;
    private volatile boolean debug = false;
    private volatile long lastActivity = System.currentTimeMillis();

    // Partner lock: card IDs of commanders that are permanently locked (Duel Commander rule)
    private final java.util.Set<Integer> lockedPartnerIds = Collections.synchronizedSet(new java.util.HashSet<>());

    // Snapshot of log lines added since last state fetch
    private final List<String> logBuffer = Collections.synchronizedList(new ArrayList<>());
    private volatile int logCursor = 0;

    public GameSession(String id) {
        this.id = id;
    }

    public String getId() { return id; }

    public boolean isDebug() { return debug; }
    public void setDebug(boolean debug) { this.debug = debug; }

    public void setGame(Game game) {
        this.game = game;
    }

    public Game getGame() { return game; }

    public void setController(int index, Object ctrl) {
        controllers[index] = ctrl;
    }

    public void setGameThread(Thread t) { this.gameThread = t; }

    /** Interrupt the game thread so it unblocks from any AI computation or sleep. */
    public void interruptGameThread() {
        Thread t = gameThread;
        if (t != null && t.isAlive()) t.interrupt();
    }

    public void setGameOver(boolean over) { this.gameOver = over; }
    public boolean isGameOver() { return gameOver; }

    public void setGameError(String err) { this.gameError = err; gameOver = true; }
    public String getGameError() { return gameError; }

    public java.util.Set<Integer> getLockedPartnerIds() { return lockedPartnerIds; }
    public void setLockedPartnerIds(java.util.Set<Integer> ids) { lockedPartnerIds.clear(); lockedPartnerIds.addAll(ids); }

    public long getLastActivity() { return lastActivity; }

    // ── Decision publish/await (called from game thread) ─────────────────────

    private long decisionSeq = 0;

    public synchronized void publishDecision(String type, int playerIndex, Object data) {
        lastActivity = System.currentTimeMillis();
        CompletableFuture<Map<String, Object>> future = new CompletableFuture<>();
        this.pendingFuture = future;   // set future BEFORE pendingDecision
        Map<String, Object> decision = new LinkedHashMap<>();
        decision.put("seq", ++decisionSeq);
        decision.put("type", type);
        decision.put("player", playerIndex);
        decision.put("data", data);
        this.pendingDecision = decision;
    }

    /** Blocks the game thread until the REST client posts a decision. Auto-passes on timeout. */
    public Map<String, Object> awaitDecision(long timeout, TimeUnit unit) {
        CompletableFuture<Map<String, Object>> future = this.pendingFuture;
        if (future == null) return null;
        try {
            Map<String, Object> result = future.get(timeout, unit);
            lastActivity = System.currentTimeMillis();
            return result;
        } catch (TimeoutException e) {
            return null; // auto-pass
        } catch (Exception e) {
            return null;
        } finally {
            pendingDecision = null;
        }
    }

    /** Called from REST thread when client posts a decision. Returns false if no pending decision. */
    public synchronized boolean receiveDecision(Map<String, Object> response) {
        CompletableFuture<Map<String, Object>> f = pendingFuture;
        if (f == null || f.isDone()) return false;
        pendingDecision = null;
        f.complete(response);
        lastActivity = System.currentTimeMillis();
        return true;
    }

    public Map<String, Object> getPendingDecision() { return pendingDecision; }

    // ── Game state serialization ──────────────────────────────────────────────

    public Map<String, Object> toStateMap() {
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("id", id);
        state.put("gameOver", gameOver);
        state.put("debug", debug);
        if (gameError != null) state.put("error", gameError);

        if (game == null) {
            state.put("phase", "LOADING");
            return state;
        }

        // Phase and turn
        try {
            PhaseType phase = game.getPhaseHandler().getPhase();
            state.put("phase", phase != null ? phase.name() : "UNKNOWN");
            state.put("turn", game.getPhaseHandler().getTurn());
            Player turnPlayer = game.getPhaseHandler().getPlayerTurn();
            state.put("activePlayer", turnPlayer != null ? turnPlayer.getName() : "");
            Player priorityPlayer = game.getPhaseHandler().getPriorityPlayer();
            state.put("priorityPlayer", priorityPlayer != null ? priorityPlayer.getName() : "");
        } catch (Exception e) {
            state.put("phase", "UNKNOWN");
        }

        // Players
        List<Map<String, Object>> players = new ArrayList<>();
        try {
            for (Player p : game.getPlayers()) {
                players.add(serializePlayer(p));
            }
        } catch (Exception ignored) {}
        state.put("players", players);

        // Stack
        List<Map<String, Object>> stack = new ArrayList<>();
        try {
            for (SpellAbilityStackInstance si : game.getStack()) {
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("card", si.getSourceCard() != null ? si.getSourceCard().getName() : "?");
                entry.put("cardId", si.getSourceCard() != null ? si.getSourceCard().getId() : -1);
                entry.put("description", si.toString());
                // Serialize targets for arrow rendering
                List<Map<String, Object>> targets = new ArrayList<>();
                try {
                    TargetChoices tc = si.getTargetChoices();
                    if (tc != null) {
                        for (Card c : tc.getTargetCards()) {
                            Map<String, Object> t = new LinkedHashMap<>();
                            t.put("kind", "card"); t.put("id", c.getId());
                            t.put("name", c.getName());
                            targets.add(t);
                        }
                        for (Player p : tc.getTargetPlayers()) {
                            Map<String, Object> t = new LinkedHashMap<>();
                            t.put("kind", "player"); t.put("id", "P" + p.getId());
                            t.put("name", p.getName());
                            targets.add(t);
                        }
                        for (SpellAbility tsa : tc.getTargetSpells()) {
                            if (tsa.getHostCard() != null) {
                                Map<String, Object> t = new LinkedHashMap<>();
                                t.put("kind", "spell"); t.put("id", tsa.getHostCard().getId());
                                t.put("name", tsa.getHostCard().getName());
                                targets.add(t);
                            }
                        }
                    }
                } catch (Exception ignored) {}
                entry.put("targets", targets);
                stack.add(entry);
            }
        } catch (Exception ignored) {}
        state.put("stack", stack);

        // Combat
        try {
            Combat combat = game.getPhaseHandler().getCombat();
            if (combat != null) {
                state.put("combat", serializeCombat(combat));
            }
        } catch (Exception ignored) {}

        // Pending decision
        state.put("pendingDecision", pendingDecision);

        // Winner
        try {
            if (game.isGameOver() && game.getOutcome() != null) {
                if (game.getOutcome().isDraw()) {
                    state.put("winner", "DRAW");
                } else if (game.getOutcome().getWinningLobbyPlayer() != null) {
                    state.put("winner", game.getOutcome().getWinningLobbyPlayer().getName());
                }
            }
        } catch (Exception ignored) {}

        // Recent log lines
        try {
            List<GameLogEntry> entries = game.getGameLog().getLogEntries(null);
            Collections.reverse(entries);
            List<String> lines = new ArrayList<>();
            for (GameLogEntry e : entries) lines.add(e.toString());
            // Return last 20
            int start = Math.max(0, lines.size() - 20);
            state.put("log", lines.subList(start, lines.size()));
        } catch (Exception ignored) {}

        return state;
    }

    private Map<String, Object> serializePlayer(Player p) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("id", p.getId());
        map.put("name", p.getName());
        map.put("life", p.getLife());
        map.put("poisonCounters", p.getPoisonCounters());
        map.put("librarySize", p.getCardsIn(ZoneType.Library).size());
        map.put("graveyardSize", p.getCardsIn(ZoneType.Graveyard).size());
        try { if (p.hasDelirium()) map.put("delirium", true); } catch (Exception ignored) {}

        // Hand
        List<Map<String, Object>> hand = new ArrayList<>();
        for (Card c : p.getCardsIn(ZoneType.Hand)) hand.add(serializeCard(c));
        map.put("hand", hand);

        // Battlefield
        List<Map<String, Object>> battlefield = new ArrayList<>();
        for (Card c : p.getCardsIn(ZoneType.Battlefield)) battlefield.add(serializeCard(c));
        map.put("battlefield", battlefield);

        // Graveyard
        List<Map<String, Object>> graveyard = new ArrayList<>();
        for (Card c : p.getCardsIn(ZoneType.Graveyard)) graveyard.add(serializeCard(c));
        map.put("graveyard", graveyard);

        // Exile
        List<Map<String, Object>> exile = new ArrayList<>();
        for (Card c : p.getCardsIn(ZoneType.Exile)) exile.add(serializeCard(c));
        map.put("exile", exile);

        // Command zone (exclude internal effect objects like "Commander Effect" and "The Ring")
        List<Map<String, Object>> command = new ArrayList<>();
        for (Card c : p.getCardsIn(ZoneType.Command)) {
            if (c instanceof forge.game.ability.effects.DetachedCardEffect) continue;
            if (c.getGamePieceType() == forge.card.GamePieceType.EFFECT) continue;
            Map<String, Object> cardMap = serializeCard(c);
            // Commander tax: +{2} for each previous cast from command zone
            int castCount = p.getCommanderCast(c);
            if (castCount > 0) {
                cardMap.put("commanderCastCount", castCount);
                cardMap.put("commanderTax", castCount * 2);
            }
            command.add(cardMap);
        }
        map.put("command", command);

        // Mana pool
        try {
            forge.game.mana.ManaPool pool = p.getManaPool();
            Map<String, Integer> manaPool = new LinkedHashMap<>();
            manaPool.put("W", pool.getAmountOfColor(forge.card.MagicColor.WHITE));
            manaPool.put("U", pool.getAmountOfColor(forge.card.MagicColor.BLUE));
            manaPool.put("B", pool.getAmountOfColor(forge.card.MagicColor.BLACK));
            manaPool.put("R", pool.getAmountOfColor(forge.card.MagicColor.RED));
            manaPool.put("G", pool.getAmountOfColor(forge.card.MagicColor.GREEN));
            manaPool.put("C", pool.getAmountOfColor(forge.card.MagicColor.COLORLESS));
            map.put("manaPool", manaPool);
        } catch (Exception ignored) {}

        return map;
    }

    private Map<String, Object> serializeCard(Card c) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("id", c.getId());
        map.put("name", c.getName());
        try { map.put("manaCost", c.getManaCost().toString()); } catch (Exception ignored) {}
        try { map.put("type", c.getType().toString()); } catch (Exception ignored) {}
        try { map.put("tapped", c.isTapped()); } catch (Exception ignored) {}
        try {
            if (c.isCreature()) {
                map.put("power", c.getNetPower());
                map.put("toughness", c.getNetToughness());
                map.put("damage", c.getDamage());
            }
        } catch (Exception ignored) {}
        // Counters
        try {
            Map<String, Integer> counters = new LinkedHashMap<>();
            c.getCounters().forEach((k, v) -> {
                if (v > 0) counters.put(k.toString(), v);
            });
            if (!counters.isEmpty()) map.put("counters", counters);
        } catch (Exception ignored) {}
        // Token flag + english name for image lookup
        try { if (c.isToken()) map.put("isToken", true); } catch (Exception ignored) {}
        try { map.put("englishName", c.getName()); } catch (Exception ignored) {}
        // Aura / equipment attachment — id of the host permanent
        try {
            if ((c.isAura() || c.isEquipment() || c.isFortification()) && c.getAttachedTo() != null)
                map.put("attachedToId", c.getAttachedTo().getId());
        } catch (Exception ignored) {}
        // Keywords (Flying, Double Strike, Haste, etc.) for display
        try {
            List<String> kws = new java.util.ArrayList<>();
            for (forge.game.keyword.KeywordInterface kw : c.getKeywords()) {
                String kwStr = kw.getOriginal();
                if (kwStr != null && !kwStr.isBlank() && !kwStr.contains(":") && kwStr.length() < 40)
                    kws.add(kwStr);
            }
            if (!kws.isEmpty()) map.put("keywords", kws);
        } catch (Exception ignored) {}
        // Combat status (attacking / blocking)
        try {
            Combat combat = game.getPhaseHandler().getCombat();
            if (combat != null) {
                if (combat.getAttackers().contains(c)) {
                    map.put("combat", "attacking");
                } else {
                    for (Card atk : combat.getAttackers()) {
                        if (combat.getBlockers(atk).contains(c)) {
                            map.put("combat", "blocking");
                            map.put("blockingIds", List.of(atk.getId()));
                            map.put("blockingName", atk.getName());
                            break;
                        }
                    }
                }
            }
        } catch (Exception ignored) {}
        return map;
    }

    private Map<String, Object> serializeCombat(Combat combat) {
        Map<String, Object> map = new LinkedHashMap<>();
        List<Map<String, Object>> attackers = new ArrayList<>();
        for (Card a : combat.getAttackers()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("id", a.getId());
            entry.put("name", a.getName());
            var blockers = combat.getBlockers(a);
            List<Map<String, Object>> blockList = new ArrayList<>();
            for (Card b : blockers) {
                Map<String, Object> bMap = new LinkedHashMap<>();
                bMap.put("id", b.getId());
                bMap.put("name", b.getName());
                blockList.add(bMap);
            }
            entry.put("blockers", blockList);
            var defender = combat.getDefenderByAttacker(a);
            if (defender instanceof Player p) {
                entry.put("target", p.getName());
                entry.put("targetId", "P" + p.getId());
            } else if (defender instanceof Card dc) {
                entry.put("target", dc.getName());
                entry.put("targetId", dc.getId()); // numeric id for planeswalker/card targeting
            }
            attackers.add(entry);
        }
        map.put("attackers", attackers);
        return map;
    }
}
