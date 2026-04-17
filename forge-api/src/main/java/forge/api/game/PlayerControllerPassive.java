package forge.api.game;

import forge.LobbyPlayer;
import forge.ai.PlayerControllerAi;
import forge.game.Game;
import forge.game.combat.Combat;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;

import java.util.List;

/**
 * Adversaire fantoche pour le mode debug.
 * Passe toujours la priorité, n'attaque jamais, ne bloque jamais.
 */
public class PlayerControllerPassive extends PlayerControllerAi {

    public PlayerControllerPassive(Game game, Player player, LobbyPlayer lobbyPlayer) {
        super(game, player, lobbyPlayer);
    }

    @Override
    public List<SpellAbility> chooseSpellAbilityToPlay() {
        return null; // toujours passer la priorité
    }

    @Override
    public void declareAttackers(Player attacker, Combat combat) {
        // ne déclare jamais d'attaquants
    }

    @Override
    public void declareBlockers(Player defender, Combat combat) {
        // ne déclare jamais de bloqueurs
    }
}
