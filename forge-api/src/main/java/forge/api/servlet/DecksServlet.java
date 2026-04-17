package forge.api.servlet;

import com.fasterxml.jackson.databind.ObjectMapper;
import forge.deck.Deck;
import forge.model.FModel;
import forge.util.storage.IStorage;

import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.*;

/**
 * GET /api/decks?format=constructed  (default: constructed)
 * GET /api/decks?format=commander
 *
 * Returns a list of available deck names.
 */
public class DecksServlet extends HttpServlet {

    private static final ObjectMapper mapper = new ObjectMapper();

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        resp.setContentType("application/json");
        resp.setHeader("Access-Control-Allow-Origin", "*");

        String format = req.getParameter("format");

        Iterable<Deck> deckStorage;
        if ("commander".equalsIgnoreCase(format)) {
            deckStorage = FModel.getDecks().getCommander();
        } else {
            deckStorage = FModel.getDecks().getConstructed();
        }

        List<Map<String, String>> decks = new ArrayList<>();
        for (Deck d : deckStorage) {
            Map<String, String> entry = new LinkedHashMap<>();
            entry.put("name", d.getName());
            entry.put("description", d.getComment() != null ? d.getComment() : "");
            decks.add(entry);
        }

        decks.sort(Comparator.comparing(m -> m.get("name")));
        mapper.writeValue(resp.getWriter(), decks);
    }

    @Override
    protected void doDelete(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        resp.setContentType("application/json");
        resp.setHeader("Access-Control-Allow-Origin", "*");

        String name = req.getParameter("name");
        String format = req.getParameter("format");

        if (name == null || name.trim().isEmpty()) {
            resp.setStatus(400);
            Map<String, Object> err = new LinkedHashMap<>();
            err.put("error", "name required");
            mapper.writeValue(resp.getWriter(), err);
            return;
        }

        boolean isCommander = !"constructed".equalsIgnoreCase(format);
        IStorage<Deck> primary = isCommander
                ? FModel.getDecks().getCommander()
                : FModel.getDecks().getConstructed();
        IStorage<Deck> fallback = isCommander
                ? FModel.getDecks().getConstructed()
                : FModel.getDecks().getCommander();

        IStorage<Deck> target = primary.contains(name.trim()) ? primary
                : (fallback.contains(name.trim()) ? fallback : null);

        if (target == null) {
            resp.setStatus(404);
            Map<String, Object> err = new LinkedHashMap<>();
            err.put("error", "deck not found");
            mapper.writeValue(resp.getWriter(), err);
            return;
        }

        target.delete(name.trim());
        Map<String, Object> ok = new LinkedHashMap<>();
        ok.put("ok", true);
        mapper.writeValue(resp.getWriter(), ok);
    }

    @Override
    protected void doOptions(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        resp.setHeader("Access-Control-Allow-Origin", "*");
        resp.setHeader("Access-Control-Allow-Methods", "GET, DELETE, OPTIONS");
        resp.setStatus(204);
    }
}
