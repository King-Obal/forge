package forge.api.game;

import forge.ai.AiCostDecision;
import forge.game.card.CardCollection;
import forge.game.card.CardCollectionView;
import forge.game.card.CardLists;
import forge.game.card.CardPredicates;
import forge.game.cost.CostExile;
import forge.game.cost.CostDiscard;
import forge.game.cost.CostPayLife;
import forge.game.cost.CostSacrifice;
import forge.game.cost.PaymentDecision;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.zone.ZoneType;
import org.apache.commons.lang3.StringUtils;

import java.util.function.BiFunction;
import java.util.function.IntBinaryOperator;

/**
 * Cost decision maker for the API player.
 * Delegates most decisions to AiCostDecision, but intercepts costs that require
 * interactive player input (exile from hand, discard choice, variable life payment).
 */
public class ApiCostDecision extends AiCostDecision {

    /**
     * Callback for interactive card selection.
     * (validCards, prompt) → chosen cards
     */
    private final BiFunction<CardCollectionView, String, CardCollectionView> interactivePick;

    /**
     * Callback for interactive number selection.
     * (min, max) → chosen number
     */
    private final IntBinaryOperator numberChooser;

    public ApiCostDecision(Player player, SpellAbility sa,
                           BiFunction<CardCollectionView, String, CardCollectionView> interactivePick,
                           IntBinaryOperator numberChooser) {
        super(player, sa, false);
        this.interactivePick = interactivePick;
        this.numberChooser = numberChooser;
    }

    @Override
    public PaymentDecision visit(CostPayLife cost) {
        // If the life amount is a variable (like X in Toxic Deluge), ask the player interactively
        if (!StringUtils.isNumeric(cost.getAmount()) && numberChooser != null) {
            int maxLife = player.getLife();
            if (maxLife <= 0) return null;
            int chosen = numberChooser.applyAsInt(0, maxLife);
            if (chosen < 0) return null;
            // Set XManaCostPaid so that Count$xPaid evaluates correctly during effect resolution
            ability.setXManaCostPaid(chosen);
            if (!player.canPayLife(chosen, isEffect(), ability)) return null;
            return PaymentDecision.number(chosen);
        }
        return super.visit(cost);
    }

    @Override
    public PaymentDecision visit(CostExile cost) {
        // For ExileFromHand costs, ask the player interactively
        if (!cost.payCostFromSource()
                && cost.getFrom() != null
                && cost.getFrom().contains(ZoneType.Hand)) {
            int amount = cost.getAbilityAmount(ability);
            CardCollectionView hand = player.getCardsIn(ZoneType.Hand);
            CardCollectionView valid = CardLists.getValidCards(hand, cost.getType(), player, source, ability);
            if (valid.isEmpty()) return null;
            String desc = cost.getTypeDescription() != null ? cost.getTypeDescription() : cost.getType();
            String prompt = "Exiler " + amount + " carte" + (amount > 1 ? "s" : "") + " de votre main (" + desc + ")";
            CardCollectionView chosen = interactivePick.apply(valid, prompt);
            if (chosen == null || chosen.isEmpty()) return null;
            return PaymentDecision.card(new CardCollection(chosen));
        }
        return super.visit(cost);
    }

    @Override
    public PaymentDecision visit(CostSacrifice cost) {
        // Let the source sacrifice itself or "All" go through AI as usual
        if (cost.payCostFromSource() || cost.getType().equals("OriginalHost")
                || "All".equalsIgnoreCase(cost.getAmount())) {
            return super.visit(cost);
        }
        int amount = cost.getAbilityAmount(ability);
        CardCollectionView battlefield = player.getCardsIn(ZoneType.Battlefield);
        CardCollectionView valid = CardLists.getValidCards(battlefield, cost.getType().split(";"), player, source, ability);
        valid = CardLists.filter(valid, CardPredicates.canBeSacrificedBy(ability, false));
        if (valid.size() < amount) return null;
        String desc = cost.getTypeDescription() != null ? cost.getTypeDescription() : cost.getType();
        String prompt = "Sacrifier " + amount + " " + desc + " (pour : " + (ability.getDescription() != null ? ability.getDescription() : ability.toString()) + ")";
        CardCollectionView chosen = interactivePick.apply(valid, prompt);
        if (chosen == null || chosen.isEmpty()) return null;
        return PaymentDecision.card(new CardCollection(chosen));
    }

    @Override
    public PaymentDecision visit(CostDiscard cost) {
        // For manual discard costs (not "discard hand"), ask the player interactively
        final String type = cost.getType();
        if (!cost.payCostFromSource() && !type.equals("Hand") && !type.equals("Random")
                && !type.equals("LastDrawn") && !type.contains("WithSameName")) {
            int amount = cost.getAbilityAmount(ability);
            CardCollectionView hand = player.getCardsIn(ZoneType.Hand);
            CardCollectionView valid = CardLists.getValidCards(hand, type, player, source, ability);
            if (valid.isEmpty()) return null;
            String desc = cost.getTypeDescription() != null ? cost.getTypeDescription() : type;
            String prompt = "Défausser " + amount + " carte" + (amount > 1 ? "s" : "") + " (" + desc + ")";
            CardCollectionView chosen = interactivePick.apply(valid, prompt);
            if (chosen == null || chosen.isEmpty()) return null;
            return PaymentDecision.card(new CardCollection(chosen));
        }
        return super.visit(cost);
    }
}
