package forge.api;

import forge.gui.GuiBase;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Handles one-time initialization of the Forge game engine.
 * FModel.initialize() loads all card scripts and takes ~30 seconds on first run.
 */
public class ForgeInitializer {

    private static final AtomicBoolean initialized = new AtomicBoolean(false);

    public static synchronized void initialize() {
        if (initialized.get()) return;

        System.out.println("[ForgeAPI] Setting up headless GUI...");
        GuiBase.setInterface(new HeadlessGuiDesktop());

        System.out.println("[ForgeAPI] Loading card database (this may take ~30 seconds)...");
        long start = System.currentTimeMillis();

        FModel.initialize(null, preferences -> {
            preferences.setPref(FPref.LOAD_CARD_SCRIPTS_LAZILY, false);
            preferences.setPref(FPref.UI_LANGUAGE, "en-US");
            return null;
        });

        long elapsed = System.currentTimeMillis() - start;
        System.out.printf("[ForgeAPI] Forge initialized in %.1f seconds.%n", elapsed / 1000.0);
        initialized.set(true);
    }

    public static boolean isInitialized() {
        return initialized.get();
    }
}
