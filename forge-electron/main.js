const { app, BrowserWindow, ipcMain, net } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const https = require('https');

const API_PORT = 4567;
const API_BASE = 'http://localhost:' + API_PORT;
const JAR_PATH = path.join(
  __dirname, '..', 'forge-api', 'target',
  'forge-api-2.0.12-SNAPSHOT-jar-with-dependencies.jar'
);
const JAR_WORKDIR = path.join(__dirname, '..', 'forge-api');

let mainWindow = null;
let forgeProcess = null;

// ── Forge API process ──────────────────────────────────────────────────────

function startForgeApi() {
  console.log('[main] Starting Forge API server...');
  const fs = require('fs');
  const logDir = path.join(JAR_WORKDIR, 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logStream = fs.createWriteStream(path.join(logDir, 'api.log'), { flags: 'w' });
  forgeProcess = spawn('java', ['-jar', JAR_PATH, String(API_PORT)], {
    cwd: JAR_WORKDIR,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  forgeProcess.stdout.on('data', function(d) { process.stdout.write('[forge] ' + d); logStream.write(d); });
  forgeProcess.stderr.on('data', function(d) { process.stderr.write('[forge] ' + d); logStream.write(d); });
  forgeProcess.on('exit', function(code) { console.log('[main] Forge exited (' + code + ')'); });
}

function pollUntilReady(retries, interval) {
  retries = retries || 60;
  interval = interval || 2000;
  return new Promise(function(resolve, reject) {
    var attempts = 0;
    function check() {
      http.get(API_BASE + '/api/status', function(res) {
        var data = '';
        res.on('data', function(c) { data += c; });
        res.on('end', function() {
          try {
            var json = JSON.parse(data);
            if (json.forgeInitialized) return resolve();
          } catch (e) {}
          retry();
        });
      }).on('error', retry);
    }
    function retry() {
      if (++attempts >= retries) return reject(new Error('Forge API not ready'));
      setTimeout(check, interval);
    }
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
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    },
    title: 'Forge MTG'
  });
  mainWindow.on('closed', function() { mainWindow = null; });
  return mainWindow;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

var HTTP_TIMEOUT_MS = 15000; // 15 s hard timeout on all API calls

function withTimeout(promise, ms, label) {
  var timer;
  var timeout = new Promise(function(_, reject) {
    timer = setTimeout(function() {
      reject(new Error((label || 'request') + ' timed out after ' + ms + 'ms'));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(function() { clearTimeout(timer); });
}

function fetchJson(endpoint) {
  return withTimeout(new Promise(function(resolve, reject) {
    http.get(API_BASE + endpoint, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  }), HTTP_TIMEOUT_MS, 'GET ' + endpoint);
}

function postJson(endpoint, body) {
  return withTimeout(new Promise(function(resolve, reject) {
    var payload = JSON.stringify(body);
    var opts = {
      hostname: 'localhost',
      port: API_PORT,
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    var req = http.request(opts, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  }), HTTP_TIMEOUT_MS, 'POST ' + endpoint);
}

function deleteJson(endpoint) {
  return withTimeout(new Promise(function(resolve, reject) {
    var opts = {
      hostname: 'localhost',
      port: API_PORT,
      path: endpoint,
      method: 'DELETE'
    };
    var req = http.request(opts, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); } catch (e) { resolve({}); }
      });
    });
    req.on('error', reject);
    req.end();
  }), HTTP_TIMEOUT_MS, 'DELETE ' + endpoint);
}

// ── Moxfield fetch ─────────────────────────────────────────────────────────

function fetchMoxfieldDeck(publicId) {
  // Use electron.net (Chromium network stack) to bypass Cloudflare TLS fingerprinting
  return new Promise(function(resolve, reject) {
    var req = net.request({
      method: 'GET',
      url: 'https://api2.moxfield.com/v2/decks/all/' + publicId
    });
    req.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    req.setHeader('Accept', 'application/json');
    req.setHeader('Accept-Language', 'en-US,en;q=0.9');
    req.on('response', function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var data = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error('Moxfield HTTP ' + res.statusCode + ': ' + data.slice(0, 200)));
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON invalide: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function moxfieldFormatToForge(fmt) {
  if (!fmt) return 'Commander';
  var map = { duelcommander: 'Commander', commander: 'Commander', constructed: 'Constructed',
               standard: 'Constructed', modern: 'Constructed', legacy: 'Constructed',
               vintage: 'Constructed', pioneer: 'Constructed', pauper: 'Constructed' };
  return map[fmt.toLowerCase()] || 'Commander';
}

// ── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(function() {

  // Register IPC handlers inside whenReady (recommended practice)
  ipcMain.handle('api:get', function(_, endpoint) {
    return fetchJson(endpoint);
  });
  ipcMain.handle('api:post', function(_, endpoint, body) {
    return postJson(endpoint, body);
  });
  ipcMain.handle('api:delete', function(_, endpoint) {
    return deleteJson(endpoint);
  });

  ipcMain.handle('api:import-moxfield', function(_, url, nameOverride) {
    // Extract publicId from URL like https://moxfield.com/decks/{publicId}
    var match = url.match(/moxfield\.com\/decks\/([A-Za-z0-9_-]+)/);
    if (!match) return Promise.reject(new Error('URL Moxfield invalide'));
    var publicId = match[1];
    return fetchMoxfieldDeck(publicId).then(function(d) {
      var format = moxfieldFormatToForge(d.format);
      function forgeName(n) { return n && n.includes(' // ') ? n.split(' // ')[0] : n; }
      var commanders = Object.values(d.commanders || {}).map(function(e) {
        return { name: forgeName(e.card.name), qty: e.quantity };
      });
      var mainboard = Object.values(d.mainboard || {}).map(function(e) {
        return { name: forgeName(e.card.name), qty: e.quantity };
      });
      return postJson('/api/decks/import', {
        name: nameOverride || d.name,
        format: format,
        commander: commanders,
        mainboard: mainboard
      });
    });
  });

  // Show loading screen immediately
  var win = createWindow();
  win.loadFile(path.join(__dirname, 'src', 'loading.html'));

  // Check if forge-api is already up (dev mode: started manually)
  fetchJson('/api/status').then(function(status) {
    if (status.forgeInitialized) {
      win.loadFile(path.join(__dirname, 'src', 'index.html'));
    } else {
      return pollUntilReady().then(function() {
        win.loadFile(path.join(__dirname, 'src', 'index.html'));
      });
    }
  }).catch(function() {
    startForgeApi();
    pollUntilReady().then(function() {
      win.loadFile(path.join(__dirname, 'src', 'index.html'));
    }).catch(function(err) {
      console.error('[main] Forge API failed to start:', err.message);
    });
  });

});

app.on('window-all-closed', function() {
  if (forgeProcess) forgeProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', function() {
  if (mainWindow === null) createWindow();
});
