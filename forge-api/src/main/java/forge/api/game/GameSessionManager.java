package forge.api.game;

import java.util.Collection;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Singleton registry of active game sessions.
 */
public class GameSessionManager {

    private static final GameSessionManager INSTANCE = new GameSessionManager();

    private final Map<String, GameSession> sessions = new ConcurrentHashMap<>();

    private GameSessionManager() {}

    public static GameSessionManager getInstance() { return INSTANCE; }

    public GameSession create() {
        String id = UUID.randomUUID().toString();
        GameSession session = new GameSession(id);
        sessions.put(id, session);
        return session;
    }

    public GameSession get(String id) {
        return sessions.get(id);
    }

    public void remove(String id) {
        sessions.remove(id);
    }

    public Collection<GameSession> all() {
        return sessions.values();
    }

    /** Remove sessions inactive for more than the given milliseconds. */
    public void pruneInactive(long maxIdleMs) {
        long now = System.currentTimeMillis();
        sessions.entrySet().removeIf(e ->
                (now - e.getValue().getLastActivity()) > maxIdleMs && e.getValue().isGameOver()
        );
    }
}
