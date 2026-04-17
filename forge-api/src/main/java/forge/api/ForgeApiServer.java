package forge.api;

import forge.api.servlet.CardSearchServlet;
import forge.api.servlet.DecksServlet;
import forge.api.servlet.DeckDetailServlet;
import forge.api.servlet.GameServlet;
import forge.api.servlet.ImportDeckServlet;
import forge.api.servlet.ShutdownServlet;
import forge.api.servlet.SimulateServlet;
import forge.api.servlet.StatusServlet;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.servlet.DefaultServlet;
import org.eclipse.jetty.servlet.ServletContextHandler;
import org.eclipse.jetty.servlet.ServletHolder;

/**
 * Main entry point for the Forge API server.
 *
 * Usage:
 *   java -jar forge-api-jar-with-dependencies.jar [port]
 *   Default port: 4567
 *
 * Must be run from the forge-api/ directory so that ../forge-gui/ resolves correctly.
 *
 * Endpoints:
 *   GET  /api/status             - Health check
 *   GET  /api/decks              - List decks (?format=constructed|commander)
 *   POST /api/simulate           - Run AI vs AI game, returns log + winner
 */
public class ForgeApiServer {

    public static void main(String[] args) throws Exception {
        int port = 4567;
        if (args.length > 0) {
            try {
                port = Integer.parseInt(args[0]);
            } catch (NumberFormatException e) {
                System.err.println("Invalid port: " + args[0] + ", using default 4567");
            }
        }

        // Initialize Forge engine (blocking, ~30s on first run)
        ForgeInitializer.initialize();

        // Start Jetty
        Server server = new Server(port);

        ServletContextHandler context = new ServletContextHandler(ServletContextHandler.NO_SESSIONS);
        context.setContextPath("/");

        context.addServlet(new ServletHolder(new StatusServlet()),      "/api/status");
        context.addServlet(new ServletHolder(new DecksServlet()),       "/api/decks");
        context.addServlet(new ServletHolder(new SimulateServlet()),    "/api/simulate");
        context.addServlet(new ServletHolder(new ImportDeckServlet()),   "/api/decks/import");
        context.addServlet(new ServletHolder(new DeckDetailServlet()),  "/api/decks/detail");
        context.addServlet(new ServletHolder(new CardSearchServlet()),  "/api/cards/search");
        context.addServlet(new ServletHolder(new GameServlet()),        "/api/game/*");
        context.addServlet(new ServletHolder(new ShutdownServlet()),   "/api/shutdown");

        // Fallback for unknown paths
        context.addServlet(new ServletHolder(new DefaultServlet()), "/");

        server.setHandler(context);
        server.start();

        System.out.printf("[ForgeAPI] Server running on http://localhost:%d%n", port);
        System.out.println("[ForgeAPI] Endpoints:");
        System.out.println("[ForgeAPI]   GET  /api/status");
        System.out.println("[ForgeAPI]   GET  /api/decks");
        System.out.println("[ForgeAPI]   POST /api/simulate");
        System.out.println("[ForgeAPI]   POST /api/decks/import");
        System.out.println("[ForgeAPI]   POST /api/game/start");
        System.out.println("[ForgeAPI]   GET  /api/game/{id}/state");
        System.out.println("[ForgeAPI]   POST /api/game/{id}/respond");

        server.join();
    }
}
