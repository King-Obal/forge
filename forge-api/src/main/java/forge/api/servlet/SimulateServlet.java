package forge.api.servlet;

import com.fasterxml.jackson.databind.ObjectMapper;
import forge.deck.Deck;
import forge.game.*;
import forge.game.player.RegisteredPlayer;
import forge.model.FModel;
import forge.player.GamePlayerUtil;
import forge.util.storage.IStorage;
import forge.view.TimeLimitedCodeBlock;

import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * POST /api/simulate
 *
 * Request body (JSON):
 * {
 *   "deck1": "DeckName",          // required: deck name for player 1
 *   "deck2": "DeckName",          // required: deck name for player 2
 *   "format": "Constructed",      // optional: Constructed (default), Commander, etc.
 *   "timeoutSeconds": 120         // optional: max game time (default 120)
 * }
 *
 * Response (JSON):
 * {
 *   "winner": "AI(1)-DeckName",
 *   "isDraw": false,
 *   "durationMs": 5432,
 *   "log": ["Turn 1: ...", ...]
 * }
 */
public class SimulateServlet extends HttpServlet {

    private static final ObjectMapper mapper = new ObjectMapper();

    @Override
    protected void doOptions(HttpServletRequest req, HttpServletResponse resp) {
        resp.setHeader("Access-Control-Allow-Origin", "*");
        resp.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        resp.setHeader("Access-Control-Allow-Headers", "Content-Type");
        resp.setStatus(HttpServletResponse.SC_OK);
    }

    @Override
    protected void doPost(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        resp.setContentType("application/json");
        resp.setHeader("Access-Control-Allow-Origin", "*");

        Map<?, ?> body;
        try {
            body = mapper.readValue(req.getInputStream(), Map.class);
        } catch (Exception e) {
            resp.setStatus(400);
            mapper.writeValue(resp.getWriter(), error("Invalid JSON body: " + e.getMessage()));
            return;
        }

        String deck1Name = getString(body, "deck1");
        String deck2Name = getString(body, "deck2");
        String formatStr = getString(body, "format");
        int timeoutSec = getInt(body, "timeoutSeconds", 120);

        if (deck1Name == null || deck1Name.isEmpty()) {
            resp.setStatus(400);
            mapper.writeValue(resp.getWriter(), error("'deck1' is required"));
            return;
        }
        if (deck2Name == null || deck2Name.isEmpty()) {
            resp.setStatus(400);
            mapper.writeValue(resp.getWriter(), error("'deck2' is required"));
            return;
        }

        GameType gameType = GameType.Constructed;
        if (formatStr != null && !formatStr.isEmpty()) {
            try {
                gameType = GameType.valueOf(formatStr);
            } catch (IllegalArgumentException e) {
                resp.setStatus(400);
                mapper.writeValue(resp.getWriter(), error("Unknown format: " + formatStr));
                return;
            }
        }

        IStorage<Deck> deckStorage = gameType == GameType.Commander
                ? FModel.getDecks().getCommander()
                : FModel.getDecks().getConstructed();

        Deck d1 = deckStorage.get(deck1Name);
        Deck d2 = deckStorage.get(deck2Name);

        if (d1 == null) {
            resp.setStatus(404);
            mapper.writeValue(resp.getWriter(), error("Deck not found: " + deck1Name));
            return;
        }
        if (d2 == null) {
            resp.setStatus(404);
            mapper.writeValue(resp.getWriter(), error("Deck not found: " + deck2Name));
            return;
        }

        String p1Name = "AI(1)-" + d1.getName();
        String p2Name = "AI(2)-" + d2.getName();

        RegisteredPlayer rp1 = gameType == GameType.Commander
                ? RegisteredPlayer.forCommander(d1)
                : new RegisteredPlayer(d1);
        rp1.setPlayer(GamePlayerUtil.createAiPlayer(p1Name, 0));

        RegisteredPlayer rp2 = gameType == GameType.Commander
                ? RegisteredPlayer.forCommander(d2)
                : new RegisteredPlayer(d2);
        rp2.setPlayer(GamePlayerUtil.createAiPlayer(p2Name, 1));

        GameRules rules = new GameRules(gameType);
        rules.setAppliedVariants(EnumSet.of(gameType));
        rules.setSimTimeout(timeoutSec);

        Match match = new Match(rules, List.of(rp1, rp2), "APISimulation");

        long startTime = System.currentTimeMillis();
        Game game = match.createGame();

        try {
            TimeLimitedCodeBlock.runWithTimeout(() -> match.startGame(game),
                    timeoutSec, TimeUnit.SECONDS);
        } catch (TimeoutException e) {
            game.setGameOver(GameEndReason.Draw);
        } catch (Exception | StackOverflowError e) {
            resp.setStatus(500);
            mapper.writeValue(resp.getWriter(), error("Game error: " + e.getMessage()));
            return;
        }

        long durationMs = System.currentTimeMillis() - startTime;

        // Collect game log
        List<GameLogEntry> entries = game.getGameLog().getLogEntries(null);
        Collections.reverse(entries);
        List<String> logLines = new ArrayList<>();
        for (GameLogEntry entry : entries) {
            logLines.add(entry.toString());
        }

        // Build response
        Map<String, Object> result = new LinkedHashMap<>();
        GameOutcome outcome = game.getOutcome();
        if (outcome.isDraw()) {
            result.put("winner", null);
            result.put("isDraw", true);
        } else {
            result.put("winner", outcome.getWinningLobbyPlayer().getName());
            result.put("isDraw", false);
        }
        result.put("durationMs", durationMs);
        result.put("log", logLines);

        mapper.writeValue(resp.getWriter(), result);
    }

    private static String getString(Map<?, ?> map, String key) {
        Object val = map.get(key);
        return val instanceof String ? (String) val : null;
    }

    private static int getInt(Map<?, ?> map, String key, int defaultVal) {
        Object val = map.get(key);
        if (val instanceof Number) return ((Number) val).intValue();
        return defaultVal;
    }

    private static Map<String, String> error(String message) {
        return Map.of("error", message);
    }
}
