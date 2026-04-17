package forge.api;

import forge.GuiDesktop;
import forge.gamemodes.match.HostedMatch;
import forge.gui.interfaces.IGuiGame;
import forge.localinstance.skin.FSkinProp;
import forge.localinstance.skin.ISkinImage;

import java.util.List;

/**
 * Headless implementation of GuiDesktop for the API server.
 * Suppresses all UI calls (dialogs, audio, skin) so Forge can run without a display.
 */
public class HeadlessGuiDesktop extends GuiDesktop {

    @Override
    public HostedMatch hostMatch() {
        return new HostedMatch();
    }

    @Override
    public IGuiGame getNewGuiGame() {
        return new HeadlessNetworkGuiGame();
    }

    @Override public void showSpellShop() {}
    @Override public void showBazaar() {}

    @Override
    public int showOptionDialog(String message, String title, FSkinProp icon,
                                List<String> options, int defaultOption) {
        return defaultOption;
    }

    @Override
    public void showImageDialog(ISkinImage image, String message, String title) {}

    @Override
    public String showInputDialog(String message, String title, FSkinProp icon,
                                  String initialInput, List<String> inputOptions, boolean isNumeric) {
        if (initialInput != null) return initialInput;
        if (inputOptions != null && !inputOptions.isEmpty()) return inputOptions.get(0);
        return isNumeric ? "0" : "";
    }

    @Override
    public String showFileDialog(String title, String defaultDir) { return null; }

    @Override
    public void showBugReportDialog(String title, String text, boolean showExitAppBtn) {
        System.err.println("[API] Bug Report - " + title + ": " + text);
    }

    @Override public forge.sound.IAudioClip createAudioClip(String filename) { return null; }
    @Override public forge.sound.IAudioMusic createAudioMusic(String filename) { return null; }
    @Override public void startAltSoundSystem(String filename, boolean isSynchronized) {}
}
