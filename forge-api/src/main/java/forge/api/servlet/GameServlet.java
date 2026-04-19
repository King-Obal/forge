package forge.api.servlet;

import com.fasterxml.jackson.databind.ObjectMapper;
import forge.LobbyPlayer;
import forge.StaticData;
import forge.ai.LobbyPlayerAi;
import forge.api.game.GameSession;
import forge.api.game.GameSessionManager;
import forge.api.game.LobbyPlayerApi;
import forge.api.game.PlayerControllerApi;
import forge.api.game.PlayerControllerPassive;
import forge.deck.Deck;
import forge.item.PaperCard;
import forge.player.GamePlayerUtil;
import forge.game.*;
import forge.game.card.Card;
import forge.game.player.Player;
import forge.game.player.RegisteredPlayer;
import forge.game.zone.ZoneType;
import forge.model.FModel;
import forge.util.storage.IStorage;

import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.*;

/**
 * REST endpoints for interactive game sessions.
 *
 * POST /api/game/start
 *   Body: { "deck1": "name", "deck2": "name", "format": "Commander" }
 *   Response: { "sessionId": "...", "player1": "name", "player2": "name" }
 *
 * GET /api/game/{id}/state
 *   Response: full game state JSON including pendingDecision
 *
 * POST /api/game/{id}/respond
 *   Body: decision response (shape depends on decision type)
 *   Response: { "ok": true }
 *
 * DELETE /api/game/{id}
 *   Terminate a session.
 */
public class GameServlet extends HttpServlet {

    private static final ObjectMapper mapper = new ObjectMapper();

    @Override
    protected void doOptions(HttpServletRequest req, HttpServletResponse resp) {
        cors(resp);
        resp.setStatus(HttpServletResponse.SC_OK);
    }

    @Override
    protected void doPost(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        System.out.println("[doPost] " + req.getRequestURI());
        cors(resp);
        resp.setContentType("application/json;charset=UTF-8");
        String uri = req.getRequestURI(); // e.g. /api/game/start

        if (uri.endsWith("/game/start")) {
            handleStart(req, resp);
        } else if (uri.contains("/game/") && uri.endsWith("/concede")) {
            String id = extractId(uri, "/concede");
            handleConcede(id, resp);
        } else if (uri.contains("/game/") && uri.endsWith("/respond")) {
            String id = extractId(uri, "/respond");
            handleRespond(id, req, resp);
        } else if (uri.contains("/game/") && uri.contains("/debug/add-card")) {
            String id = extractId(uri, "/debug/add-card");
            handleDebugAddCard(id, req, resp);
        } else if (uri.contains("/game/") && uri.contains("/debug/set-life")) {
            String id = extractId(uri, "/debug/set-life");
            handleDebugSetLife(id, req, resp);
        } else {
            resp.setStatus(404);
            mapper.writeValue(resp.getWriter(), error("Unknown endpoint: " + uri));
        }
    }

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        cors(resp);
        resp.setContentType("application/json;charset=UTF-8");
        String uri = req.getRequestURI();

        if (uri.contains("/game/commanders")) {
            handleGetCommanders(req, resp);
        } else if (uri.contains("/game/") && uri.endsWith("/state")) {
            String id = extractId(uri, "/state");
            handleState(id, resp);
        } else {
            resp.setStatus(404);
            mapper.writeValue(resp.getWriter(), error("Unknown endpoint: " + uri));
        }
    }

    @Override
    protected void doDelete(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        System.out.println("[doDelete] " + req.getRequestURI());
        cors(resp);
        resp.setContentType("application/json;charset=UTF-8");
        String uri = req.getRequestURI();
        String id = uri.replaceAll(".*/game/", "");
        GameSession session = GameSessionManager.getInstance().get(id);
        if (session != null) {
            session.setGameOver(true);
            session.receiveDecision(Map.of("choice", "pass")); // unblock any waiting future
            session.interruptGameThread();                      // interrupt AI or sleep
            GameSessionManager.getInstance().remove(id);
        }
        mapper.writeValue(resp.getWriter(), Map.of("ok", true));
    }

    // ── POST /api/game/start ─────────────────────────────────────────────────

    private void handleStart(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        System.out.println("[handleStart] POST /api/game/start received");
        Map<?, ?> body;
        try {
            body = mapper.readValue(req.getInputStream(), Map.class);
        } catch (Exception e) {
            resp.setStatus(400);
            mapper.writeValue(resp.getWriter(), error("Invalid JSON"));
            return;
        }

        String deck1Name = getString(body, "deck1");
        String deck2Name = getString(body, "deck2");
        String formatStr = getString(body, "format");
        String commander1Name = getString(body, "commander1");
        String commander2Name = getString(body, "commander2");
        int goFirstPlayerIndex = body.get("goFirstPlayerIndex") instanceof Number n ? n.intValue() : -1;
        boolean isDebug = Boolean.TRUE.equals(body.get("debug"));

        if (deck1Name == null || deck1Name.isEmpty() || deck2Name == null || deck2Name.isEmpty()) {
            resp.setStatus(400);
            mapper.writeValue(resp.getWriter(), error("'deck1' and 'deck2' are required"));
            return;
        }

        boolean isCommander = formatStr == null || !formatStr.equalsIgnoreCase("Constructed");
        IStorage<Deck> deckStorage = isCommander
                ? FModel.getDecks().getCommander()
                : FModel.getDecks().getConstructed();

        // Fallback search in both storages
        Deck d1 = deckStorage.get(deck1Name);
        if (d1 == null) d1 = FModel.getDecks().getCommander().get(deck1Name);
        if (d1 == null) d1 = FModel.getDecks().getConstructed().get(deck1Name);
        Deck d2 = deckStorage.get(deck2Name);
        if (d2 == null) d2 = FModel.getDecks().getCommander().get(deck2Name);
        if (d2 == null) d2 = FModel.getDecks().getConstructed().get(deck2Name);

        if (d1 == null) { resp.setStatus(404); mapper.writeValue(resp.getWriter(), error("Deck not found: " + deck1Name)); return; }
        if (d2 == null) { resp.setStatus(404); mapper.writeValue(resp.getWriter(), error("Deck not found: " + deck2Name)); return; }

        GameType gameType = isCommander ? GameType.Commander : GameType.Constructed;

        // Create session immediately — respond to client before starting the game (avoid socket hang up)
        GameSession session = GameSessionManager.getInstance().create();
        if (isDebug) session.setDebug(true);
        if (goFirstPlayerIndex >= 0) session.setForcedFirstPlayerIndex(goFirstPlayerIndex);

        final Deck fd1 = d1, fd2 = d2;
        final boolean fIsCommander = isCommander;
        final GameType fGameType = gameType;
        final String fCommander1Name = commander1Name;
        final String fCommander2Name = commander2Name;
        final boolean fIsDebug = isDebug;
        final int fGoFirstPlayerIndex = goFirstPlayerIndex;

        // Everything game-related runs in background thread
        Thread gameThread = new Thread(() -> {
            // Track if we temporarily removed a card from the main deck (to restore after game)
            PaperCard[] removedFromMain = {null};
            try {
                String p1Name = "Player 1";
                String p2Name = "AI";
                LobbyPlayerApi lp1 = new LobbyPlayerApi(p1Name, session, 0);

                RegisteredPlayer rp1 = fIsCommander ? RegisteredPlayer.forCommander(fd1) : new RegisteredPlayer(fd1);
                rp1.setPlayer(lp1);
                if (fIsCommander) rp1.setStartingLife(20);
                // Apply commander swap if specified (supports 1 or 2 commanders for partner)
                if (fIsCommander && fCommander1Name != null && !fCommander1Name.isEmpty()) {
                    List<PaperCard> chosen = new java.util.ArrayList<>();
                    PaperCard[] removedFromMainArr = {null, null};
                    for (String cName : new String[]{fCommander1Name, fCommander2Name}) {
                        if (cName == null || cName.isEmpty()) continue;
                        PaperCard found = null; boolean fromMain = false;
                        for (PaperCard pc : fd1.getCommanders()) {
                            if (cName.equals(pc.getName())) { found = pc; break; }
                        }
                        if (found == null && fd1.getMain() != null) {
                            for (PaperCard pc : fd1.getMain().toFlatList()) {
                                if (cName.equals(pc.getName())) { found = pc; fromMain = true; break; }
                            }
                        }
                        if (found != null) {
                            chosen.add(found);
                            if (fromMain) {
                                fd1.getMain().remove(found);
                                removedFromMain[0] = removedFromMain[0] == null ? found : removedFromMain[0];
                            }
                        }
                    }
                    if (!chosen.isEmpty()) rp1.setCommanders(chosen);
                }
                RegisteredPlayer rp2 = fIsCommander ? RegisteredPlayer.forCommander(fd2) : new RegisteredPlayer(fd2);
                if (fIsDebug) {
                    // Mode debug : adversaire fantoche qui ne fait rien
                    LobbyPlayer passiveLobby = new LobbyPlayerAi(p2Name, null) {
                        @Override
                        public forge.game.player.Player createIngamePlayer(forge.game.Game g, int pid) {
                            forge.game.player.Player p = new forge.game.player.Player(getName(), g, pid);
                            p.setFirstController(new PlayerControllerPassive(g, p, this));
                            return p;
                        }
                    };
                    rp2.setPlayer(passiveLobby);
                } else if (fGoFirstPlayerIndex >= 0) {
                    // Override AI's chooseStartingPlayer to respect the forced starting player
                    rp2.setPlayer(new LobbyPlayerAi(p2Name, null) {
                        @Override
                        public forge.game.player.Player createIngamePlayer(forge.game.Game g, int pid) {
                            forge.game.player.Player ai = new forge.game.player.Player(getName(), g, pid);
                            ai.setFirstController(new forge.ai.PlayerControllerAi(g, ai, this) {
                                @Override
                                public forge.game.player.Player chooseStartingPlayer(boolean isFirstGame) {
                                    java.util.List<forge.game.player.Player> pl = new java.util.ArrayList<>(g.getPlayers());
                                    return fGoFirstPlayerIndex < pl.size() ? pl.get(fGoFirstPlayerIndex) : ai;
                                }
                            });
                            return ai;
                        }
                    });
                } else {
                    rp2.setPlayer(GamePlayerUtil.createAiPlayer(p2Name, 1));
                }
                if (fIsCommander) rp2.setStartingLife(20);

                GameRules rules = new GameRules(fGameType);
                rules.setAppliedVariants(EnumSet.of(fGameType));

                Match match = new Match(rules, List.of(rp1, rp2), "InteractivePlay");
                Game game = match.createGame();
                session.setGame(game);

                match.startGame(game);
            } catch (PlayerControllerApi.GameAbortedException e) {
                // Session was killed via DELETE — exit cleanly, no error to report
            } catch (Exception | Error e) {
                System.err.println("[GameSession] Error: " + e);
                e.printStackTrace();
                session.setGameError(e.getClass().getSimpleName() + ": " + e.getMessage());
            } finally {
                // Restore main deck if a card was temporarily removed for commander override
                if (removedFromMain[0] != null) fd1.getMain().add(removedFromMain[0]);
                session.setGameOver(true);
                session.receiveDecision(Map.of("choice", "pass"));
            }
        }, "GameSession-" + session.getId());
        gameThread.setDaemon(true);
        session.setGameThread(gameThread);
        gameThread.start();

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("sessionId", session.getId());
        result.put("player1", "Player 1");
        result.put("player2", "AI");
        result.put("format", gameType.name());
        result.put("deck1", d1.getName());
        result.put("deck2", d2.getName());
        result.put("debug", isDebug);
        mapper.writeValue(resp.getWriter(), result);
    }

    // ── GET /api/game/{id}/state ─────────────────────────────────────────────

    private void handleState(String id, HttpServletResponse resp) throws IOException {
        GameSession session = GameSessionManager.getInstance().get(id);
        if (session == null) {
            resp.setStatus(404);
            mapper.writeValue(resp.getWriter(), error("Session not found: " + id));
            return;
        }
        mapper.writeValue(resp.getWriter(), session.toStateMap());
    }

    // ── POST /api/game/{id}/respond ──────────────────────────────────────────

    private void handleRespond(String id, HttpServletRequest req, HttpServletResponse resp) throws IOException {
        GameSession session = GameSessionManager.getInstance().get(id);
        if (session == null) {
            resp.setStatus(404);
            mapper.writeValue(resp.getWriter(), error("Session not found: " + id));
            return;
        }

        Map<?, ?> rawBody;
        try {
            rawBody = mapper.readValue(req.getInputStream(), Map.class);
        } catch (Exception e) {
            resp.setStatus(400);
            mapper.writeValue(resp.getWriter(), error("Invalid JSON"));
            return;
        }

        // Convert to Map<String, Object>
        Map<String, Object> body = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : rawBody.entrySet()) {
            body.put(String.valueOf(entry.getKey()), entry.getValue());
        }

        boolean delivered = session.receiveDecision(body);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("ok", delivered);
        if (!delivered) result.put("reason", "no pending decision or already responded");
        mapper.writeValue(resp.getWriter(), result);
    }

    // ── GET /api/game/commanders ─────────────────────────────────────────────

    private void handleGetCommanders(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        String deckName = req.getParameter("deck");
        if (deckName == null || deckName.isEmpty()) {
            resp.setStatus(400);
            mapper.writeValue(resp.getWriter(), error("'deck' parameter required"));
            return;
        }
        Deck deck = FModel.getDecks().getCommander().get(deckName);
        if (deck == null) deck = FModel.getDecks().getConstructed().get(deckName);
        if (deck == null) {
            resp.setStatus(404);
            mapper.writeValue(resp.getWriter(), error("Deck not found: " + deckName));
            return;
        }

        List<Map<String, Object>> result = new ArrayList<>();
        Set<String> seen = new java.util.LinkedHashSet<>();

        // Designated commanders first
        for (PaperCard pc : deck.getCommanders()) {
            if (seen.add(pc.getName())) {
                String mc = pc.getRules() != null && pc.getRules().getManaCost() != null
                        ? pc.getRules().getManaCost().toString() : "";
                result.add(Map.of("name", pc.getName(), "manaCost", mc));
            }
        }

        // Legal commanders in main deck (legendary creatures / "can be your commander")
        if (deck.getMain() != null) {
            for (PaperCard pc : deck.getMain().toFlatList()) {
                if (seen.add(pc.getName()) && pc.getRules() != null && pc.getRules().canBeCommander()) {
                    String mc = pc.getRules().getManaCost() != null
                            ? pc.getRules().getManaCost().toString() : "";
                    result.add(Map.of("name", pc.getName(), "manaCost", mc));
                }
            }
        }

        mapper.writeValue(resp.getWriter(), Map.of("commanders", result, "designatedCount", deck.getCommanders().size()));
    }

    // ── POST /api/game/{id}/debug/add-card ───────────────────────────────────

    private void handleDebugAddCard(String id, HttpServletRequest req, HttpServletResponse resp) throws IOException {
        GameSession session = GameSessionManager.getInstance().get(id);
        if (session == null) {
            resp.setStatus(404);
            mapper.writeValue(resp.getWriter(), error("Session not found: " + id));
            return;
        }
        if (!session.isDebug()) {
            resp.setStatus(403);
            mapper.writeValue(resp.getWriter(), error("Debug mode not enabled"));
            return;
        }

        Map<?, ?> body;
        try {
            body = mapper.readValue(req.getInputStream(), Map.class);
        } catch (Exception e) {
            resp.setStatus(400);
            mapper.writeValue(resp.getWriter(), error("Invalid JSON"));
            return;
        }

        String cardName = getString(body, "card");
        String zoneName = getString(body, "zone");  // "hand", "battlefield", "graveyard"
        int playerIndex = body.get("player") instanceof Number ? ((Number) body.get("player")).intValue() : 0;

        if (cardName == null || cardName.isEmpty()) {
            resp.setStatus(400);
            mapper.writeValue(resp.getWriter(), error("'card' is required"));
            return;
        }

        ZoneType zone = ZoneType.Hand;
        if ("battlefield".equalsIgnoreCase(zoneName)) zone = ZoneType.Battlefield;
        else if ("graveyard".equalsIgnoreCase(zoneName)) zone = ZoneType.Graveyard;
        else if ("library".equalsIgnoreCase(zoneName)) zone = ZoneType.Library;
        else if ("exile".equalsIgnoreCase(zoneName)) zone = ZoneType.Exile;

        forge.game.Game game = session.getGame();
        if (game == null) {
            resp.setStatus(400);
            mapper.writeValue(resp.getWriter(), error("Game not started yet"));
            return;
        }

        try {
            forge.item.PaperCard pc = StaticData.instance().getCommonCards().getCard(cardName);
            if (pc == null) {
                resp.setStatus(404);
                mapper.writeValue(resp.getWriter(), error("Card not found: " + cardName));
                return;
            }
            java.util.List<Player> players = new java.util.ArrayList<>(game.getPlayers());
            if (playerIndex < 0 || playerIndex >= players.size()) {
                resp.setStatus(400);
                mapper.writeValue(resp.getWriter(), error("Invalid player index"));
                return;
            }
            Player player = players.get(playerIndex);
            Card card = Card.fromPaperCard(pc, player);
            game.getAction().moveTo(ZoneType.None, card, null, new HashMap<>());
            game.getAction().moveTo(zone, card, null, new HashMap<>());
            mapper.writeValue(resp.getWriter(), Map.of("ok", true, "card", cardName, "zone", zone.name()));
        } catch (Exception e) {
            resp.setStatus(500);
            mapper.writeValue(resp.getWriter(), error("Failed to add card: " + e.getMessage()));
        }
    }

    // ── POST /api/game/{id}/debug/set-life ───────────────────────────────────

    private void handleDebugSetLife(String id, HttpServletRequest req, HttpServletResponse resp) throws IOException {
        GameSession session = GameSessionManager.getInstance().get(id);
        if (session == null) {
            resp.setStatus(404);
            mapper.writeValue(resp.getWriter(), error("Session not found: " + id));
            return;
        }
        if (!session.isDebug()) {
            resp.setStatus(403);
            mapper.writeValue(resp.getWriter(), error("Debug mode not enabled"));
            return;
        }

        Map<?, ?> body;
        try {
            body = mapper.readValue(req.getInputStream(), Map.class);
        } catch (Exception e) {
            resp.setStatus(400);
            mapper.writeValue(resp.getWriter(), error("Invalid JSON"));
            return;
        }

        int playerIndex = body.get("player") instanceof Number ? ((Number) body.get("player")).intValue() : 0;
        int life = body.get("life") instanceof Number ? ((Number) body.get("life")).intValue() : -1;

        if (life < 0) {
            resp.setStatus(400);
            mapper.writeValue(resp.getWriter(), error("'life' (non-negative integer) is required"));
            return;
        }

        forge.game.Game game = session.getGame();
        if (game == null) {
            resp.setStatus(400);
            mapper.writeValue(resp.getWriter(), error("Game not started yet"));
            return;
        }

        java.util.List<Player> players = new java.util.ArrayList<>(game.getPlayers());
        if (playerIndex < 0 || playerIndex >= players.size()) {
            resp.setStatus(400);
            mapper.writeValue(resp.getWriter(), error("Invalid player index"));
            return;
        }
        Player player = players.get(playerIndex);
        player.setLife(life, null);
        mapper.writeValue(resp.getWriter(), Map.of("ok", true, "player", player.getName(), "life", life));
    }

    // ── POST /api/game/{id}/concede ──────────────────────────────────────────

    private void handleConcede(String id, HttpServletResponse resp) throws IOException {
        GameSession session = GameSessionManager.getInstance().get(id);
        if (session == null) {
            resp.setStatus(404);
            mapper.writeValue(resp.getWriter(), error("Session not found: " + id));
            return;
        }
        forge.game.Game game = session.getGame();
        // Mark session over immediately so the next poll returns gameOver=true
        session.setGameOver(true);
        session.setConcedeWinner("AI"); // player 1 conceded → AI wins
        if (game != null) {
            try {
                java.util.List<Player> players = new java.util.ArrayList<>(game.getPlayers());
                if (!players.isEmpty()) {
                    players.get(0).concede();
                }
            } catch (Exception e) {
                System.err.println("[concede] error: " + e);
            }
        }
        // Unblock any pending decision and interrupt AI computation
        session.receiveDecision(Map.of("choice", "pass"));
        session.interruptGameThread();
        mapper.writeValue(resp.getWriter(), Map.of("ok", true));
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private String extractId(String uri, String suffix) {
        // uri example: /api/game/some-uuid/state
        String withoutSuffix = uri.substring(0, uri.length() - suffix.length());
        int lastSlash = withoutSuffix.lastIndexOf('/');
        return withoutSuffix.substring(lastSlash + 1);
    }

    private void cors(HttpServletResponse resp) {
        resp.setHeader("Access-Control-Allow-Origin", "*");
        resp.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        resp.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }

    private static String getString(Map<?, ?> map, String key) {
        Object val = map.get(key);
        return val instanceof String ? (String) val : null;
    }

    private static Map<String, String> error(String message) {
        return Map.of("error", message);
    }
}
