package forge.api.game;

import forge.LobbyPlayer;
import forge.game.Game;
import forge.game.player.IGameEntitiesFactory;
import forge.game.player.Player;
import forge.game.player.PlayerController;

/**
 * A LobbyPlayer that creates API-controlled (human-via-REST) in-game players.
 */
public class LobbyPlayerApi extends LobbyPlayer implements IGameEntitiesFactory {

    private final GameSession session;
    private final int playerIndex; // 0 or 1

    public LobbyPlayerApi(String name, GameSession session, int playerIndex) {
        super(name);
        this.session = session;
        this.playerIndex = playerIndex;
    }

    @Override
    public Player createIngamePlayer(Game game, int id) {
        Player p = new Player(getName(), game, id);
        PlayerControllerApi controller = new PlayerControllerApi(game, p, this, session, playerIndex);
        p.setFirstController(controller);
        session.setController(playerIndex, controller);
        return p;
    }

    @Override
    public PlayerController createMindSlaveController(Player master, Player slave) {
        // Use existing controller (mind-slave rare edge case)
        return slave.getController();
    }

    @Override
    public void hear(LobbyPlayer player, String message) {
        // No-op for API player
    }
}
