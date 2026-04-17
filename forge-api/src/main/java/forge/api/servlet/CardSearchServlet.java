package forge.api.servlet;

import com.fasterxml.jackson.databind.ObjectMapper;
import forge.StaticData;
import forge.card.CardRules;
import forge.item.PaperCard;

import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.*;

/**
 * GET /api/cards/search?q=QUERY&limit=30
 * Returns unique cards whose name contains the query string (case-insensitive).
 */
public class CardSearchServlet extends HttpServlet {

    private static final ObjectMapper mapper = new ObjectMapper();

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        resp.setContentType("application/json");
        resp.setHeader("Access-Control-Allow-Origin", "*");

        String q = req.getParameter("q");
        int limit = 30;
        try { limit = Math.min(100, Integer.parseInt(req.getParameter("limit"))); } catch (Exception ignored) {}

        if (q == null || q.trim().isEmpty()) {
            mapper.writeValue(resp.getWriter(), Collections.emptyList());
            return;
        }

        final String query = q.trim().toLowerCase();
        final int maxResults = limit;

        List<Map<String, Object>> results = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();

        try {
            Collection<PaperCard> uniqueCards = StaticData.instance().getCommonCards().getUniqueCards();
            for (PaperCard card : uniqueCards) {
                String name = card.getName();
                if (!name.toLowerCase().contains(query)) continue;
                if (seen.contains(name)) continue;
                seen.add(name);

                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("name", name);
                CardRules rules = card.getRules();
                if (rules != null) {
                    entry.put("manaCost", rules.getManaCost() != null ? rules.getManaCost().toString() : "");
                    entry.put("type", rules.getType() != null ? rules.getType().toString() : "");
                    entry.put("text", rules.getOracleText() != null ? rules.getOracleText() : "");
                } else {
                    entry.put("manaCost", "");
                    entry.put("type", "");
                    entry.put("text", "");
                }
                results.add(entry);
            }
        } catch (Exception e) {
            resp.setStatus(500);
            Map<String, Object> err = new LinkedHashMap<>();
            err.put("error", e.getMessage());
            mapper.writeValue(resp.getWriter(), err);
            return;
        }

        // Sort: exact match first, then starts-with, then contains — all alphabetical within each group
        results.sort((a, b) -> {
            String na = ((String) a.get("name")).toLowerCase();
            String nb = ((String) b.get("name")).toLowerCase();
            int ra = na.equals(query) ? 0 : na.startsWith(query) ? 1 : 2;
            int rb = nb.equals(query) ? 0 : nb.startsWith(query) ? 1 : 2;
            if (ra != rb) return ra - rb;
            return na.compareTo(nb);
        });
        List<Map<String, Object>> paged = results.size() > maxResults ? results.subList(0, maxResults) : results;
        mapper.writeValue(resp.getWriter(), paged);
    }
}
