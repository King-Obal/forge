import { app, BrowserWindow, ipcMain } from 'electron/main';
import { spawn } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_PORT = 4567;
const API_BASE = 'http://localhost:' + API_PORT;
const JAR_PATH = path.join(__dirname, '..', 'forge-api', 'forge-api.jar');
const JAR_WORKDIR = path.join(__dirname, '..', 'forge-api');

let mainWindow = null;
let forgeProcess = null;

// ── Forge API process ──────────────────────────────────────────────────────

function startForgeApi() {
  console.log('[main] Starting Forge API server...');
  forgeProcess = spawn('java', ['-jar', JAR_PATH, String(API_PORT)], {
    cwd: JAR_WORKDIR,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  forgeProcess.stdout.on('data', (d) => process.stdout.write('[forge] ' + d));
  forgeProcess.stderr.on('data', (d) => process.stderr.write('[forge] ' + d));
  forgeProcess.on('exit', (code) => console.log('[main] Forge exited (' + code + ')'));
}

function pollUntilReady(retries = 60, interval = 2000) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      http.get(API_BASE + '/api/status', (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.forgeInitialized) return resolve();
          } catch (_) {}
          retry();
        });
      }).on('error', retry);
    };
    const retry = () => {
      if (++attempts >= retries) return reject(new Error('Forge API not ready'));
      setTimeout(check, interval);
    };
    check();
  });
}

// ── Window ─────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1923',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    title: 'Forge MTG'
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

function fetchJson(endpoint) {
  return new Promise((resolve, reject) => {
    http.get(API_BASE + endpoint, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function postJson(endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: 'localhost',
      port: API_PORT,
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── App lifecycle ──────────────────────────────────────────────────────────

await app.whenReady();

ipcMain.handle('api:get', (_, endpoint) => fetchJson(endpoint));
ipcMain.handle('api:post', (_, endpoint, body) => postJson(endpoint, body));

const win = createWindow();
win.loadFile(path.join(__dirname, 'src', 'loading.html'));

// Check if forge-api is already running (dev: started manually)
try {
  const status = await fetchJson('/api/status');
  if (status.forgeInitialized) {
    win.loadFile(path.join(__dirname, 'src', 'index.html'));
  } else {
    await pollUntilReady();
    win.loadFile(path.join(__dirname, 'src', 'index.html'));
  }
} catch (_) {
  startForgeApi();
  try {
    await pollUntilReady();
    win.loadFile(path.join(__dirname, 'src', 'index.html'));
  } catch (err) {
    console.error('[main] Forge API failed to start:', err.message);
  }
}

app.on('window-all-closed', () => {
  // Ask the API to shut down gracefully (works whether we spawned it or not)
  try {
    const req = http.request({ hostname: 'localhost', port: API_PORT, path: '/api/shutdown', method: 'POST' });
    req.on('error', () => {});
    req.end();
  } catch (_) {}
  // Also kill the child process if we spawned it
  if (forgeProcess) { forgeProcess.kill(); forgeProcess = null; }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
