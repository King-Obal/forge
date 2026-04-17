package forge.api.servlet;

import com.fasterxml.jackson.databind.ObjectMapper;
import forge.deck.Deck;
import forge.deck.DeckSection;
import forge.model.FModel;
import forge.util.storage.IStorage;

import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.*;

/**
 * POST /api/decks/import
 *
 * Request body (JSON):
 * {
 *   "name": "My Deck",           // required
 *   "format": "Commander",       // optional: Commander (default), Constructed
 *   "commander": "Card Name" | [{name,qty}],  // optional: string or array
 *   "mainboard": [               // required
 *     { "name": "Rancor", "qty": 1 },
 *     ...
 *   ]
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "name": "My Deck",
 *   "commanderCount": 1,
 *   "mainboardCount": 99
 * }
 */
public class ImportDeckServlet extends HttpServlet {

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
            mapper.writeValue(resp.getWriter(), error("Invalid JSON: " + e.getMessage()));
            return;
        }

        String name = getString(body, "name");
        if (name == null || name.trim().isEmpty()) {
            resp.setStatus(400);
            mapper.writeValue(resp.getWriter(), error("'name' is required"));
            return;
        }

        List<?> mainboardRaw = (List<?>) body.get("mainboard");
        if (mainboardRaw == null || mainboardRaw.isEmpty()) {
            resp.setStatus(400);
            mapper.writeValue(resp.getWriter(), error("'mainboard' is required and must be non-empty"));
            return;
        }

        String formatStr = getString(body, "format");
        boolean isCommander = formatStr == null || !formatStr.equalsIgnoreCase("Constructed");

        // "commander" may be a String or a List of {name, qty} objects
        Object commanderRaw = body.get("commander");

        // Build the Forge deck
        Deck deck = new Deck(name.trim());

        // Add commander(s) if provided
        int commanderCount = 0;
        if (commanderRaw instanceof String) {
            String s = forgeName(((String) commanderRaw).trim());
            if (!s.isEmpty()) {
                deck.getOrCreate(DeckSection.Commander).add(s, 1);
                commanderCount = 1;
            }
        } else if (commanderRaw instanceof List) {
            for (Object entry : (List<?>) commanderRaw) {
                if (!(entry instanceof Map)) continue;
                Map<?, ?> card = (Map<?, ?>) entry;
                String cardName = getString(card, "name");
                int qty = getInt(card, "qty", 1);
                if (cardName == null || cardName.trim().isEmpty()) continue;
                deck.getOrCreate(DeckSection.Commander).add(forgeName(cardName.trim()), qty);
                commanderCount += qty;
            }
        }

        // Add mainboard cards
        int mainboardCount = 0;
        for (Object entry : mainboardRaw) {
            if (!(entry instanceof Map)) continue;
            Map<?, ?> card = (Map<?, ?>) entry;
            String cardName = getString(card, "name");
            int qty = getInt(card, "qty", 1);
            if (cardName == null || cardName.trim().isEmpty()) continue;
            deck.getOrCreate(DeckSection.Main).add(forgeName(cardName.trim()), qty);
            mainboardCount += qty;
        }

        // Save to appropriate storage
        IStorage<Deck> storage = isCommander
                ? FModel.getDecks().getCommander()
                : FModel.getDecks().getConstructed();

        // Remove existing deck with same name if present
        if (storage.contains(name.trim())) {
            storage.delete(name.trim());
        }
        storage.add(deck);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("success", true);
        result.put("name", deck.getName());
        result.put("commanderCount", commanderCount);
        result.put("mainboardCount", mainboardCount);
        mapper.writeValue(resp.getWriter(), result);
    }

    /** Strip MDFC back-face from names like "Cragcrown Pathway // Timbercrown Pathway" */
    private static String forgeName(String name) {
        if (name == null) return "";
        int idx = name.indexOf(" // ");
        return idx >= 0 ? name.substring(0, idx).trim() : name;
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
