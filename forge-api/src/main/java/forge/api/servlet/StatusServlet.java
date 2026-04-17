package forge.api.servlet;

import com.fasterxml.jackson.databind.ObjectMapper;
import forge.api.ForgeInitializer;

import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * GET /api/status
 * Returns server health and initialization state.
 */
public class StatusServlet extends HttpServlet {

    private static final ObjectMapper mapper = new ObjectMapper();

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        resp.setContentType("application/json");
        resp.setHeader("Access-Control-Allow-Origin", "*");

        Map<String, Object> status = new LinkedHashMap<>();
        status.put("status", "ok");
        status.put("forgeInitialized", ForgeInitializer.isInitialized());
        status.put("version", "2.0.12");

        mapper.writeValue(resp.getWriter(), status);
    }
}
