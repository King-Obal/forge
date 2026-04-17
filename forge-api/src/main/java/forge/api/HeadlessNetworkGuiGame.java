package forge.api;

import forge.LobbyPlayer;
import forge.ai.GameState;
import forge.deck.CardPool;
import forge.game.GameEntityView;
import forge.game.GameView;
import forge.game.card.CardView;
import forge.game.phase.PhaseType;
import forge.game.player.DelayedReveal;
import forge.game.player.IHasIcon;
import forge.game.player.PlayerView;
import forge.game.spellability.SpellAbilityView;
import forge.game.zone.ZoneType;
import forge.gamemodes.match.AbstractGuiGame;
import forge.item.PaperCard;
import forge.localinstance.skin.FSkinProp;
import forge.player.PlayerZoneUpdate;
import forge.player.PlayerZoneUpdates;
import forge.trackable.TrackableCollection;
import forge.util.FSerializableFunction;
import forge.util.ITriggerEvent;

import java.util.*;

/**
 * Headless IGuiGame implementation for the API server.
 * All UI interactions return safe defaults so AI games can run without a display.
 */
public class HeadlessNetworkGuiGame extends AbstractGuiGame {

    @Override protected void updateCurrentPlayer(PlayerView player) {}
    @Override public void openView(TrackableCollection<PlayerView> myPlayers) {}
    @Override public void showCombat() {}
    @Override public void finishGame() {}
    @Override public void showPromptMessage(PlayerView playerView, String message) {}
    @Override public void showCardPromptMessage(PlayerView playerView, String message, CardView card) {}
    @Override public void updateButtons(PlayerView owner, String label1, String label2,
                                        boolean enable1, boolean enable2, boolean focus1) {}
    @Override public void flashIncorrectAction() {}
    @Override public void alertUser() {}
    @Override public void enableOverlay() {}
    @Override public void disableOverlay() {}
    @Override public void showManaPool(PlayerView player) {}
    @Override public void hideManaPool(PlayerView player) {}
    @Override public void updateShards(Iterable<PlayerView> shardsUpdate) {}
    @Override public void setPanelSelection(CardView hostCard) {}
    @Override public void message(String message, String title) {}
    @Override public void showErrorDialog(String message, String title) {
        System.err.println("[API] " + title + ": " + message);
    }
    @Override public GameState getGamestate() { return null; }
    @Override public void setCard(CardView card) {}
    @Override public void setPlayerAvatar(LobbyPlayer player, IHasIcon ihi) {}
    @Override public void restoreOldZones(PlayerView playerView, PlayerZoneUpdates playerZoneUpdates) {}

    @Override
    public Iterable<PlayerZoneUpdate> tempShowZones(PlayerView controller,
                                                     Iterable<PlayerZoneUpdate> zonesToUpdate) {
        return zonesToUpdate;
    }

    @Override
    public void hideZones(PlayerView controller, Iterable<PlayerZoneUpdate> zonesToUpdate) {}

    @Override
    public SpellAbilityView getAbilityToPlay(CardView hostCard, List<SpellAbilityView> abilities,
                                              ITriggerEvent triggerEvent) {
        return abilities != null && !abilities.isEmpty() ? abilities.get(0) : null;
    }

    @Override
    public Map<CardView, Integer> assignCombatDamage(CardView attacker, List<CardView> blockers,
                                                      int damage, GameEntityView defender,
                                                      boolean overrideOrder, boolean maySkip) {
        Map<CardView, Integer> result = new HashMap<>();
        if (blockers != null && !blockers.isEmpty()) result.put(blockers.get(0), damage);
        return result;
    }

    @Override
    public Map<Object, Integer> assignGenericAmount(CardView effectSource, Map<Object, Integer> target,
                                                     int amount, boolean atLeastOne, String amountLabel) {
        return target;
    }

    @Override
    public boolean showConfirmDialog(String message, String title, String yesButtonText,
                                     String noButtonText, boolean defaultYes) {
        return defaultYes;
    }

    @Override
    public int showOptionDialog(String message, String title, FSkinProp icon,
                                List<String> options, int defaultOption) {
        return defaultOption;
    }

    @Override
    public String showInputDialog(String message, String title, FSkinProp icon,
                                  String initialInput, List<String> inputOptions, boolean isNumeric) {
        if (initialInput != null) return initialInput;
        if (inputOptions != null && !inputOptions.isEmpty()) return inputOptions.get(0);
        return "";
    }

    @Override
    public boolean confirm(CardView c, String question, boolean defaultIsYes, List<String> options) {
        return defaultIsYes;
    }

    @Override
    public <T> List<T> getChoices(String message, int min, int max, List<T> choices,
                                   List<T> selected, FSerializableFunction<T, String> display) {
        if (choices == null || choices.isEmpty()) return Collections.emptyList();
        int count = Math.min(Math.max(0, min), choices.size());
        return count == 0 ? Collections.emptyList() : choices.subList(0, count);
    }

    @Override
    public <T> List<T> order(String title, String top, int remainingObjectsMin,
                              int remainingObjectsMax, List<T> sourceChoices, List<T> destChoices,
                              CardView referenceCard, boolean sideboardingMode) {
        return sourceChoices != null ? sourceChoices : Collections.emptyList();
    }

    @Override
    public List<PaperCard> sideboard(CardPool sideboard, CardPool main, String message) {
        return Collections.emptyList();
    }

    @Override
    public GameEntityView chooseSingleEntityForEffect(String title,
                                                       List<? extends GameEntityView> optionList,
                                                       DelayedReveal delayedReveal, boolean isOptional) {
        if (optionList == null || optionList.isEmpty()) return null;
        return isOptional ? null : optionList.get(0);
    }

    @Override
    public List<GameEntityView> chooseEntitiesForEffect(String title,
                                                         List<? extends GameEntityView> optionList,
                                                         int min, int max,
                                                         DelayedReveal delayedReveal) {
        if (optionList == null || optionList.isEmpty()) return Collections.emptyList();
        return new ArrayList<>(optionList.subList(0, Math.min(min, optionList.size())));
    }

    @Override
    public List<CardView> manipulateCardList(String title, Iterable<CardView> cards,
                                              Iterable<CardView> manipulable, boolean toTop,
                                              boolean toBottom, boolean toAnywhere) {
        List<CardView> result = new ArrayList<>();
        if (cards != null) cards.forEach(result::add);
        return result;
    }

    @Override
    public PlayerZoneUpdates openZones(PlayerView controller, Collection<ZoneType> zones,
                                        Map<PlayerView, Object> players, boolean backupLastZones) {
        return null;
    }

    @Override
    public boolean isUiSetToSkipPhase(PlayerView playerTurn, PhaseType phase) { return false; }
}
