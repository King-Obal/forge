package forge.api.servlet;

import com.fasterxml.jackson.databind.ObjectMapper;
import forge.deck.Deck;
import forge.deck.DeckSection;
import forge.item.PaperCard;
import forge.model.FModel;
import forge.util.storage.IStorage;

import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.*;

/**
 * GET /api/decks/detail?name={name}&format={format}
 *
 * Returns the full card list for a deck.
 * Response: { "name": "...", "cards": [{ "name": "...", "qty": 1, "section": "Commander|Main" }] }
 */
public class DeckDetailServlet extends HttpServlet {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        resp.setContentType("application/json;charset=UTF-8");
        resp.setHeader("Access-Control-Allow-Origin", "*");

        String name   = req.getParameter("name");
        String format = req.getParameter("format");

        if (name == null || name.trim().isEmpty()) {
            resp.setStatus(400);
            MAPPER.writeValue(resp.getWriter(), Map.of("error", "name required"));
            return;
        }

        boolean isCommander = format == null || !format.equalsIgnoreCase("constructed");
        IStorage<Deck> storage = isCommander
                ? FModel.getDecks().getCommander()
                : FModel.getDecks().getConstructed();

        Deck deck = storage.get(name.trim());

        // Fallback: try both storages
        if (deck == null) {
            deck = FModel.getDecks().getCommander().get(name.trim());
        }
        if (deck == null) {
            deck = FModel.getDecks().getConstructed().get(name.trim());
        }
        if (deck == null) {
            resp.setStatus(404);
            MAPPER.writeValue(resp.getWriter(), Map.of("error", "deck not found: " + name));
            return;
        }

        List<Map<String, Object>> cards = new ArrayList<>();

        // Commander section
        if (deck.has(DeckSection.Commander)) {
            for (Map.Entry<PaperCard, Integer> e : deck.get(DeckSection.Commander)) {
                Map<String, Object> card = new LinkedHashMap<>();
                card.put("name", e.getKey().getName());
                card.put("qty", e.getValue());
                card.put("section", "Commander");
                cards.add(card);
            }
        }

        // Main section
        if (deck.has(DeckSection.Main)) {
            for (Map.Entry<PaperCard, Integer> e : deck.get(DeckSection.Main)) {
                Map<String, Object> card = new LinkedHashMap<>();
                card.put("name", e.getKey().getName());
                card.put("qty", e.getValue());
                card.put("section", "Main");
                cards.add(card);
            }
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("name", deck.getName());
        result.put("cards", cards);
        MAPPER.writeValue(resp.getWriter(), result);
    }
}
