package forge.api.servlet;

import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;

/**
 * POST /api/shutdown — gracefully stops the JVM.
 * Only accepts requests from localhost.
 */
public class ShutdownServlet extends HttpServlet {

    @Override
    protected void doOptions(HttpServletRequest req, HttpServletResponse resp) {
        resp.setHeader("Access-Control-Allow-Origin", "http://localhost");
        resp.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        resp.setStatus(HttpServletResponse.SC_OK);
    }

    @Override
    protected void doPost(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        String remoteAddr = req.getRemoteAddr();
        if (!"127.0.0.1".equals(remoteAddr) && !"::1".equals(remoteAddr) && !"0:0:0:0:0:0:0:1".equals(remoteAddr)) {
            resp.setStatus(HttpServletResponse.SC_FORBIDDEN);
            resp.getWriter().write("{\"error\":\"forbidden\"}");
            return;
        }
        resp.setContentType("application/json");
        resp.getWriter().write("{\"ok\":true}");
        resp.flushBuffer();
        System.out.println("[ForgeAPI] Shutdown requested by Electron — exiting.");
        new Thread(() -> {
            try { Thread.sleep(200); } catch (InterruptedException ignored) {}
            System.exit(0);
        }).start();
    }
}
