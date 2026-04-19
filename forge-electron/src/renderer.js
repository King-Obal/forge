'use strict';

// ── Tab navigation ────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('view-' + tab.dataset.view).classList.add('active');
    if (tab.dataset.view === 'builder') initBuilderView();
  });
});



// ── Helpers ───────────────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Deck import ───────────────────────────────────────────────────────────
const modalImport    = document.getElementById('modal-import');
const modalError     = document.getElementById('modal-error');
const btnImport      = document.getElementById('btn-import-moxfield');
const btnModalImport = document.getElementById('btn-modal-import');
const btnModalCancel = document.getElementById('btn-modal-cancel');
const parsePreview   = document.getElementById('parse-preview');

// Tab switching
document.querySelectorAll('.modal-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.modal-tab-content').forEach(c => c.classList.add('hidden'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.remove('hidden');
  });
});

// Open modal
btnImport.addEventListener('click', () => {
  document.getElementById('text-deck-name').value = '';
  document.getElementById('deck-text-input').value = '';
  document.getElementById('moxfield-url').value = '';
  parsePreview.textContent = '';
  modalError.classList.add('hidden');
  // Reset to text tab
  document.querySelectorAll('.modal-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === 'text'));
  document.querySelectorAll('.modal-tab-content').forEach(c =>
    c.classList.toggle('hidden', c.id !== 'tab-text'));
  modalImport.classList.remove('hidden');
  document.getElementById('text-deck-name').focus();
});

btnModalCancel.addEventListener('click', () => modalImport.classList.add('hidden'));
modalImport.addEventListener('click', e => { if (e.target === modalImport) modalImport.classList.add('hidden'); });

// Auto-preview on paste
document.getElementById('deck-text-input').addEventListener('input', () => {
  const { mainboard, commanders } = parseDeckList(document.getElementById('deck-text-input').value);
  if (!mainboard.length && !commanders.length) { parsePreview.innerHTML = ''; return; }
  const total = mainboard.reduce((s, c) => s + c.qty, 0);
  const cmdNames = commanders.map(c =>
    `<span class="cmd-name" data-card="${esc(c.name)}">${esc(c.name)}</span>`).join(', ');
  parsePreview.innerHTML = commanders.length
    ? `${total} cards &middot; Commander: ${cmdNames}`
    : `${total} cards`;
});

// Import button
btnModalImport.addEventListener('click', async () => {
  const activeTab = document.querySelector('.modal-tab.active').dataset.tab;
  activeTab === 'text' ? await importFromText() : await importFromMoxfield();
});

function parseDeckList(text) {
  const parseCards = arr => arr
    .map(l => { const m = l.match(/^(\d+)\s+(.+)$/); return m ? { qty: parseInt(m[1]), name: m[2].trim() } : null; })
    .filter(Boolean);
  const lines = text.split('\n').map(l => l.trim()).filter(l => !l.startsWith('//'));
  const sections = [];
  let cur = [];
  for (const line of lines) {
    if (line === '') { if (cur.length) { sections.push(cur); cur = []; } }
    else cur.push(line);
  }
  if (cur.length) sections.push(cur);
  if (!sections.length) return { mainboard: [], commanders: [] };
  if (sections.length === 1) return { mainboard: parseCards(sections[0]), commanders: [] };
  return {
    mainboard:  sections.slice(0, -1).flatMap(parseCards),
    commanders: parseCards(sections[sections.length - 1])
  };
}

async function importFromText() {
  const name = document.getElementById('text-deck-name').value.trim();
  const text = document.getElementById('deck-text-input').value.trim();
  if (!name) { showModalError('Entrez un nom de deck.'); return; }
  if (!text) { showModalError('Collez une liste de deck.'); return; }
  const { mainboard, commanders } = parseDeckList(text);
  if (!mainboard.length && !commanders.length) { showModalError('Aucune carte reconnue.'); return; }

  btnModalImport.disabled = true;
  btnModalImport.textContent = '⏳ Importing…';
  modalError.classList.add('hidden');

  const payload = {
    name,
    format: commanders.length ? 'Commander' : 'Constructed',
    commander: commanders.map(c => ({ name: c.name, qty: c.qty })),
    mainboard:  mainboard.map(c => ({ name: c.name, qty: c.qty }))
  };

  try {
    const result = await window.forgeApi.post('/api/decks/import', payload);
    modalImport.classList.add('hidden');
    await loadDecks(formatSelect.value);
    btnSimulate.textContent = `✓ "${result.name}" importé`;
    setTimeout(() => { btnSimulate.textContent = '▶ Run Simulation'; }, 3000);
  } catch (err) {
    showModalError(err.message || String(err));
  } finally {
    btnModalImport.disabled = false;
    btnModalImport.textContent = 'Import';
  }
}

async function importFromMoxfield() {
  const url = document.getElementById('moxfield-url').value.trim();
  if (!url) return;

  btnModalImport.disabled = true;
  btnModalImport.textContent = '⏳ Importing…';
  modalError.classList.add('hidden');

  try {
    const result = await window.forgeApi.importMoxfield(url);
    modalImport.classList.add('hidden');
    await loadDecks(formatSelect.value);
    btnSimulate.textContent = `✓ "${result.name}" importé`;
    setTimeout(() => { btnSimulate.textContent = '▶ Run Simulation'; }, 3000);
  } catch (err) {
    showModalError(err.message || String(err));
  } finally {
    btnModalImport.disabled = false;
    btnModalImport.textContent = 'Import';
  }
}

function showModalError(msg) {
  modalError.textContent = msg;
  modalError.classList.remove('hidden');
}

// ── Scryfall hover tooltip ─────────────────────────────────────────────────
const cardTooltip    = document.getElementById('card-tooltip');
const cardTooltipImg = document.getElementById('card-tooltip-img');
const scryfallCache  = new Map();
let tooltipTimer     = null;

async function fetchCardImage(name, isToken = false) {
  const cacheKey = (isToken ? 'token:' : '') + name;
  if (scryfallCache.has(cacheKey)) return scryfallCache.get(cacheKey);
  // Check persistent localStorage cache first
  try {
    const stored = localStorage.getItem('sf:' + cacheKey);
    if (stored !== null) {
      const url = stored || null;
      scryfallCache.set(cacheKey, url);
      return url;
    }
  } catch { /* localStorage not available */ }
  // Fetch from Scryfall
  try {
    let r, d, img;
    if (isToken) {
      // Forge names tokens "Foo Token" but Scryfall names them "Foo" — strip the suffix
      const sfName = name.endsWith(' Token') ? name.slice(0, -6) : name;
      // First try: exact name + type:token
      r = await fetch('https://api.scryfall.com/cards/search?q=is%3Atoken+!%22'
        + encodeURIComponent(sfName) + '%22&unique=cards&order=released&dir=desc');
      if (r.ok) {
        d = await r.json();
        img = d.data?.[0]?.image_uris?.normal ?? d.data?.[0]?.card_faces?.[0]?.image_uris?.normal ?? null;
      }
      // Fallback: search without exact-name constraint (first token matching the name)
      if (!img) {
        r = await fetch('https://api.scryfall.com/cards/search?q=is%3Atoken+%22'
          + encodeURIComponent(sfName) + '%22&unique=cards&order=released&dir=desc');
        if (r.ok) {
          d = await r.json();
          img = d.data?.[0]?.image_uris?.normal ?? d.data?.[0]?.card_faces?.[0]?.image_uris?.normal ?? null;
        }
      }
    } else {
      r = await fetch('https://api.scryfall.com/cards/named?exact=' + encodeURIComponent(name));
      if (r.ok) {
        d = await r.json();
        // Store full object so builder can read type_line / cmc
        scryfallCards.set(name, d);
        if (name.includes(' // ')) {
          for (const face of name.split(' // ')) scryfallCards.set(face.trim(), d);
        }
        img = sfFaceImg(d, name) || null;
      }
    }
    scryfallCache.set(cacheKey, img ?? null);
    // Only persist successes to localStorage — failures stay in-memory only so next session retries
    if (img) {
      try { localStorage.setItem('sf:' + cacheKey, img); } catch { /* ignore storage full */ }
    }
    return img ?? null;
  } catch { scryfallCache.set(cacheKey, null); return null; }
}

// Universal hover tooltip — uses elementFromPoint (works in all modals/panels)
let _ttCardEl = null;
document.addEventListener('pointermove', e => {
  // elementFromPoint skips pointer-events:none elements (like the tooltip itself)
  const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-card]') ?? null;

  // Move tooltip if already visible
  if (cardTooltip.style.display === 'block') {
    const x = e.clientX + 16, y = e.clientY - 16;
    const w = cardTooltip.offsetWidth, h = cardTooltip.offsetHeight;
    cardTooltip.style.left = (x + w > window.innerWidth  ? e.clientX - w - 16 : x) + 'px';
    cardTooltip.style.top  = (y + h > window.innerHeight ? window.innerHeight - h - 8 : y) + 'px';
  }

  if (el === _ttCardEl) return; // same card, nothing to do
  _ttCardEl = el;
  clearTimeout(tooltipTimer);
  cardTooltip.style.display = 'none';
  if (!el) return;

  tooltipTimer = setTimeout(async () => {
    const img = await fetchCardImage(el.dataset.card, el.dataset.isToken === '1');
    if (_ttCardEl !== el) return; // mouse moved elsewhere during async fetch
    if (!img) return;
    cardTooltipImg.src = img;
    cardTooltip.classList.add('card-tooltip-large');
    cardTooltip.style.display = 'block';
  }, 120);
});

// ── Deck View ─────────────────────────────────────────────────────────────
const deckViewFormat = document.getElementById('deck-view-format');
const deckViewSelect = document.getElementById('deck-view-select');
const deckGrid       = document.getElementById('deck-grid');
let   deckGroupBy    = 'type';
let   scryfallCards  = new Map(); // name → scryfall data

// Populate deck selector when format changes
deckViewFormat.addEventListener('change', () => populateDeckViewSelect());

deckViewSelect.addEventListener('change', () => {
  const name = deckViewSelect.value;
  if (name) loadDeckView(name, deckViewFormat.value);
});

document.querySelectorAll('.group-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.group-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    deckGroupBy = btn.dataset.group;
    renderDeckGrid();
  });
});

// Populate the deck-view select from API
async function populateDeckViewSelect() {
  const fmt = deckViewFormat.value;
  try {
    const decks = await window.forgeApi.get('/api/decks?format=' + fmt.toLowerCase());
    deckViewSelect.innerHTML = '<option value="">— Select a deck —</option>'
      + decks.map(d => `<option value="${esc(d.name)}">${esc(d.name)}</option>`).join('');
  } catch { /* silent */ }
}

// When Decks tab becomes active, populate if empty
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (tab.dataset.view === 'decks' && deckViewSelect.options.length <= 1) {
      populateDeckViewSelect();
    }
  });
});

let currentDeckCards = [];

async function loadDeckView(name, format) {
  deckGrid.innerHTML = '<div class="deck-loading">Loading deck…</div>';
  try {
    const data = await window.forgeApi.get(
      '/api/decks/detail?name=' + encodeURIComponent(name) + '&format=' + format.toLowerCase()
    );
    currentDeckCards = data.cards || [];
    deckGrid.innerHTML = '<div class="deck-loading">Fetching card images…</div>';
    await fetchScryfallBatch(currentDeckCards.map(c => c.name));
    renderDeckGrid();
  } catch (err) {
    deckGrid.innerHTML = `<div class="deck-empty">Error: ${esc(err.message)}</div>`;
  }
}

async function fetchScryfallBatch(names) {
  const toFetch = [...new Set(names)].filter(n => !scryfallCards.has(n));
  if (!toFetch.length) return;
  for (let i = 0; i < toFetch.length; i += 75) {
    const batch = toFetch.slice(i, i + 75);
    // For MDFCs, Scryfall batch doesn't accept "A // B" format — send only the front face name
    const identifiers = batch.map(n => ({ name: n.includes(' // ') ? n.split(' // ')[0].trim() : n }));
    try {
      const r = await fetch('https://api.scryfall.com/cards/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers })
      });
      if (!r.ok) continue;
      const d = await r.json();
      for (const card of d.data || []) {
        scryfallCards.set(card.name, card);
        // Index each face name individually
        if (card.name.includes(' // ')) {
          for (const face of card.name.split(' // '))
            scryfallCards.set(face.trim(), card);
        }
      }
    } catch { /* fallback to text tile */ }
    // Also index original Forge MDFC names ("A // B") → front face lookup
    for (const origName of batch) {
      if (origName.includes(' // ') && !scryfallCards.has(origName)) {
        const card = scryfallCards.get(origName.split(' // ')[0].trim());
        if (card) scryfallCards.set(origName, card);
      }
    }
    if (i + 75 < toFetch.length) await new Promise(res => setTimeout(res, 100));
  }
}

function getMainType(sf) {
  // For MDFCs, use the front face type_line (avoids "Battle // Land" → 'Land' misclassification)
  const typeLine = sf?.card_faces?.[0]?.type_line ?? sf?.type_line ?? '';
  for (const t of ['Land', 'Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Enchantment', 'Artifact'])
    if (typeLine.includes(t)) return t;
  return 'Other';
}

function renderDeckGrid() {
  if (!currentDeckCards.length) {
    deckGrid.innerHTML = '<div class="deck-empty">Deck is empty.</div>';
    return;
  }
  const commanders = currentDeckCards.filter(c => c.section === 'Commander');
  const main       = currentDeckCards.filter(c => c.section !== 'Commander');

  const typeOrder  = ['Land','Creature','Planeswalker','Battle','Instant','Sorcery','Enchantment','Artifact','Other'];
  const colorOrder = ['W','U','B','R','G','Multicolor','Colorless'];
  const cmcOrder   = ['0','1','2','3','4','5','6+'];

  const getCmc  = sf => { const v = sf?.cmc ?? 0; return v >= 6 ? '6+' : String(Math.floor(v)); };
  const getColor = sf => { const c = sf?.colors ?? []; return c.length === 0 ? 'Colorless' : c.length > 1 ? 'Multicolor' : c[0]; };

  let html = '';

  if (commanders.length) {
    const count = commanders.reduce((s, c) => s + c.qty, 0);
    html += `<div class="card-group"><h3 class="group-header">Commander <span class="group-count">(${count})</span></h3><div class="card-row">`;
    for (const c of commanders) html += cardTile(c);
    html += '</div></div>';
  }

  if (deckGroupBy === 'type+cmc') {
    // Nested: group by type, sub-group by CMC
    const typeGroups = new Map();
    for (const card of main) {
      const sf = scryfallCards.get(card.name);
      const typeKey = getMainType(sf);
      const cmcKey  = getCmc(sf);
      if (!typeGroups.has(typeKey)) typeGroups.set(typeKey, new Map());
      const cmcMap = typeGroups.get(typeKey);
      if (!cmcMap.has(cmcKey)) cmcMap.set(cmcKey, []);
      cmcMap.get(cmcKey).push(card);
    }
    const sortedTypes = typeOrder.filter(k => typeGroups.has(k));
    for (const k of typeGroups.keys()) if (!sortedTypes.includes(k)) sortedTypes.push(k);

    for (const typeKey of sortedTypes) {
      const cmcMap = typeGroups.get(typeKey);
      const typeTotal = [...cmcMap.values()].flat().reduce((s, c) => s + c.qty, 0);
      html += `<div class="card-group card-group-nested"><h3 class="group-header">${esc(typeKey)} <span class="group-count">(${typeTotal})</span></h3>`;
      const sortedCmc = cmcOrder.filter(k => cmcMap.has(k));
      for (const k of cmcMap.keys()) if (!sortedCmc.includes(k)) sortedCmc.push(k);
      for (const cmcKey of sortedCmc) {
        const cards = cmcMap.get(cmcKey);
        const subTotal = cards.reduce((s, c) => s + c.qty, 0);
        html += `<div class="card-subgroup"><span class="subgroup-label">CMC ${esc(cmcKey)} <span class="group-count">(${subTotal})</span></span><div class="card-row">`;
        for (const c of cards) html += cardTile(c);
        html += '</div></div>';
      }
      html += '</div>';
    }
  } else {
    const groups = new Map();
    for (const card of main) {
      const sf = scryfallCards.get(card.name);
      let key;
      if (deckGroupBy === 'cmc')   key = getCmc(sf);
      else if (deckGroupBy === 'color') key = getColor(sf);
      else key = getMainType(sf);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(card);
    }
    const sortedKeys = (deckGroupBy === 'cmc' ? cmcOrder : deckGroupBy === 'color' ? colorOrder : typeOrder)
      .filter(k => groups.has(k));
    for (const k of groups.keys()) if (!sortedKeys.includes(k)) sortedKeys.push(k);

    for (const key of sortedKeys) {
      const cards = groups.get(key);
      const label = deckGroupBy === 'cmc' ? `CMC ${key}` : key;
      const total = cards.reduce((s, c) => s + c.qty, 0);
      html += `<div class="card-group"><h3 class="group-header">${esc(label)} <span class="group-count">(${total})</span></h3><div class="card-row">`;
      for (const c of cards) html += cardTile(c);
      html += '</div></div>';
    }
  }
  deckGrid.innerHTML = html;
}

function cardTile(card) {
  const sf  = scryfallCards.get(card.name);
  const img = sfFaceImg(sf, card.name);
  const qty = card.qty > 1 ? `<span class="card-qty">${card.qty}</span>` : '';
  if (img) {
    return `<div class="card-tile" data-card="${esc(card.name)}">${qty}<img src="${esc(img)}" alt="${esc(card.name)}" loading="lazy"></div>`;
  }
  return `<div class="card-tile card-tile-noimg" data-card="${esc(card.name)}">${qty}<span class="card-name-text">${esc(card.name)}</span></div>`;
}

// ── Init ──────────────────────────────────────────────────────────────────
loadDecks('Constructed');

// ── PLAY VIEW ─────────────────────────────────────────────────────────────

// Populate play deck selectors when the Play tab is activated
document.querySelector('.tab[data-view="play"]').addEventListener('click', () => {
  populatePlayDecks();
});

document.getElementById('play-format').addEventListener('change', populatePlayDecks);

async function populatePlayDecks() {
  const fmt = document.getElementById('play-format').value;
  const [s1, s2] = ['play-deck1', 'play-deck2'].map(id => document.getElementById(id));
  [s1, s2].forEach(s => { s.innerHTML = '<option value="">Loading…</option>'; s.disabled = true; });
  try {
    const decks = await window.forgeApi.get('/api/decks?format=' + fmt.toLowerCase());
    [s1, s2].forEach((s, i) => {
      s.innerHTML = decks.length
        ? decks.map(d => `<option value="${esc(d.name)}">${esc(d.name)}</option>`).join('')
        : '<option value="">No decks found</option>';
      s.disabled = !decks.length;
      if (i === 1 && decks.length >= 2) s.selectedIndex = 1;
    });
  } catch (e) {
    [s1, s2].forEach(s => { s.innerHTML = '<option value="">Error</option>'; });
  }
}

// ── Inline deck import (play setup) ───────────────────────────────────────

(function initPlayImport() {
  const panel     = document.getElementById('play-import-panel');
  const nameInput = document.getElementById('play-import-name');
  const urlInput  = document.getElementById('play-import-url');
  const textArea  = document.getElementById('play-import-text');
  const statusEl  = document.getElementById('play-import-status');
  const okBtn     = document.getElementById('btn-play-import-ok');
  const cancelBtn = document.getElementById('btn-play-import-cancel');
  const tabs      = document.querySelectorAll('.play-import-tab');
  const moxWrap   = document.getElementById('play-import-moxfield-wrap');
  const textWrap  = document.getElementById('play-import-text-wrap');

  let targetSlot = 1; // which deck select to populate after import
  let mode = 'moxfield';

  // Open panel when "+" clicked
  document.querySelectorAll('.btn-import-inline').forEach(btn => {
    btn.addEventListener('click', () => {
      targetSlot = parseInt(btn.dataset.target);
      panel.classList.remove('hidden');
      nameInput.value = '';
      urlInput.value = '';
      textArea.value = '';
      statusEl.textContent = '';
      statusEl.className = 'play-import-status';
      nameInput.focus();
    });
  });

  // Tabs
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      mode = tab.dataset.mode;
      moxWrap.classList.toggle('hidden', mode !== 'moxfield');
      textWrap.classList.toggle('hidden', mode !== 'text');
    });
  });

  cancelBtn.addEventListener('click', () => panel.classList.add('hidden'));

  okBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name && mode === 'text') { setStatus('⚠ Nom du deck requis pour liste.', 'error'); return; }

    okBtn.disabled = true;
    okBtn.textContent = '⏳…';
    setStatus('Import en cours…', '');

    try {
      let result;
      if (mode === 'moxfield') {
        const url = urlInput.value.trim();
        if (!url) { setStatus('⚠ URL manquante.', 'error'); return; }
        result = await window.forgeApi.importMoxfield(url);
      } else {
        const text = textArea.value.trim();
        if (!text) { setStatus('⚠ Liste vide.', 'error'); return; }
        result = await importTextDeck(name, text);
      }
      setStatus('✓ Deck importé : ' + result.name, 'ok');
      // Refresh decks and auto-select the imported deck
      await populatePlayDecks();
      const sel = document.getElementById('play-deck' + targetSlot);
      for (const opt of sel.options) {
        if (opt.value === result.name) { sel.value = result.name; break; }
      }
      setTimeout(() => panel.classList.add('hidden'), 800);
    } catch (e) {
      setStatus('✗ ' + (e.message || String(e)), 'error');
    } finally {
      okBtn.disabled = false;
      okBtn.textContent = 'Importer';
    }
  });

  function setStatus(msg, cls) {
    statusEl.textContent = msg;
    statusEl.className = 'play-import-status' + (cls ? ' ' + cls : '');
  }

  async function importTextDeck(name, text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//'));
    const sections = [];
    let cur = [];
    for (const line of lines) {
      if (line === '') { if (cur.length) { sections.push(cur); cur = []; } }
      else cur.push(line);
    }
    if (cur.length) sections.push(cur);
    function parseCards(arr) {
      return arr.map(l => {
        const m = l.match(/^(\d+)x?\s+(.+)/);
        return m ? { name: m[2].trim(), qty: parseInt(m[1]) } : { name: l, qty: 1 };
      });
    }
    const isCommander = sections.length >= 2;
    const mainboard   = sections.length >= 2 ? sections.slice(0, -1).flatMap(parseCards) : parseCards(sections[0] || []);
    const commanders  = sections.length >= 2 ? parseCards(sections[sections.length - 1]) : [];
    return window.forgeApi.post('/api/decks/import', {
      name,
      format: isCommander ? 'Commander' : 'Constructed',
      commander: commanders,
      mainboard
    });
  }
})();

let playSession = null;
let playPollTimer = null;
let playState = null;
// BO3 match state
let matchState = null; // { game, wins: {p1:0,p2:0}, deck1, deck2, format, p1Name, p2Name }
let selectedHandCards = []; // for future multi-select (currently single)

document.getElementById('btn-play-start').addEventListener('click', startPlayGame);
document.getElementById('btn-play-stop').addEventListener('click', stopPlayGame);
document.getElementById('btn-concede').addEventListener('click', concedeGame);
document.getElementById('btn-pass-priority').addEventListener('click', () => sendDecision({ choice: 'pass' }));

// ── Auto-pass EOT toggle ───────────────────────────────────────────────────
let autoPassEOT = false;
const autoPassBtn = document.getElementById('auto-pass-eot-btn');
autoPassBtn.addEventListener('click', () => {
  autoPassEOT = !autoPassEOT;
  autoPassBtn.classList.toggle('active', autoPassEOT);
});
document.getElementById('zone-viewer-close').addEventListener('click', () =>
  document.getElementById('zone-viewer-modal').classList.add('hidden'));
document.getElementById('zone-viewer-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('zone-viewer-modal'))
    document.getElementById('zone-viewer-modal').classList.add('hidden');
});
document.getElementById('ability-popup').addEventListener('click', e => {
  if (e.target === document.getElementById('ability-popup')) hideAbilityPopup();
});

async function startPlayGame() {
  const deck1 = document.getElementById('play-deck1').value;
  const deck2 = document.getElementById('play-deck2').value;
  const format = document.getElementById('play-format').value;
  const errEl = document.getElementById('play-error');
  errEl.classList.add('hidden');

  if (!deck1 || !deck2) {
    errEl.textContent = 'Please select both decks.';
    errEl.classList.remove('hidden');
    return;
  }

  const btn = document.getElementById('btn-play-start');
  btn.disabled = true;
  btn.textContent = 'Starting…';

  const isDebug = document.getElementById('play-debug-mode')?.checked || false;

  try {
    const startBody = { deck1, deck2, format };
    if (isDebug) startBody.debug = true;
    const result = await window.forgeApi.post('/api/game/start', startBody);
    playSession = result.sessionId;
    pausePolling = false;
    document.querySelectorAll('#coin-modal,#arrange-modal').forEach(m => m.remove());
    matchState = { game: 1, wins: { 'Player 1': 0, 'AI': 0 },
                   deck1, deck2, format,
                   p1Name: result.player1 || 'Player 1', p2Name: result.player2 || 'AI',
                   debug: result.debug || false };
    document.getElementById('play-setup').classList.add('hidden');
    document.getElementById('play-board').classList.remove('hidden');
    const debugBar = document.getElementById('debug-bar');
    if (debugBar) debugBar.classList.toggle('hidden', !result.debug);
    updateMatchScore();
    startPolling();
    prefetchDeckImages(deck1, format);
    prefetchDeckImages(deck2, format);
  } catch (e) {
    errEl.textContent = 'Failed to start game: ' + (e.message || e);
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Start Game';
  }
}

// ── Debug bar ────────────────────────────────────────────────────────────────

async function debugSearchCard(title) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'debug-search-modal';
    overlay.innerHTML = `
      <div class="debug-search-inner">
        <h3>${title}</h3>
        <input id="dbg-search-inp" class="debug-search-input" type="text" placeholder="Nom de la carte..." autocomplete="off">
        <div id="dbg-search-list" class="debug-search-list"></div>
        <div class="debug-search-footer">
          <button id="dbg-search-cancel" class="btn-secondary btn-sm">Annuler</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const inp = overlay.querySelector('#dbg-search-inp');
    const list = overlay.querySelector('#dbg-search-list');
    const cancel = overlay.querySelector('#dbg-search-cancel');
    let searchTimer = null;

    cancel.addEventListener('click', () => { overlay.remove(); resolve(null); });
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(null); } });

    inp.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = inp.value.trim();
      if (q.length < 2) { list.innerHTML = ''; return; }
      searchTimer = setTimeout(async () => {
        try {
          const data = await window.forgeApi.get('/api/cards/search?q=' + encodeURIComponent(q) + '&limit=20');
          list.innerHTML = '';
          const items = Array.isArray(data) ? data : (data.results || []);
          for (const entry of items) {
            const name = typeof entry === 'string' ? entry : entry.name;
            const item = document.createElement('div');
            item.className = 'debug-search-item';
            item.textContent = name;
            item.dataset.card = name;
            item.addEventListener('click', () => { overlay.remove(); resolve(name); });
            list.appendChild(item);
          }
        } catch { list.innerHTML = '<div style="color:#888;font-size:0.75rem;padding:4px 8px">Erreur de recherche</div>'; }
      }, 180);
    });

    inp.focus();
  });
}

document.getElementById('debug-add-hand')?.addEventListener('click', async () => {
  const card = await debugSearchCard('Ajouter en main');
  if (!card || !playSession) return;
  try { await window.forgeApi.post('/api/game/' + playSession + '/debug/add-card', { card, zone: 'hand', player: 0 }); }
  catch (e) { alert('Erreur debug: ' + (e.message || e)); }
});

document.getElementById('debug-add-bf')?.addEventListener('click', async () => {
  const card = await debugSearchCard('Ajouter sur le champ de bataille');
  if (!card || !playSession) return;
  try { await window.forgeApi.post('/api/game/' + playSession + '/debug/add-card', { card, zone: 'battlefield', player: 0 }); }
  catch (e) { alert('Erreur debug: ' + (e.message || e)); }
});

document.getElementById('debug-add-opp-bf')?.addEventListener('click', async () => {
  const card = await debugSearchCard('Ajouter sur le champ (adversaire)');
  if (!card || !playSession) return;
  try { await window.forgeApi.post('/api/game/' + playSession + '/debug/add-card', { card, zone: 'battlefield', player: 1 }); }
  catch (e) { alert('Erreur debug: ' + (e.message || e)); }
});

document.getElementById('debug-set-life')?.addEventListener('click', async () => {
  if (!playSession) return;
  const val = prompt('Nouveaux points de vie (Player 1) :', '40');
  if (val === null) return;
  const life = parseInt(val, 10);
  if (isNaN(life) || life < 0) { alert('Valeur invalide'); return; }
  try { await window.forgeApi.post('/api/game/' + playSession + '/debug/set-life', { player: 0, life }); }
  catch (e) { alert('Erreur debug: ' + (e.message || e)); }
});

function updateMatchScore() {
  const el = document.getElementById('match-score');
  if (!el || !matchState) return;
  const p1w = matchState.wins[matchState.p1Name] || 0;
  const p2w = matchState.wins[matchState.p2Name] || 0;
  el.textContent = `BO3 — Game ${matchState.game} — ${matchState.p1Name} ${p1w} · ${p2w} ${matchState.p2Name}`;
}

// Prefetch all card images for a deck into localStorage (fire-and-forget)
async function prefetchDeckImages(deckName, format) {
  try {
    const data = await window.forgeApi.get(
      '/api/decks/detail?name=' + encodeURIComponent(deckName) + '&format=' + format.toLowerCase()
    );
    const names = (data.cards || []).map(c => c.name);
    await fetchScryfallBatch(names);
    // Now push each URL into localStorage cache
    for (const name of names) {
      if (localStorage.getItem('sf:' + name)) continue;
      const sf = scryfallCards.get(name);
      const url = sfFaceImg(sf, name) || null;
      if (url) localStorage.setItem('sf:' + name, url);
    }
  } catch { /* silent — prefetch is best-effort */ }
}

let pausePolling = false;    // set true during targeting to avoid re-render wiping selections
let gameOverHandled = false; // guard: only call handleGameOver once per game session
let revealedCards = [];      // cards currently shown in the persistent revealed panel

function clearRevealedPanel() {
  revealedCards = [];
  document.getElementById('revealed-cards-panel')?.remove();
}

function renderRevealedPanel(cards, title) {
  revealedCards = cards || [];
  document.getElementById('revealed-cards-panel')?.remove();
  if (!revealedCards.length) return;

  const panel = document.createElement('div');
  panel.id = 'revealed-cards-panel';
  panel.style.cssText = 'position:fixed;top:4px;right:4px;z-index:300;background:rgba(20,18,35,0.97);' +
    'border:1px solid var(--gold,#c8a96e);border-radius:8px;padding:8px 10px;max-width:260px;' +
    'box-shadow:0 8px 24px rgba(0,0,0,0.8);user-select:none;';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;';
  const lbl = document.createElement('span');
  lbl.style.cssText = 'font-size:0.7rem;font-weight:700;color:var(--gold,#c8a96e);text-transform:uppercase;letter-spacing:0.07em;';
  lbl.textContent = title || 'Cartes révélées';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'background:none;border:none;color:#888;cursor:pointer;font-size:0.75rem;padding:0 0 0 8px;line-height:1;';
  closeBtn.onclick = () => clearRevealedPanel();
  header.appendChild(lbl);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const grid = document.createElement('div');
  grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-start;max-height:50vh;overflow-y:auto;';
  for (const c of revealedCards) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:72px;text-align:center;cursor:default;';
    wrap.dataset.card = c.name;
    const img = document.createElement('img');
    img.style.cssText = 'width:72px;border-radius:4px;display:block;';
    img.alt = c.name;
    const sf = scryfallCards.get(c.name);
    const url = sfFaceImg(sf, c.name) || scryfallCache.get(c.name) || '';
    if (url) img.src = url;
    else fetchCardImage(c.name).then(u => { if (u) img.src = u; });
    const lbl2 = document.createElement('div');
    lbl2.style.cssText = 'font-size:0.55rem;color:var(--text-muted,#888);margin-top:2px;line-height:1.2;word-break:break-word;';
    lbl2.textContent = c.name;
    wrap.appendChild(img);
    wrap.appendChild(lbl2);
    grid.appendChild(wrap);
  }
  panel.appendChild(grid);
  document.body.appendChild(panel);
}

function startPolling() {
  if (playPollTimer) clearInterval(playPollTimer);
  gameOverHandled = false;
  _lastRenderedDecisionSeq = null; // reset seq guard for new game session
  clearRevealedPanel();
  // Clear failed token image cache entries so new game can retry Scryfall
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('sf:token:') && localStorage.getItem(k) === '') {
        localStorage.removeItem(k);
        scryfallCache.delete(k.slice(3)); // remove 'sf:' prefix
      }
    }
  } catch { /* ignore */ }
  playPollTimer = setInterval(doPoll, 600);
}

async function doPoll() {
  if (!playSession) { clearInterval(playPollTimer); return; }
  if (pausePolling) return;
  const sessionIdAtPoll = playSession;
  try {
    const state = await window.forgeApi.get('/api/game/' + sessionIdAtPoll + '/state');
    if (playSession !== sessionIdAtPoll) return; // stale — discard
    renderGameState(state);
    if (state.gameOver) clearInterval(playPollTimer);
  } catch (e) { /* keep polling */ }
}

async function concedeGame() {
  if (!playSession) return;
  try {
    await window.forgeApi.post('/api/game/' + playSession + '/concede', {});
  } catch { /* ignore */ }
  // Force an immediate poll so gameOver is detected without waiting for the timer
  setTimeout(doPoll, 200);
}

async function stopPlayGame() {
  if (playSession) {
    try { await window.forgeApi.delete('/api/game/' + playSession); } catch {}
  }
  resetPlayView();
}

function resetPlayView() {
  clearInterval(playPollTimer);
  playSession = null;
  playState = null;
  matchState = null;
  document.getElementById('play-setup').classList.remove('hidden');
  document.getElementById('play-board').classList.add('hidden');
  document.getElementById('play-winner').classList.add('hidden');
  document.getElementById('play-decision').classList.add('hidden');
  { const el = document.getElementById('play-log'); if (el) el.textContent = ''; }
  document.getElementById('debug-bar')?.classList.add('hidden');
  const ms = document.getElementById('match-score');
  if (ms) ms.textContent = '';
}

function handleGameOver(winner) {
  clearRevealedPanel();
  const winnerEl = document.getElementById('play-winner');
  winnerEl.classList.remove('hidden');

  if (!matchState) {
    winnerEl.textContent = winner ? (winner === 'DRAW' ? '🤝 Égalité' : '🏆 ' + winner + ' gagne') : 'Partie terminée';
    return;
  }

  // Update wins
  if (winner && winner !== 'DRAW' && matchState.wins[winner] !== undefined) {
    matchState.wins[winner]++;
  }
  const p1w = matchState.wins[matchState.p1Name] || 0;
  const p2w = matchState.wins[matchState.p2Name] || 0;
  updateMatchScore();

  // Check match winner
  if (p1w >= 2 || p2w >= 2) {
    const matchWinner = p1w >= 2 ? matchState.p1Name : matchState.p2Name;
    winnerEl.innerHTML = `🏆 <b>${matchWinner}</b> remporte le match (${p1w}–${p2w}) !
      <button id="btn-new-match" class="btn-secondary" style="margin-left:12px">Nouveau match</button>`;
    document.getElementById('btn-new-match').addEventListener('click', () => stopPlayGame());
    return;
  }

  // Next game
  matchState.game++;
  matchState.lastWinner = winner || null; // save for goFirstPlayerIndex in startNextGame
  const gameWinnerText = winner === 'DRAW' ? 'Égalité' : (winner ? winner + ' gagne' : 'Partie terminée');
  winnerEl.innerHTML = `Game ${matchState.game - 1} — ${gameWinnerText} (${p1w}–${p2w})
    <button id="btn-next-game" class="btn-primary" style="margin-left:12px">▶ Game ${matchState.game}</button>
    <button id="btn-end-match" class="btn-secondary" style="margin-left:6px">Abandonner le match</button>`;
  document.getElementById('btn-next-game').addEventListener('click', startNextGame);
  document.getElementById('btn-end-match').addEventListener('click', () => stopPlayGame());
}

async function startNextGame() {
  const winnerEl = document.getElementById('play-winner');

  // Stop polling. Set playSession=null immediately so any in-flight polls discard their results.
  clearInterval(playPollTimer);
  gameOverHandled = true;
  const oldSession = playSession;
  playSession = null;
  pausePolling = false;

  // Reset UI
  winnerEl.innerHTML = '⏳ Démarrage game ' + matchState.game + '…';
  document.querySelectorAll('#coin-modal,#arrange-modal').forEach(m => m.remove());
  playState = null;
  { const el = document.getElementById('play-log'); if (el) el.textContent = ''; }
  document.getElementById('play-decision').classList.add('hidden');

  // Step 1: delete old session — await with 3s max so the server finishes before POST
  winnerEl.textContent = '⏳ Étape 1/3 — Suppression ancienne session…';
  if (oldSession) {
    try {
      await Promise.race([
        window.forgeApi.delete('/api/game/' + oldSession),
        new Promise(r => setTimeout(r, 3000))
      ]);
    } catch { /* ignore */ }
  }

  // Step 2: optional commander swap (skip if takes > 10s)
  winnerEl.textContent = '⏳ Étape 2/3 — Chargement commandants…';
  let selectedCommanders = null; // array of 1 or 2 names
  try {
    const cmdrData = await Promise.race([
      window.forgeApi.get('/api/game/commanders?deck=' + encodeURIComponent(matchState.deck1)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('commanders timeout')), 10000))
    ]);
    if (cmdrData.commanders && cmdrData.commanders.length > 1) {
      selectedCommanders = await new Promise(resolve =>
        showCommanderSwapModal(cmdrData.commanders, cmdrData.designatedCount || 1, resolve));
    }
  } catch { /* ignore */ }
  // Pre-fetch images for selected commanders so command zone shows immediately
  if (selectedCommanders) selectedCommanders.filter(Boolean).forEach(n => fetchCardImage(n));

  // Step 3: start new game
  winnerEl.textContent = '⏳ Étape 3/3 — Démarrage game ' + matchState.game + '…';
  try {
    const body = { deck1: matchState.deck1, deck2: matchState.deck2, format: matchState.format };
    if (selectedCommanders && selectedCommanders[0]) body.commander1 = selectedCommanders[0];
    if (selectedCommanders && selectedCommanders[1]) body.commander2 = selectedCommanders[1];
    // Loser of last game goes first (winner != null: other player is loser; null = concede = player 1 lost)
    const lastWinner = matchState.lastWinner;
    body.goFirstPlayerIndex = (!lastWinner || lastWinner === 'AI') ? 0 : 1;
    if (matchState.debug) body.debug = true;
    const result = await Promise.race([
      window.forgeApi.post('/api/game/start', body),
      new Promise((_, reject) => setTimeout(() => reject(new Error('POST /api/game/start timeout 12s')), 12000))
    ]);
    if (result.error) throw new Error(result.error);
    playSession = result.sessionId;
    const debugBar = document.getElementById('debug-bar');
    if (debugBar) debugBar.classList.toggle('hidden', !result.debug);
    document.getElementById('play-board').classList.remove('hidden');
    winnerEl.classList.add('hidden');
    updateMatchScore();
    startPolling();
  } catch (e) {
    winnerEl.textContent = 'Erreur game ' + matchState.game + ' : ' + (e.message || e);
  }
}

// onSelect receives an array of selected commander names (1 or 2)
function showCommanderSwapModal(commanders, designatedCount, onSelect) {
  const isPartner = designatedCount >= 2;
  const maxSelect = isPartner ? 2 : 1;
  const selected = new Set();

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.82);display:flex;align-items:center;justify-content:center;z-index:9500';

  const box = document.createElement('div');
  box.style.cssText = 'background:var(--bg-elevated);border:1px solid var(--gold,#c8a96e);border-radius:10px;padding:20px;max-width:720px;width:90%;max-height:80vh;overflow-y:auto;display:flex;flex-direction:column;gap:14px';

  const title = document.createElement('div');
  title.textContent = isPartner
    ? '⚔ Choisir 2 commandants partenaires pour cette game'
    : '⚔ Changer de commandant pour cette game ?';
  title.style.cssText = 'font-size:1rem;font-weight:700;color:var(--gold,#c8a96e);text-align:center';
  box.appendChild(title);

  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:0.75rem;color:var(--text-secondary);text-align:center';
  hint.textContent = isPartner ? 'Sélectionnez exactement 2 commandants' : 'Cliquez pour choisir';
  box.appendChild(hint);

  const grid = document.createElement('div');
  grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;justify-content:center';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn-primary';
  confirmBtn.style.cssText = 'align-self:center;margin-top:4px';
  const updateConfirm = () => {
    if (isPartner) {
      confirmBtn.disabled = selected.size !== 2;
      confirmBtn.textContent = selected.size === 2 ? 'Jouer avec ces commandants' : `Sélectionnez ${2 - selected.size} de plus`;
    } else {
      confirmBtn.disabled = selected.size === 0;
      confirmBtn.textContent = 'Jouer avec ce commandant';
    }
  };
  updateConfirm();

  const resolve = (names) => {
    modal.remove();
    document.removeEventListener('keydown', onKey);
    onSelect(names);
  };

  for (const cmd of commanders) {
    const card = document.createElement('div');
    card.className = 'zone-pick-card fetchable';
    card.dataset.card = cmd.name;
    card.style.cursor = 'pointer';

    const sf = scryfallCards.get(cmd.name);
    const imgUrl = sfFaceImg(sf, cmd.name);
    const renderCard = (url) => {
      card.innerHTML = url
        ? `<img src="${esc(url)}" alt="${esc(cmd.name)}">`
        : `<div style="padding:6px;font-size:0.6rem;color:var(--text-primary);background:var(--bg-elevated);min-height:80px;display:flex;align-items:center;justify-content:center">${esc(cmd.name)}</div>`;
      card.innerHTML += `<span class="zone-pick-card-name">${esc(cmd.name)}</span>`;
    };
    renderCard(imgUrl);
    if (!imgUrl) fetchCardImage(cmd.name).then(u => { if (u) renderCard(u); });

    card.addEventListener('click', () => {
      if (selected.has(cmd.name)) {
        selected.delete(cmd.name);
        card.style.borderColor = '';
        card.style.outline = '';
      } else {
        if (!isPartner) {
          // Single select: resolve immediately
          resolve([cmd.name]);
          return;
        }
        if (selected.size < maxSelect) {
          selected.add(cmd.name);
          card.style.borderColor = 'var(--gold,#c8a96e)';
          card.style.outline = '2px solid var(--gold,#c8a96e)';
        }
      }
      updateConfirm();
    });
    grid.appendChild(card);
  }

  confirmBtn.addEventListener('click', () => resolve([...selected]));

  const keepBtn = document.createElement('button');
  keepBtn.className = 'btn-secondary';
  keepBtn.textContent = 'Garder les commandants actuels';
  keepBtn.style.cssText = 'align-self:center;margin-top:4px';
  keepBtn.addEventListener('click', () => resolve([]));

  modal.addEventListener('click', e => { if (e.target === modal) resolve([]); });
  const onKey = e => { if (e.key === 'Escape') resolve([]); };
  document.addEventListener('keydown', onKey);

  box.appendChild(grid);
  if (isPartner) box.appendChild(confirmBtn);
  box.appendChild(keepBtn);
  modal.appendChild(box);
  document.body.appendChild(modal);
}

// ── Render game state ──────────────────────────────────────────────────────

function renderGameState(state) {
  playState = state;

  // Phase timeline: highlight active phase node
  document.querySelectorAll('.phase-node').forEach(node => {
    const phases = (node.dataset.phases || '').split(' ');
    node.classList.toggle('active', phases.includes(state.phase));
  });
  document.getElementById('play-turn').textContent = 'Turn ' + (state.turn || '?');
  document.getElementById('play-priority').textContent =
    state.priorityPlayer ? '⚡ ' + state.priorityPlayer : '';

  // Active player badge
  const badge = document.getElementById('play-active-badge');
  if (badge) {
    const isMyTurn = state.activePlayer === 'Player 1';
    badge.textContent = isMyTurn ? 'YOUR TURN' : (state.activePlayer || '');
    badge.className = 'play-active-badge ' + (isMyTurn ? 'my-turn' : 'opp-turn');
  }

  // Stack panel — images, first item resolves next (gold border)
  const stackItems = state.stack || [];
  const stackPanel = document.getElementById('play-stack-panel');
  const stackEl = document.getElementById('play-stack');
  const stackCount = document.getElementById('stack-count');
  if (stackItems.length === 0) {
    stackPanel.classList.add('hidden');
  } else {
    stackPanel.classList.remove('hidden');
    stackCount.textContent = '(' + stackItems.length + ')';

    // stackItems[0] = top of stack (resolves first) — rendered first (highest z-index, gold border)
    // stackItems[N-1] = bottom of stack (resolves last)

    // Check if stack changed
    const curCards = [...stackEl.querySelectorAll('.stack-item')].map(e => e.dataset.stackCard);
    const newCards = stackItems.map(s => s.card);
    const changed  = curCards.length !== newCards.length || newCards.some((c, i) => c !== curCards[i]);

    if (changed) {
      stackEl.innerHTML = '';
      stackItems.forEach((s, i) => {
        const div = document.createElement('div');
        div.className = 'stack-item';
        div.dataset.stackCard = s.card;
        div.dataset.stackIdx  = String(i);
        div.dataset.card      = s.card;
        if (s.cardId != null && s.cardId !== -1) div.dataset.cardId = String(s.cardId);
        div.title = s.description || s.card;
        const sf     = scryfallCards.get(s.card);
        const imgUrl = sfFaceImg(sf, s.card);
        if (imgUrl) {
          div.innerHTML = `<img src="${esc(imgUrl)}" alt="${esc(s.card)}">`;
        } else {
          div.innerHTML = `<div style="background:var(--bg-elevated);padding:6px;font-size:0.65rem;color:var(--text-primary)">${esc(s.card)}</div>`;
          fetchCardImage(s.card).then(u => { if (u) { const img = document.createElement('img'); img.src = u; img.alt = s.card; div.querySelector('div')?.replaceWith(img); } });
        }
        // Index 1 = top of stack (resolves next), N = bottom (resolves last)
        div.innerHTML += `<span class="stack-item-index">${i + 1}</span>
                          <span class="stack-item-label">${esc(s.card)}</span>
                          <span class="stack-item-ok">OK ▶</span>`;
        div.addEventListener('click', () => {
          const dec = playState?.pendingDecision;
          if (dec && dec.type === 'CHOOSE_ACTION') sendDecision({ choice: 'pass' });
        });
        stackEl.appendChild(div);
      });
    }

    // z-index: top of stack (i=0) gets highest value so it renders on top
    [...stackEl.querySelectorAll('.stack-item')].forEach((el, i) => {
      el.style.zIndex = String(stackItems.length - i);
    });
  }

  // Players (index 0 = self = Player 1, index 1 = opponent = Player 2)
  const players = state.players || [];
  if (players.length >= 2) {
    renderPlayer(players[0], 'self');
    renderPlayer(players[1], 'opp');
  } else if (players.length === 1) {
    renderPlayer(players[0], 'self');
  }

  // Pending decision
  renderDecision(state.pendingDecision);

  // Log
  const logLines = state.log || [];
  const logEl = document.getElementById('play-log');
  if (logEl) logEl.textContent = logLines.join('\n');

  // Game over — handled only once per session to prevent double-counting match wins
  if (state.gameOver && !gameOverHandled) {
    gameOverHandled = true;
    document.getElementById('play-decision').classList.add('hidden');
    // Display engine error in log if the game crashed
    if (state.error && logEl) {
      logEl.textContent = '⚠ ERREUR MOTEUR : ' + state.error + '\n\n' + (logEl.textContent || '');
    }
    handleGameOver(state.winner);
  }

  // Draw target arrows and blocker overlays after DOM settles
  requestAnimationFrame(() => {
    drawTargetArrows(state);
    drawCombatArrows(state);
    clearBlockerOverlays();
    renderBlockerOverlays(state);
  });
}

// ── Target arrows (SVG overlay) ────────────────────────────────────────────

function clearTargetArrows() {
  const svg = document.getElementById('target-arrows');
  if (!svg) return;
  [...svg.children].forEach(c => { if (c.tagName !== 'defs') c.remove(); });
}

// Called during targeting mode: draw arrows from the source card to each chosen target ID
function drawLiveTargetingArrows(sourceCardId, chosenIds) {
  clearTargetArrows();
  if (!chosenIds.length) return;

  const svg = document.getElementById('target-arrows');
  if (!svg) return;

  const fromEl = sourceCardId != null
    ? (document.querySelector(`#play-stack .stack-item[data-card-id="${sourceCardId}"]`)
       || document.querySelector(`[data-card-id="${sourceCardId}"]`))
    : null;
  if (!fromEl) return;

  const from = rectCenter(fromEl);

  for (const id of chosenIds) {
    const toEl = document.querySelector(`[data-card-id="${id}"], .play-life[data-player-id="${id}"]`);
    if (!toEl) continue;
    const to = rectCenter(toEl);
    svg.appendChild(makeArrowPath(from, to));
  }
}

function rectCenter(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function makeArrowPath(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const cx = from.x + dx * 0.5 - dy * 0.25;
  const cy = from.y + dy * 0.5 + dx * 0.25;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', `M${from.x},${from.y} Q${cx},${cy} ${to.x},${to.y}`);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'rgba(80,160,255,0.9)');
  path.setAttribute('stroke-width', '2.5');
  path.setAttribute('marker-end', 'url(#arrowhead)');
  return path;
}

// Called after renderState: draw SVG arrows from stack items to their targets
function drawTargetArrows(state) {
  const svg = document.getElementById('target-arrows');
  if (!svg) return;
  clearTargetArrows(); // removes ALL svg children (including leftover live targeting arrows)
  document.querySelectorAll('.targeted-by-stack').forEach(el => el.classList.remove('targeted-by-stack'));

  const stack = state?.stack || [];
  if (!stack.length) return;

  stack.forEach(s => {
    const targets = s.targets || [];
    if (!targets.length) return;

    const fromEl = s.cardId != null && s.cardId !== -1
      ? document.querySelector(`#play-stack .stack-item[data-card-id="${s.cardId}"]`)
      : null;
    if (!fromEl) return;

    const fromR = fromEl.getBoundingClientRect();
    // Arrow originates from the left edge of the source stack card
    const panelLeft = fromR.left;
    const fromX = panelLeft;
    const fromY = fromR.top + fromR.height / 2;

    targets.forEach(t => {
      const toElStack = t.kind !== 'player'
        ? document.querySelector(`#play-stack .stack-item[data-card-id="${t.id}"]`)
        : null;
      const inStack = !!toElStack;
      const toEl = t.kind === 'player'
        ? document.querySelector(`.play-life[data-player-id="${t.id}"]`)
        : (toElStack || document.querySelector(`[data-card-id="${t.id}"]`));
      if (!toEl) return;

      const toR = toEl.getBoundingClientRect();

      let toX, toY, cx, cy;
      if (inStack) {
        // Both cards are in the same right panel: arrow from left-center of source
        // to left edge of the visible portion of target (peeks below the source card)
        toX = panelLeft;
        toY = Math.min(toR.bottom - 15, fromR.bottom + 20); // visible area of target card
        cx  = panelLeft - 45;                               // curves left of panel
        cy  = (fromY + toY) / 2;
      } else {
        // Stack → board/player: from left-center of source to center of target
        toX = toR.left + toR.width  / 2;
        toY = toR.top  + toR.height / 2;
        cx  = panelLeft - 60;
        cy  = (fromY + toY) / 2;
      }

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.classList.add('stack-arrow');
      path.setAttribute('d', `M${fromX},${fromY} Q${cx},${cy} ${toX},${toY}`);
      path.setAttribute('stroke', 'rgba(240,80,80,0.92)');
      path.setAttribute('stroke-width', '2.5');
      path.setAttribute('fill', 'none');
      path.setAttribute('marker-end', 'url(#arrowhead-red)');
      svg.appendChild(path);

      if (!inStack) toEl.classList.add('targeted-by-stack');
    });
  });
}

// ── Combat arrows: attackers → planeswalkers / non-player defenders ──────────
function drawCombatArrows(state) {
  const svg = document.getElementById('target-arrows');
  if (!svg) return;
  const combatAttackers = state?.combat?.attackers || [];

  combatAttackers.forEach(a => {
    const targetId = a.targetId;
    if (!targetId || String(targetId).startsWith('P')) return; // player targets need no arrow
    // Find the attacker card element
    const fromEl = document.querySelector(`[data-card-id="${a.id}"]`);
    if (!fromEl) return;
    // Find the planeswalker / non-player defender element
    const toEl = document.querySelector(`[data-card-id="${targetId}"]`);
    if (!toEl) return;

    const fromR = fromEl.getBoundingClientRect();
    const toR   = toEl.getBoundingClientRect();
    const fromX = fromR.left + fromR.width / 2;
    const fromY = fromR.top;                       // top of attacker card
    const toX   = toR.left + toR.width / 2;
    const toY   = toR.bottom;                      // bottom of planeswalker card
    const cy    = (fromY + toY) / 2;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.classList.add('combat-arrow');
    path.setAttribute('d', `M${fromX},${fromY} Q${fromX},${cy} ${toX},${toY}`);
    path.setAttribute('stroke', 'rgba(255,180,40,0.9)');
    path.setAttribute('stroke-width', '2.5');
    path.setAttribute('fill', 'none');
    path.setAttribute('marker-end', 'url(#arrowhead-red)');
    path.setAttribute('stroke-dasharray', '6,3');
    svg.appendChild(path);

    // Highlight the target planeswalker
    toEl.classList.add('targeted-by-stack');
  });
}

// ── Blocker overlays — show blockers visually stacked on their attacker ────────

function renderBlockerOverlays(state) {
  document.querySelectorAll('.blocker-overlay').forEach(el => el.remove());

  const combatPhases = ['COMBAT_DECLARE_BLOCKERS', 'COMBAT_FIRST_STRIKE_DAMAGE', 'COMBAT_DAMAGE', 'COMBAT_END'];
  if (!combatPhases.includes(state?.phase)) return;

  const attackers = state?.combat?.attackers || [];
  if (!attackers.length) return;

  for (const atk of attackers) {
    if (!atk.blockers || !atk.blockers.length) continue;

    const atkEl = document.querySelector(`[data-card-id="${atk.id}"]`);
    if (!atkEl) continue;
    const atkRect = atkEl.getBoundingClientRect();

    atk.blockers.forEach((blocker, i) => {
      const blockerEl = document.querySelector(`[data-card-id="${blocker.id}"]`);
      if (!blockerEl) return;

      // Dim the original in place
      blockerEl.dataset.blockerDimmed = '1';
      blockerEl.style.opacity = '0.3';

      // Build a small card badge — same size as the attacker, no hover effects
      const overlay = document.createElement('div');
      overlay.className = 'blocker-overlay';

      // Grab the card image src if available
      const srcImg = blockerEl.querySelector('img');
      const cardName = blockerEl.dataset.card || blocker.name || '';
      const w = atkRect.width;

      if (srcImg && srcImg.src && !srcImg.src.endsWith('/')) {
        const img = document.createElement('img');
        img.src = srcImg.src;
        img.alt = cardName;
        img.style.cssText = 'width:100%;border-radius:4px;display:block;pointer-events:none;';
        overlay.appendChild(img);
      } else {
        // Text fallback
        const txt = document.createElement('div');
        txt.className = 'bf-card-text';
        txt.textContent = cardName;
        txt.style.cssText = 'font-size:0.65rem;padding:4px;text-align:center;color:#fff;';
        overlay.appendChild(txt);
      }

      // Stats badge
      const statsEl = blockerEl.querySelector('.bf-stats');
      if (statsEl) {
        const s = document.createElement('span');
        s.className = 'bf-stats';
        s.textContent = statsEl.textContent;
        overlay.appendChild(s);
      }

      overlay.style.cssText = `
        position:fixed;z-index:80;width:${w}px;pointer-events:none;
        left:${atkRect.left + i * 12}px;
        top:${atkRect.top - w * 1.4 - i * 10}px;
        border:2px solid var(--accent-win,#4caf7d);border-radius:5px;
        box-shadow:0 0 10px rgba(76,175,125,0.7);background:#1a2535;
        overflow:hidden;
      `;
      document.body.appendChild(overlay);
    });
  }
}

function clearBlockerOverlays() {
  document.querySelectorAll('.blocker-overlay').forEach(el => el.remove());
  document.querySelectorAll('.bf-card[data-blocker-dimmed]').forEach(el => {
    el.style.removeProperty('opacity');
    delete el.dataset.blockerDimmed;
  });
}

// ── Attached card rendering (auras, equipment) ───────────────────────────────
// For each aura/equipment, find its host card element and render a stacked sub-card below it.
function applyAttachments(zoneEls, attached) {
  // Group attached cards by host id
  const byHost = new Map();
  for (const c of attached) {
    const key = String(c.attachedToId);
    if (!byHost.has(key)) byHost.set(key, []);
    byHost.get(key).push(c);
  }

  // Clear all existing attachment stacks in all zones
  zoneEls.forEach(z => z.querySelectorAll('.bf-attached-stack').forEach(e => e.remove()));

  for (const [hostId, auras] of byHost) {
    // Find host element in any zone
    let hostEl = null;
    for (const z of zoneEls) {
      hostEl = z.querySelector(`[data-card-id="${hostId}"]`);
      if (hostEl) break;
    }
    if (!hostEl) continue;

    // Build stacked sub-cards container
    const stack = document.createElement('div');
    stack.className = 'bf-attached-stack';

    for (let i = 0; i < auras.length; i++) {
      const aura = auras[i];
      const el = document.createElement('div');
      el.className = 'bf-attached-card';
      el.dataset.card = aura.englishName || aura.name;
      el.dataset.cardId = aura.id;
      // Cascade bottom-right: each card offset from the previous
      el.style.left = (30 + i * 10) + 'px';
      el.style.top  = (52 + i * 10) + 'px';
      el.style.zIndex = 6 + i;

      const cached = scryfallCache.get(aura.englishName || aura.name) || '';
      if (cached) {
        el.innerHTML = `<img src="${esc(cached)}" alt="${esc(aura.name)}" loading="lazy">`;
      } else {
        const nameEl = document.createElement('span');
        nameEl.textContent = aura.name;
        el.appendChild(nameEl);
        fetchCardImage(aura.englishName || aura.name).then(u => {
          if (u) el.innerHTML = `<img src="${esc(u)}" alt="${esc(aura.name)}">`;
        });
      }
      stack.appendChild(el);
    }
    hostEl.appendChild(stack);
  }
}

// Diff a bf zone: reuse existing card elements (no flicker), only add/remove changes
function diffBfZone(zoneEl, cards) {
  const oldEls = new Map();
  zoneEl.querySelectorAll('.bf-card[data-card-id]').forEach(e => oldEls.set(e.dataset.cardId, e));
  const currentIds = new Set(cards.map(c => String(c.id)));
  // Remove cards that left the zone
  oldEls.forEach((e, id) => { if (!currentIds.has(id)) e.remove(); });
  // Re-append in correct order (moves existing, appends new)
  for (const c of cards) {
    const id = String(c.id);
    if (oldEls.has(id)) {
      const e = oldEls.get(id);
      // Update tapped — preserve other classes (has-ability etc.)
      e.classList.toggle('tapped', !!c.tapped);
      // Update counters
      let ctrEl = e.querySelector('.bf-counters');
      const hasCounters = c.counters && Object.keys(c.counters).length > 0;
      if (hasCounters) {
        const text = Object.entries(c.counters)
          .map(([k, v]) => {
            const fmt = k === 'P1P1' ? '+1/+1' : k === 'M1M1' ? '-1/-1' : k === 'P2P2' ? '+2/+2'
                      : k === 'M0M1' ? '0/-1' : k === 'P0P1' ? '+0/+1' : k === 'P1P0' ? '+1/+0'
                      : k.toLowerCase().replace(/_/g, ' ');
            if (v > 1) {
              // Scale the counter value directly into the label (e.g. 3× +1/+1 → +3/+3)
              const scaled = fmt.replace(/([+-]?\d+)/g, n => String(parseInt(n) * v));
              return scaled !== fmt ? scaled : v + '× ' + fmt;
            }
            return fmt;
          }).join('  ');
        if (!ctrEl) { ctrEl = document.createElement('span'); ctrEl.className = 'bf-counters'; e.appendChild(ctrEl); }
        if (ctrEl.textContent !== text) ctrEl.textContent = text;
      } else if (ctrEl) {
        ctrEl.remove();
      }
      // Update P/T stats
      if (c.power !== undefined && c.toughness !== undefined) {
        let statsEl = e.querySelector('.bf-stats');
        const text = c.power + '/' + c.toughness;
        if (!statsEl) { statsEl = document.createElement('span'); statsEl.className = 'bf-stats'; e.appendChild(statsEl); }
        if (statsEl.textContent !== text) statsEl.textContent = text;
      }
      // Update combat badge
      let combatBadge = e.querySelector('.bf-combat-badge');
      e.classList.remove('bf-combat-attacking', 'bf-combat-blocking');
      if (c.combat === 'attacking') {
        e.classList.add('bf-combat-attacking');
        if (!combatBadge) { combatBadge = document.createElement('span'); combatBadge.className = 'bf-combat-badge'; e.appendChild(combatBadge); }
        combatBadge.textContent = '⚔';
      } else if (c.combat === 'blocking') {
        e.classList.add('bf-combat-blocking');
        if (!combatBadge) { combatBadge = document.createElement('span'); combatBadge.className = 'bf-combat-badge'; e.appendChild(combatBadge); }
        combatBadge.textContent = c.blockingName ? '🛡 ' + c.blockingName : '🛡';
      } else if (combatBadge) {
        combatBadge.remove();
      }
      // Only move element if it's not already in this zone (avoid DOM detach/reattach flicker)
      if (e.parentNode !== zoneEl) zoneEl.appendChild(e);
    } else {
      zoneEl.appendChild(makeBfCard(c));
    }
  }
}

function renderPlayer(p, prefix) {
  document.getElementById(prefix + '-name').textContent = p.name;
  const lifeEl = document.getElementById(prefix + '-life');
  lifeEl.textContent = '♥ ' + p.life;
  lifeEl.dataset.playerId = 'P' + p.id;
  document.getElementById(prefix + '-hand').textContent = '✋ ' + (p.hand?.length ?? p.handSize ?? 0);
  const libEl = document.getElementById(prefix + '-library');
  if (libEl) libEl.textContent = p.librarySize ?? 0;

  // Mana pool column
  renderManaPool(p.manaPool || {}, prefix + '-mana-pool');

  // Graveyard pile — pass playable GY options so cards are clickable when flashback/escape available
  const actionOpts = (prefix === 'self' && playState?.pendingDecision?.type === 'CHOOSE_ACTION')
    ? (playState.pendingDecision.data?.options || []) : [];
  const gyPlayable   = actionOpts.filter(o => o.zone?.toUpperCase() === 'GRAVEYARD');
  const exilePlayable = actionOpts.filter(o => o.zone?.toUpperCase() === 'EXILE');
  renderZonePile(p.graveyard || [], prefix + '-gy-pile', prefix + '-gy-img', prefix + '-gy-count',
    'Cimetière — ' + p.name, 'zone-stat-img', gyPlayable);
  // Delirium badge near graveyard
  const gyPile = document.getElementById(prefix + '-gy-pile');
  if (gyPile) {
    let delBadge = gyPile.querySelector('.gy-delirium-badge');
    if (p.delirium) {
      if (!delBadge) {
        delBadge = document.createElement('span');
        delBadge.className = 'gy-delirium-badge';
        delBadge.title = 'Delirium actif (4+ types au cimetière)';
        gyPile.appendChild(delBadge);
      }
      delBadge.textContent = '◆ Delirium';
    } else if (delBadge) {
      delBadge.remove();
    }
  }

  // Exile pile
  renderZonePile(p.exile || [], prefix + '-exile-pile', prefix + '-exile-img', prefix + '-exile-count',
    'Exil — ' + p.name, 'zone-stat-img', exilePlayable);

  // Battlefield — categorize by type
  const bf = p.battlefield || [];
  const lands     = bf.filter(c => c.type && c.type.includes('Land'));
  const creatures = bf.filter(c => c.type && c.type.includes('Creature') && !(c.type.includes('Land')));
  // Attached cards (auras, equipment) are rendered on their host — exclude from side panel
  const attached  = bf.filter(c => c.attachedToId != null);
  const side      = bf.filter(c => !lands.includes(c) && !creatures.includes(c) && !attached.includes(c));

  const creaturesEl = document.getElementById(prefix + '-bf-creatures');
  const landsEl     = document.getElementById(prefix + '-bf-lands');
  // self uses '-bf-other', opp still uses '-bf-side' (same ID, different HTML position)
  const sideEl = document.getElementById(prefix + '-bf-other')
              ?? document.getElementById(prefix + '-bf-side');

  if (creaturesEl) diffBfZone(creaturesEl, creatures);
  if (landsEl)     diffBfZone(landsEl, lands);
  if (sideEl)      diffBfZone(sideEl, side);

  // Render attached cards (auras / equipment) stacked below their host permanent
  applyAttachments([creaturesEl, landsEl, sideEl].filter(Boolean), attached);

  // Commander zone
  const cmdEl = document.getElementById(prefix + '-commander');
  if (cmdEl) {
    const cmdCards = p.command || [];
    const cmdIds = new Set(cmdCards.map(c => String(c.id)));
    cmdEl.querySelectorAll('[data-card-id]').forEach(e => { if (!cmdIds.has(e.dataset.cardId)) e.remove(); });
    const existing = new Set([...cmdEl.querySelectorAll('[data-card-id]')].map(e => e.dataset.cardId));
    for (const c of cmdCards) { if (!existing.has(String(c.id))) cmdEl.appendChild(makeCmdCard(c)); }
  }

  // Hand (only show for "self" = player 0) — diff to avoid flicker
  if (prefix === 'self') {
    const handEl = document.getElementById('self-hand-zone');
    const handCards = p.hand || [];
    const handOldEls = new Map();
    handEl.querySelectorAll('.hand-card[data-card-id]').forEach(e => handOldEls.set(e.dataset.cardId, e));
    const handIds = new Set(handCards.map(c => String(c.id)));
    handOldEls.forEach((e, id) => { if (!handIds.has(id)) e.remove(); });
    for (const c of handCards) {
      const id = String(c.id);
      if (handOldEls.has(id)) {
        const e = handOldEls.get(id);
        if (e.parentNode !== handEl) handEl.appendChild(e); // only move if not already here
      } else {
        handEl.appendChild(makeHandCard(c));
      }
    }
  }
}

function renderManaPool(pool, elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const keys = ['W', 'U', 'B', 'R', 'G', 'C'];
  el.innerHTML = '';
  for (const key of keys) {
    const amt = pool[key] || 0;
    const item = document.createElement('span');
    item.className = 'mana-pool-item' + (amt === 0 ? ' zero' : '');
    item.title = key + ': ' + amt;
    const pip = document.createElement('img');
    pip.className = 'mana-pip';
    pip.src = 'https://svgs.scryfall.io/card-symbols/' + key + '.svg';
    pip.alt = key;
    pip.draggable = false;
    const cnt = document.createElement('span');
    cnt.className = 'mana-count' + (amt === 0 ? ' zero' : '');
    cnt.textContent = amt;
    item.appendChild(pip);
    item.appendChild(cnt);
    el.appendChild(item);
  }
}

function renderZonePile(cards, pileId, imgId, countId, viewerTitle, imgClass, playableOpts = []) {
  const pileEl  = document.getElementById(pileId);
  const imgEl   = document.getElementById(imgId);
  const countEl = document.getElementById(countId);
  if (!pileEl || !imgEl || !countEl) return;

  // Ensure correct img class (for switching between small/large zones)
  if (imgClass) {
    imgEl.className = imgClass + (imgEl.classList.contains('hidden') ? ' hidden' : '');
  }

  countEl.textContent = cards.length;

  const last = cards[cards.length - 1];
  if (last) {
    const sf = scryfallCards.get(last.name);
    const url = sfFaceImg(sf, last.name) || scryfallCache.get(last.name) || '';
    if (url) { imgEl.src = url; imgEl.classList.remove('hidden'); }
    else fetchCardImage(last.name).then(u => { if (u) { imgEl.src = u; imgEl.classList.remove('hidden'); } });
  } else {
    imgEl.classList.add('hidden');
  }

  const playableHere = playableOpts.filter(o => cards.some(c => String(c.id) === String(o.cardId)));
  pileEl.classList.toggle('has-ability', playableHere.length > 0);
  pileEl.onclick = cards.length > 0 ? () => showZoneViewer(cards, viewerTitle, playableHere) : null;
  const empty = cards.length === 0;
  pileEl.classList.toggle('empty', empty);
  pileEl.style.opacity = empty ? '0.45' : '1';
  pileEl.style.cursor  = empty ? 'default' : 'pointer';
}

function makeCmdCard(c) {
  const wrap = document.createElement('div');
  wrap.className = 'cmd-card';
  wrap.dataset.cardId = String(c.id);
  wrap.title = c.name;
  const sf = scryfallCards.get(c.name);
  const img = sfFaceImg(sf, c.name) || scryfallCache.get(c.name) || '';
  if (img) {
    wrap.innerHTML = `<img src="${esc(img)}" alt="${esc(c.name)}" loading="lazy">`;
  } else {
    const inner = document.createElement('div');
    inner.className = 'bf-card-text';
    inner.textContent = c.name;
    wrap.appendChild(inner);
    fetchCardImage(c.name).then(u => {
      if (u) wrap.innerHTML = `<img src="${esc(u)}" alt="${esc(c.name)}">`;
    });
  }
  // Commander tax badge
  if (c.commanderTax > 0) {
    const tax = document.createElement('span');
    tax.className = 'cmd-tax-badge';
    tax.textContent = '+{' + c.commanderTax + '}';
    tax.title = 'Taxe commandant ×' + c.commanderCastCount;
    wrap.appendChild(tax);
  }
  // Click to cast from command zone
  wrap.addEventListener('click', e => handleCmdCardClick(c, e.currentTarget));
  return wrap;
}

function handleCmdCardClick(card, anchorEl) {
  const decision = playState?.pendingDecision;
  if (!decision || decision.type !== 'CHOOSE_ACTION') return;
  const options = decision.data?.options || [];
  const cmdOpts = options.filter(o => o.cardId == card.id && o.zone?.toUpperCase() === 'COMMAND');
  if (cmdOpts.length === 0) return;
  if (cmdOpts.length === 1) {
    sendDecision({ choice: cmdOpts[0].id });
    return;
  }
  showAbilityPopup(card, cmdOpts, anchorEl);
}

function makeBfCard(c) {
  const wrap = document.createElement('div');
  const lookupName = c.englishName || c.name;
  const isToken = !!c.isToken;
  const cacheKey = (isToken ? 'token:' : '') + lookupName;
  const sf = scryfallCards.get(lookupName);
  const img = sfFaceImg(sf, lookupName) || scryfallCache.get(cacheKey) || scryfallCache.get(lookupName) || '';
  wrap.className = 'bf-card' + (c.tapped ? ' tapped' : '');
  wrap.dataset.card = lookupName;
  wrap.dataset.cardId = c.id;
  if (isToken) wrap.dataset.isToken = '1';

  if (img) {
    wrap.innerHTML = `<img src="${esc(img)}" alt="${esc(c.name)}" loading="lazy">`;
  } else {
    const inner = document.createElement('div');
    inner.className = 'bf-card-text'; // no tapped class — outer .bf-card.tapped already rotates
    inner.textContent = c.name;
    wrap.appendChild(inner);
    fetchCardImage(lookupName, isToken).then(u => {
      if (u) { wrap.innerHTML = `<img src="${esc(u)}" alt="${esc(c.name)}">`; }
    });
  }

  if (c.power !== undefined) {
    const stats = document.createElement('span');
    stats.className = 'bf-stats';
    stats.textContent = c.power + '/' + c.toughness;
    if (c.damage) stats.textContent += ' [-' + c.damage + ']';
    wrap.appendChild(stats);
  }

  if (c.counters && Object.keys(c.counters).length > 0) {
    const ctrEl = document.createElement('span');
    ctrEl.className = 'bf-counters';
    ctrEl.textContent = Object.entries(c.counters)
      .map(([k, v]) => {
        // Format counter keys: P1P1 → +1/+1, M1M1 → -1/-1, LOYALTY → Loyalty, etc.
        const fmt = k === 'P1P1' ? '+1/+1'
                  : k === 'M1M1' ? '-1/-1'
                  : k === 'P2P2' ? '+2/+2'
                  : k === 'M0M1' ? '0/-1'
                  : k === 'P0P1' ? '+0/+1'
                  : k === 'P1P0' ? '+1/+0'
                  : k.toLowerCase().replace(/_/g, ' ');
        return v > 1 ? v + '× ' + fmt : fmt;
      })
      .join('  ');
    wrap.appendChild(ctrEl);
  }

  // Keywords (Flying, Double Strike, etc.)
  if (c.keywords && c.keywords.length > 0) {
    const kwEl = document.createElement('span');
    kwEl.className = 'bf-keywords';
    // Known abbreviations
    const abbr = { 'Flying': '✈', 'Double Strike': '⚔⚔', 'First Strike': '⚔', 'Trample': '🐾',
                   'Haste': '⚡', 'Vigilance': '👁', 'Deathtouch': '☠', 'Lifelink': '♥',
                   'Indestructible': '🛡', 'Hexproof': '🔮', 'Reach': '🏹', 'Menace': '👥',
                   'Flash': '💨', 'Defender': '🏰' };
    kwEl.textContent = c.keywords.slice(0, 4)
      .map(k => abbr[k] ? abbr[k] + ' ' + k : k)
      .join(' · ');
    wrap.appendChild(kwEl);
  }

  // Combat badge (attacking/blocking)
  if (c.combat === 'attacking') {
    wrap.classList.add('bf-combat-attacking');
    const badge = document.createElement('span'); badge.className = 'bf-combat-badge'; badge.textContent = '⚔'; wrap.appendChild(badge);
  } else if (c.combat === 'blocking') {
    wrap.classList.add('bf-combat-blocking');
    const badge = document.createElement('span'); badge.className = 'bf-combat-badge'; badge.textContent = c.blockingName ? '🛡 ' + c.blockingName : '🛡'; wrap.appendChild(badge);
  }

  wrap.addEventListener('click', e => handleBfCardClick(c, e.currentTarget));
  return wrap;
}

/** Replace MTG cost notation like {W}, {T}, {2} with inline SVG mana symbol images */
/** Return the correct face image URL from a Scryfall card object.
 *  If faceName matches a specific face, that face's image is returned.
 *  Falls back to the front face (card_faces[0]) when no match. */
function sfFaceImg(sf, faceName) {
  if (!sf) return '';
  if (sf.image_uris) return sf.image_uris.normal || '';
  if (sf.card_faces) {
    const face = sf.card_faces.find(f => f.name === faceName);
    if (face?.image_uris) return face.image_uris.normal || '';
    return sf.card_faces[0]?.image_uris?.normal || '';
  }
  return '';
}

function formatMtgText(text) {
  if (!text) return '';
  return esc(text).replace(/\{([^}]+)\}/g, (_, sym) => {
    const s = sym.toUpperCase();
    return `<img src="https://svgs.scryfall.io/card-symbols/${s}.svg" alt="{${sym}}" style="width:13px;height:13px;vertical-align:middle;display:inline-block;margin:0 1px;filter:drop-shadow(0 1px 1px rgba(0,0,0,0.6))">`;
  });
}

function parseManaColors(desc) {
  const colors = [];
  if (/{W}/i.test(desc)) colors.push('W');
  if (/{U}/i.test(desc)) colors.push('U');
  if (/{B}/i.test(desc)) colors.push('B');
  if (/{R}/i.test(desc)) colors.push('R');
  if (/{G}/i.test(desc)) colors.push('G');
  if (/any color/i.test(desc) && colors.length === 0) colors.push('W', 'U', 'B', 'R', 'G');
  return [...new Set(colors)];
}

function handleBfCardClick(card, anchorEl) {
  const decision = playState?.pendingDecision;
  if (!decision || decision.type !== 'CHOOSE_ACTION') return;
  const options = decision.data?.options || [];
  const bfOpts = options.filter(o => o.cardId == card.id && o.zone?.toUpperCase() === 'BATTLEFIELD');
  if (bfOpts.length === 0) return;

  // If there's only one option and it's a single-color mana ability, auto-activate silently
  if (bfOpts.length === 1 && bfOpts[0].isMana) {
    const colors = parseManaColors(bfOpts[0].description || '');
    if (colors.length <= 1) {
      sendDecision({ choice: bfOpts[0].id });
      return;
    }
  }

  showAbilityPopup(card, bfOpts, anchorEl);
}

function showAbilityPopup(card, options, anchorEl) {
  const popup  = document.getElementById('ability-popup');
  const btnsEl = document.getElementById('ability-popup-btns');

  btnsEl.innerHTML = '';
  for (const opt of options) {
    if (opt.isMana) {
      const colors = parseManaColors(opt.description || '');
      if (colors.length > 1) {
        // Multi-color mana: show color picker
        const label = document.createElement('div');
        label.className = 'mana-color-label';
        label.textContent = '◈ ' + (opt.description || opt.id);
        btnsEl.appendChild(label);
        const row = document.createElement('div');
        row.className = 'mana-color-row';
        for (const c of colors) {
          const cb = document.createElement('button');
          cb.className = 'mana-color-btn';
          cb.dataset.color = c;
          cb.title = c;
          const sym = document.createElement('img');
          sym.src = 'https://svgs.scryfall.io/card-symbols/' + c + '.svg';
          sym.alt = c;
          cb.appendChild(sym);
          cb.addEventListener('click', () => { hideAbilityPopup(); sendDecision({ choice: opt.id, manaColor: c }); });
          row.appendChild(cb);
        }
        btnsEl.appendChild(row);
        continue;
      }
      // Single-color mana ability
      const btn = document.createElement('button');
      btn.className = 'ability-btn mana';
      btn.innerHTML = '◈ ' + formatMtgText(opt.description || opt.id);
      btn.title = opt.description || '';
      btn.addEventListener('click', () => { hideAbilityPopup(); sendDecision({ choice: opt.id }); });
      btnsEl.appendChild(btn);
    } else {
      const btn = document.createElement('button');
      btn.className = 'ability-btn';
      if (opt.displayLabel) {
        // MDFC land: show face name + mana color pips from faceColors
        const colors = opt.faceColors || [];
        const pips = colors.map(c =>
          `<img src="https://svgs.scryfall.io/card-symbols/${c}.svg" alt="${c}" style="width:14px;height:14px;vertical-align:middle;margin-left:3px;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.6))">`
        ).join('');
        btn.innerHTML = '🌍 ' + esc(opt.displayLabel.replace(/^🌍 /, '')) + pips;
      } else {
        btn.innerHTML = '⚡ ' + formatMtgText(opt.description || opt.id);
      }
      btn.title = opt.description || '';
      btn.addEventListener('click', () => { hideAbilityPopup(); sendDecision({ choice: opt.id }); });
      btnsEl.appendChild(btn);
    }
  }
  const cancel = document.createElement('button');
  cancel.className = 'ability-btn cancel-btn';
  cancel.textContent = '✕ Annuler';
  cancel.addEventListener('click', hideAbilityPopup);
  btnsEl.appendChild(cancel);

  // Close when clicking outside
  document.removeEventListener('click', _abilityPopupOutsideClick, true);
  setTimeout(() => document.addEventListener('click', _abilityPopupOutsideClick, true), 0);

  // Position the popup near the anchor card element
  popup.classList.remove('hidden');
  if (anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    // Measure popup size after making it visible
    const pw = popup.offsetWidth || 200;
    const ph = popup.offsetHeight || 160;
    // Prefer right of card; flip to left if not enough space
    let left = r.right + 6;
    if (left + pw > vw - 8) left = r.left - pw - 6;
    if (left < 8) left = 8;
    // Align top with card; flip up if below viewport
    let top = r.top;
    if (top + ph > vh - 8) top = vh - ph - 8;
    if (top < 8) top = 8;
    popup.style.left = left + 'px';
    popup.style.top  = top  + 'px';
  }
}

function hideAbilityPopup() {
  document.getElementById('ability-popup').classList.add('hidden');
  document.removeEventListener('click', _abilityPopupOutsideClick, true);
}

function _abilityPopupOutsideClick(e) {
  const popup = document.getElementById('ability-popup');
  if (!popup.classList.contains('hidden') && !popup.contains(e.target)) {
    hideAbilityPopup();
  }
}

function showZoneViewer(cards, title, playableOpts = []) {
  const modal = document.getElementById('zone-viewer-modal');
  document.getElementById('zone-viewer-title').textContent = title;
  const grid = document.getElementById('zone-viewer-grid');
  grid.innerHTML = '';

  if (!cards.length) {
    grid.innerHTML = '<div style="color:var(--text-muted);padding:20px">Zone vide</div>';
  } else {
    for (const c of cards) {
      const div = document.createElement('div');
      div.className = 'zone-pick-card fetchable';
      div.dataset.card = c.name;
      const cardOpts = playableOpts.filter(o => String(o.cardId) === String(c.id));
      if (cardOpts.length > 0) {
        div.style.cursor = 'pointer';
        div.style.borderColor = 'var(--gold, #c8a96e)';
        div.title = cardOpts.map(o => o.description || o.card).join(' / ');
        div.addEventListener('click', () => {
          modal.classList.add('hidden');
          if (cardOpts.length === 1) {
            sendDecision({ choice: cardOpts[0].id });
          } else {
            showAbilityPopup(c, cardOpts.map(o => ({
              ...o,
              displayLabel: '✨ ' + (o.description || o.card || o.id)
            })), null);
          }
        });
      } else {
        div.style.cursor = 'default';
        div.style.borderColor = 'var(--border)';
      }
      const sf = scryfallCards.get(c.name);
      const imgUrl = sfFaceImg(sf, c.name);
      div.innerHTML = imgUrl
        ? `<img src="${esc(imgUrl)}" alt="${esc(c.name)}">`
        : `<div style="padding:6px;font-size:0.6rem;color:var(--text-primary);background:var(--bg-elevated);min-height:80px;display:flex;align-items:center;justify-content:center">${esc(c.name)}</div>`;
      div.innerHTML += `<span class="zone-pick-card-name">${esc(c.name)}</span>`;
      if (!imgUrl) fetchCardImage(c.name).then(u => {
        if (u) div.innerHTML = `<img src="${esc(u)}" alt="${esc(c.name)}"><span class="zone-pick-card-name">${esc(c.name)}</span>`;
      });
      grid.appendChild(div);
    }
  }
  modal.classList.remove('hidden');
}

function makeHandCard(c) {
  const wrap = document.createElement('div');
  const sf = scryfallCards.get(c.name);
  const img = sfFaceImg(sf, c.name) || scryfallCache.get(c.name) || '';
  wrap.className = 'hand-card';
  wrap.dataset.cardId = c.id;
  wrap.dataset.card = c.name;
  wrap.title = c.name + (c.manaCost ? ' ' + c.manaCost : '');
  wrap.addEventListener('click', e => handleHandCardClick(c, e.currentTarget));

  if (img) {
    wrap.innerHTML = `<img src="${esc(img)}" alt="${esc(c.name)}" loading="lazy">`;
  } else {
    const inner = document.createElement('div');
    inner.className = 'hand-card-text';
    inner.textContent = c.name;
    wrap.appendChild(inner);
    fetchCardImage(c.name).then(u => {
      if (u) wrap.innerHTML = `<img src="${esc(u)}" alt="${esc(c.name)}">`;
    });
  }
  return wrap;
}

function handleHandCardClick(card, anchorEl) {
  const decision = playState?.pendingDecision;
  if (!decision || decision.type !== 'CHOOSE_ACTION') return;
  const options = decision.data?.options || [];
  const cardOpts = options.filter(o => o.id && o.id.startsWith('C' + card.id + ':')
    && (o.zone?.toUpperCase() === 'HAND' || o.zone?.toUpperCase() === 'COMMAND'));
  if (cardOpts.length === 0) return;

  // Single option (including MDFC front-face only) → play directly
  if (cardOpts.length === 1 && !cardOpts[0].isBackFaceLand) {
    document.querySelectorAll('.hand-card').forEach(el => el.classList.remove('selected'));
    const el = document.querySelector(`.hand-card[data-card-id="${card.id}"]`);
    if (el) el.classList.add('selected');
    sendDecision({ choice: cardOpts[0].id });
    return;
  }

  // Multiple options or MDFC: show popup with labeled choices
  const hasBackFace = cardOpts.some(o => o.isBackFaceLand);
  const labeledOpts = cardOpts.map(o => ({
    ...o,
    displayLabel: o.isBackFaceLand
      ? '🌍 ' + (o.backFaceName || o.card)
      : (hasBackFace
          ? '🌍 ' + o.card   // front face of a pathway/MDFC land
          : '🎴 Lancer : ' + (o.card || o.id))
  }));
  showAbilityPopup(card, labeledOpts, anchorEl);
}

// ── Decision rendering ─────────────────────────────────────────────────────

let _lastRenderedDecisionSeq = null;

function renderDecision(decision) {
  const bar = document.getElementById('play-decision');
  const typeEl = document.getElementById('decision-type');
  const btnsEl = document.getElementById('decision-buttons');

  const passBtn = document.getElementById('btn-pass-priority');

  // Skip full rebuild if same decision is still pending (avoids flicker on every poll)
  if (decision && decision.seq != null && decision.seq === _lastRenderedDecisionSeq) {
    // Only update dynamic fields that change within the same decision (e.g. CHOOSE_ACTION options)
    // For types that must never flicker (MULLIGAN, CONFIRM_*), return immediately
    const stable = ['MULLIGAN', 'MULLIGAN_TUCK', 'CHOOSE_BINARY', 'CHOOSE_NUMBER',
                    'CHOOSE_TARGETS', 'DECLARE_ATTACKERS', 'DECLARE_BLOCKERS',
                    'CONFIRM_ACTION', 'CONFIRM_TRIGGER', 'CONFIRM_COST', 'ORDER_ZONE',
                    'CHOOSE_MODE', 'CHOOSE_CARD', 'CHOOSE_MANA_COMBO'];
    if (stable.includes(decision.type)) return;
  }
  if (decision && decision.seq != null) _lastRenderedDecisionSeq = decision.seq;
  else _lastRenderedDecisionSeq = null;

  if (!decision) {
    const isGameActive = playState && !playState.gameOver && (playState.players?.length ?? 0) > 0;
    if (isGameActive) {
      // Keep bar visible — just clear content and show waiting state
      bar.classList.remove('hidden');
      typeEl.textContent = 'En attente…';
      btnsEl.innerHTML = '';
      passBtn.classList.add('hidden');
    } else {
      bar.classList.add('hidden');
      passBtn.classList.add('hidden');
    }
    document.getElementById('zone-pick-modal').classList.add('hidden');
    hideAbilityPopup();
    cleanupAttackerSelect();
    cleanupBlockerAssign();
    document.querySelectorAll('.hand-card.playable').forEach(el => el.classList.remove('playable'));
    document.querySelectorAll('.bf-card.has-ability').forEach(el => el.classList.remove('has-ability'));
    document.querySelectorAll('[id$="-gy-pile"].has-ability,[id$="-exile-pile"].has-ability').forEach(el => el.classList.remove('has-ability'));
    return;
  }
  const type = decision.type;
  const data = decision.data || {};
  const playerIdx = decision.player ?? 0;

  // CONFIRM_ACTION → floating movable dialog, not the bottom bar
  if (type === 'CONFIRM_ACTION' || type === 'CONFIRM_TRIGGER') {
    bar.classList.add('hidden');
    passBtn.classList.add('hidden');
    const prompt = data.prompt || 'Confirmer ?';
    const cardName = data.card || '';
    pausePolling = true;
    if (window.showConfirmPanel) {
      window.showConfirmPanel(
        prompt, cardName,
        async () => { await sendDecision({ choice: 'yes' }); pausePolling = false; },
        async () => { await sendDecision({ choice: 'no' }); pausePolling = false; }
      );
    }
    return;
  }

  bar.classList.remove('hidden');

  // Auto-pass EOT: si activé et que c'est le tour adverse (sans stack), passer automatiquement
  if (autoPassEOT && type === 'CHOOSE_ACTION' && data.opponentTurn && !data.responding) {
    sendDecision({ choice: 'pass' });
    return;
  }
  // Désactiver l'auto-pass dès que c'est le tour du joueur
  if (autoPassEOT && type === 'CHOOSE_ACTION' && !data.opponentTurn) {
    autoPassEOT = false;
    autoPassBtn.classList.remove('active');
  }

  // Label: stack response, opponent phase, or own priority
  const phaseNames = {
    UNTAP: 'Dégagement', UPKEEP: 'Entretien', DRAW: 'Pioche',
    MAIN1: 'Phase principale 1',
    COMBAT_BEGIN: 'Début combat',
    COMBAT_DECLARE_ATTACKERS: 'Déclaration attaquants',
    COMBAT_DECLARE_BLOCKERS: 'Déclaration bloqueurs',
    COMBAT_FIRST_STRIKE_DAMAGE: 'Dégâts — initiative',
    COMBAT_DAMAGE: 'Dégâts de combat',
    COMBAT_END: 'Fin de combat',
    MAIN2: 'Phase principale 2',
    END_OF_TURN: 'Fin de tour', ENDOFTURN: 'Fin de tour', CLEANUP: 'Nettoyage'
  };
  let label;
  if (type === 'CHOOSE_ACTION' && data.responding) {
    label = 'Répondre à la pile';
  } else if (type === 'CHOOSE_ACTION' && data.opponentTurn) {
    label = phaseNames[data.phase] || data.phase || 'Phase adverse';
  } else {
    label = formatDecisionType(type);
  }
  typeEl.textContent = label + ' — ' +
    (playState?.players?.[playerIdx]?.name ?? 'Player ' + (playerIdx + 1));
  btnsEl.innerHTML = '';

  // Bouton auto-pass visible uniquement pendant le tour adverse
  autoPassBtn.style.display = (type === 'CHOOSE_ACTION' && data.opponentTurn) ? '' : 'none';

  if (type === 'CHOOSE_ACTION') {
    passBtn.classList.remove('hidden');
    // Highlight playable hand cards
    const handOpts = (data.options || []).filter(o => o.zone?.toUpperCase() === 'HAND');
    const playableIds = new Set(handOpts.map(o => String(o.cardId)));
    const count = new Set(handOpts.map(o => String(o.cardId))).size;
    if (count > 0) {
      const hint = document.createElement('span');
      hint.className = 'decision-hint';
      const suffix = data.opponentTurn ? ' (éphémères/flash)' : '';
      hint.textContent = count + ' carte' + (count > 1 ? 's' : '') + ' jouable' + (count > 1 ? 's' : '') + suffix + ' — clic pour jouer';
      btnsEl.appendChild(hint);
    }
    // Battlefield options: shown via card-click popup, not in the decision bar
    // Highlight any bf cards that have abilities
    const bfIds = new Set((data.options || [])
      .filter(o => o.zone?.toUpperCase() === 'BATTLEFIELD')
      .map(o => String(o.cardId)));
    document.querySelectorAll('.bf-card').forEach(el => {
      el.classList.toggle('has-ability', bfIds.has(el.dataset.cardId));
    });
    document.querySelectorAll('.hand-card').forEach(el => {
      el.classList.toggle('playable', playableIds.has(el.dataset.cardId));
    });

  } else if (type === 'ORDER_ZONE') {
    bar.classList.add('hidden');
    passBtn.classList.add('hidden');
    enterOrderZoneMode(data);

  } else if (type === 'CHOOSE_TARGETS') {
    passBtn.classList.add('hidden');
    enterTargetingMode(data);

  } else if (type === 'CONFIRM_ACTION' || type === 'CONFIRM_TRIGGER') {
    passBtn.classList.add('hidden');
    const prompt = data.prompt || (type === 'CONFIRM_TRIGGER' ? 'Déclencher ?' : 'Confirmer ?');
    const hint = document.createElement('span');
    hint.className = 'decision-hint';
    hint.textContent = prompt;
    btnsEl.appendChild(hint);
    btnsEl.appendChild(makeDecisionBtn('✓ Oui', '', () => sendDecision({ choice: 'yes' })));
    btnsEl.appendChild(makeDecisionBtn('✕ Non', 'pass', () => sendDecision({ choice: 'no' })));

  } else if (type === 'CONFIRM_COST') {
    passBtn.classList.add('hidden');
    const prompt = data.prompt || ('Payer ' + (data.costDesc || '') + ' ?');
    const hint = document.createElement('span');
    hint.className = 'decision-hint';
    hint.textContent = prompt;
    btnsEl.appendChild(hint);
    btnsEl.appendChild(makeDecisionBtn('✓ Payer', '', () => sendDecision({ confirmed: true })));
    btnsEl.appendChild(makeDecisionBtn('✕ Non', 'pass', () => sendDecision({ confirmed: false })));

  } else if (type === 'CHOOSE_STARTING_PLAYER') {
    passBtn.classList.add('hidden');
    if (!document.getElementById('coin-modal')) showCoinFlipModal(data);

  } else if (type === 'TOSS_RESULT') {
    passBtn.classList.add('hidden');
    if (!document.getElementById('coin-modal')) showTossResultModal(data);

  } else if (type === 'REVEAL_CARDS') {
    passBtn.classList.add('hidden');
    if (!document.getElementById('reveal-modal')) showRevealModal(data);

  } else if (type === 'ARRANGE_SCRY' || type === 'ARRANGE_SURVEIL') {
    passBtn.classList.add('hidden');
    if (!document.getElementById('arrange-modal')) showArrangeModal(type, data);

  } else if (type === 'CHOOSE_MODE') {
    passBtn.classList.add('hidden');
    showChooseModeModal(data);

  } else if (type === 'CHOOSE_NUMBER') {
    passBtn.classList.add('hidden');
    showChooseNumberModal(data);

  } else if (type === 'CHOOSE_CARD') {
    passBtn.classList.add('hidden');
    document.getElementById('play-stack-panel').classList.add('hidden');
    const zpModal = document.getElementById('zone-pick-modal');
    if (!zpModal || zpModal.classList.contains('hidden')) showZonePickModal(data);

  } else if (type === 'DECLARE_ATTACKERS') {
    passBtn.classList.add('hidden');
    enterAttackerSelectMode(data);
    return;

  } else if (type === 'DECLARE_BLOCKERS') {
    passBtn.classList.add('hidden');
    enterBlockerAssignMode(data);
    return;

  } else if (type === 'MULLIGAN') {
    passBtn.classList.add('hidden');
    const n = data.cardsToReturn || 0;
    const hint = document.createElement('span');
    hint.className = 'decision-hint';
    hint.textContent = n > 0
      ? `Main de 7 — garder et mettre ${n} carte${n>1?'s':''} en dessous`
      : 'Main initiale de 7';
    btnsEl.appendChild(hint);
    btnsEl.appendChild(makeDecisionBtn('✔ Garder', 'pass', () => sendDecision({ keep: true })));
    btnsEl.appendChild(makeDecisionBtn('↺ Mulligan', '', () => sendDecision({ keep: false })));

  } else if (type === 'MULLIGAN_TUCK') {
    bar.classList.add('hidden');
    passBtn.classList.add('hidden');
    // Don't reset panel if it's already open (polling would wipe selections)
    const panel = document.getElementById('mulligan-tuck-panel');
    if (!panel || panel.classList.contains('hidden')) {
      showMulliganTuckPanel(data);
    }
    return;

  } else if (type === 'CHOOSE_BINARY') {
    bar.classList.add('hidden');
    passBtn.classList.add('hidden');
    if (!document.getElementById('choose-option-modal')) {
      // Build yes/no options using kindOfChoice labels if available
      const opts = data.kindOfChoice === 'HeadsOrTails' ? ['Pile', 'Face']
                 : data.kindOfChoice === 'UntapOrNot'   ? ['Dégager', 'Ne pas dégager']
                 : ['Oui', 'Non'];
      showChooseOptionModal({ ...data, options: opts },
        async choice => { await sendDecision({ choice: choice === opts[0] ? 'yes' : 'no' }); });
    }

  } else if (type === 'CHOOSE_MANA_COMBO') {
    bar.classList.add('hidden');
    passBtn.classList.add('hidden');
    if (!document.getElementById('choose-option-modal')) {
      showChooseOptionModal(data, async choice => {
        await sendDecision({ choice });
      });
    }

  } else if (type === 'CHOOSE_OPTION') {
    bar.classList.add('hidden');
    passBtn.classList.add('hidden');
    if (!document.getElementById('choose-option-modal')) {
      showChooseOptionModal(data, async choice => {
        await sendDecision({ choice });
      });
    }

  } else if (type === 'CHOOSE_TYPE') {
    bar.classList.add('hidden');
    passBtn.classList.add('hidden');
    if (!document.getElementById('choose-type-modal')) showChooseTypeModal(data);

  } else if (type === 'CHOOSE_COLOR') {
    bar.classList.add('hidden');
    passBtn.classList.add('hidden');
    if (!document.getElementById('choose-color-modal')) showChooseColorModal(data);

  } else if (type === 'CHOOSE_CARD_NAME') {
    bar.classList.add('hidden');
    passBtn.classList.add('hidden');
    if (!document.getElementById('choose-cardname-modal')) showChooseCardNameModal(data);
  }
}

function makeDecisionBtn(label, extraClass, onClick) {
  const btn = document.createElement('button');
  btn.className = 'decision-btn' + (extraClass ? ' ' + extraClass : '');
  btn.textContent = label;
  btn.title = label;
  btn.addEventListener('click', onClick);
  return btn;
}

async function sendDecision(body) {
  if (!playSession) return;
  try {
    const res = await window.forgeApi.post('/api/game/' + playSession + '/respond', body);
    console.log('[sendDecision] body:', JSON.stringify(body), '| response:', JSON.stringify(res));
    // Wait for game thread to process before polling
    await new Promise(r => setTimeout(r, 400));
    const state = await window.forgeApi.get('/api/game/' + playSession + '/state');
    console.log('[sendDecision] new state phase:', state.phase, '| pendingDecision:', state.pendingDecision?.type, '| hand size:', state.players?.[0]?.hand?.length, '| battlefield:', state.players?.[0]?.battlefield?.map(c=>c.name));
    renderGameState(state);
  } catch (e) { console.error('Decision error:', e); }
}

// ── Zone pick modal (fetch / tutor) ────────────────────────────────────────

// ── Generic option picker modal ────────────────────────────────────────────
// Used for: CHOOSE_OPTION (vote, keyword, protection…), CHOOSE_BINARY (yes/no questions)
function showChooseOptionModal(data, onChoice) {
  document.getElementById('choose-option-modal')?.remove();
  pausePolling = true;

  const modal = document.createElement('div');
  modal.id = 'choose-option-modal';
  modal.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
    'background:var(--bg-elevated);border:1px solid var(--gold);border-radius:10px;' +
    'z-index:500;padding:16px;min-width:260px;max-width:70vw;box-shadow:0 16px 48px rgba(0,0,0,0.9)';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:0.82rem;font-weight:700;color:var(--gold);margin-bottom:12px;text-align:center;letter-spacing:0.06em;text-transform:uppercase';
  title.textContent = data.prompt || 'Choisir';
  if (data.card) title.textContent += ' — ' + data.card;
  modal.appendChild(title);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;justify-content:center';

  const options = data.options || (data.kindOfChoice ? ['Oui', 'Non'] : []);
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'btn-primary';
    btn.style.cssText = 'min-width:80px';
    btn.textContent = String(opt);
    btn.onclick = async () => {
      modal.remove();
      await onChoice(String(opt));
      pausePolling = false;
    };
    btnRow.appendChild(btn);
  });

  if (data.optional) {
    const skip = document.createElement('button');
    skip.className = 'btn-secondary';
    skip.style.cssText = 'min-width:60px;margin-top:4px';
    skip.textContent = 'Passer';
    skip.onclick = async () => { modal.remove(); await onChoice(null); pausePolling = false; };
    btnRow.appendChild(skip);
  }

  modal.appendChild(btnRow);
  document.body.appendChild(modal);
}

// ── Color picker modal ───────────────────────────────────────────────────────
// Used for CHOOSE_COLOR (Skrelv, protection effects, etc.)
function showChooseColorModal(data) {
  document.getElementById('choose-color-modal')?.remove();
  pausePolling = true;

  const COLOR_META = {
    White:     { code: 'W', bg: '#f5f0dc', fg: '#2a2000', symbol: '{W}' },
    Blue:      { code: 'U', bg: '#1a3a6b', fg: '#d0e8ff', symbol: '{U}' },
    Black:     { code: 'B', bg: '#1a1a1a', fg: '#d0c8f0', symbol: '{B}' },
    Red:       { code: 'R', bg: '#8b1a10', fg: '#ffe0c0', symbol: '{R}' },
    Green:     { code: 'G', bg: '#1a4a20', fg: '#c0f0c0', symbol: '{G}' },
    Colorless: { code: 'C', bg: '#444',    fg: '#ccc',    symbol: '{C}' },
  };

  const modal = document.createElement('div');
  modal.id = 'choose-color-modal';
  modal.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
    'background:var(--bg-elevated);border:1px solid var(--gold);border-radius:10px;' +
    'z-index:500;padding:18px 20px;min-width:260px;box-shadow:0 16px 48px rgba(0,0,0,0.9)';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:0.82rem;font-weight:700;color:var(--gold);margin-bottom:14px;text-align:center;letter-spacing:0.06em;text-transform:uppercase';
  title.textContent = (data.prompt || 'Choisissez une couleur') + (data.card ? ' — ' + data.card : '');
  modal.appendChild(title);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;justify-content:center';

  const colors = data.colors || ['White', 'Blue', 'Black', 'Red', 'Green'];
  colors.forEach(colorName => {
    const meta = COLOR_META[colorName] || { code: colorName[0], bg: '#555', fg: '#fff' };
    const btn = document.createElement('button');
    btn.style.cssText = `min-width:72px;padding:8px 10px;border-radius:6px;border:2px solid rgba(255,255,255,0.15);` +
      `background:${meta.bg};color:${meta.fg};font-weight:700;font-size:0.85rem;cursor:pointer;`;
    btn.textContent = colorName;
    btn.onclick = async () => {
      modal.remove();
      pausePolling = false;
      await sendDecision({ color: colorName });
    };
    btnRow.appendChild(btn);
  });

  modal.appendChild(btnRow);
  document.body.appendChild(modal);
}

// ── Type picker modal ────────────────────────────────────────────────────────
// Used for CHOOSE_TYPE (Engineered Plague, Goblin Charbelcher, etc.)
function showChooseTypeModal(data) {
  document.getElementById('choose-type-modal')?.remove();
  pausePolling = true;

  const modal = document.createElement('div');
  modal.id = 'choose-type-modal';
  modal.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
    'background:var(--bg-elevated);border:1px solid var(--gold);border-radius:10px;' +
    'z-index:500;padding:16px;min-width:300px;max-width:82vw;max-height:80vh;overflow-y:auto;box-shadow:0 16px 48px rgba(0,0,0,0.9)';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:0.82rem;font-weight:700;color:var(--gold);margin-bottom:10px;text-align:center;letter-spacing:0.06em;text-transform:uppercase';
  title.textContent = (data.prompt || 'Nommer un type') + (data.card ? ' — ' + data.card : '');
  modal.appendChild(title);

  const grid = document.createElement('div');
  grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;justify-content:center';

  (data.types || []).forEach(type => {
    const btn = document.createElement('button');
    btn.className = 'btn-secondary';
    btn.style.cssText = 'font-size:0.75rem;padding:4px 10px';
    btn.textContent = type;
    btn.onclick = async () => {
      modal.remove();
      await sendDecision({ type });
      pausePolling = false;
    };
    grid.appendChild(btn);
  });
  modal.appendChild(grid);
  document.body.appendChild(modal);
}

// ── Card name input modal ─────────────────────────────────────────────────────
// Used for CHOOSE_CARD_NAME (Pithing Needle, Surgical Extraction, etc.)
function showChooseCardNameModal(data) {
  document.getElementById('choose-cardname-modal')?.remove();
  pausePolling = true;

  const modal = document.createElement('div');
  modal.id = 'choose-cardname-modal';
  modal.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
    'background:var(--bg-elevated);border:1px solid var(--gold);border-radius:10px;' +
    'z-index:500;padding:16px;min-width:320px;max-width:88vw;box-shadow:0 16px 48px rgba(0,0,0,0.9)';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:0.82rem;font-weight:700;color:var(--gold);margin-bottom:10px;text-align:center;letter-spacing:0.06em;text-transform:uppercase';
  title.textContent = (data.prompt || 'Nommer une carte') + (data.card ? ' — ' + data.card : '');
  modal.appendChild(title);

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Nom de la carte…';
  input.style.cssText = 'width:100%;box-sizing:border-box;padding:8px;background:var(--bg-card);border:1px solid rgba(255,255,255,0.15);border-radius:6px;color:var(--text-primary);font-size:0.85rem';
  modal.appendChild(input);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn-primary';
  confirmBtn.style.cssText = 'margin-top:10px;width:100%';
  confirmBtn.textContent = 'Confirmer';
  confirmBtn.onclick = async () => {
    const val = input.value.trim();
    if (!val) return;
    modal.remove();
    await sendDecision({ cardName: val });
    pausePolling = false;
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') confirmBtn.click(); });
  modal.appendChild(confirmBtn);

  document.body.appendChild(modal);
  setTimeout(() => input.focus(), 50);
}

// ── Reveal cards modal (opponent's hand peek, etc.) ────────────────────────
function showRevealModal(data) {
  document.getElementById('reveal-modal')?.remove();
  pausePolling = true;

  const modal = document.createElement('div');
  modal.id = 'reveal-modal';
  modal.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
    'background:var(--bg-elevated);border:1px solid var(--gold);border-radius:10px;' +
    'z-index:500;padding:16px;min-width:300px;max-width:82vw;box-shadow:0 16px 48px rgba(0,0,0,0.9);user-select:none';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:0.82rem;font-weight:700;color:var(--gold);margin-bottom:12px;text-align:center;letter-spacing:0.06em;text-transform:uppercase';
  title.textContent = data.prompt || 'Cartes révélées';
  modal.appendChild(title);

  const grid = document.createElement('div');
  grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;justify-content:center;max-height:60vh;overflow-y:auto;padding:4px';

  for (const c of (data.cards || [])) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'text-align:center;width:110px;cursor:default';
    wrap.dataset.card = c.name;

    const img = document.createElement('img');
    img.style.cssText = 'width:110px;border-radius:5px;display:block';
    img.alt = c.name;
    const sf = scryfallCards.get(c.name);
    const url = sfFaceImg(sf, c.name) || scryfallCache.get(c.name) || '';
    if (url) img.src = url;
    else fetchCardImage(c.name).then(u => { if (u) img.src = u; });

    const label = document.createElement('div');
    label.style.cssText = 'font-size:0.6rem;color:var(--text-muted);margin-top:3px;line-height:1.2;word-break:break-word';
    label.textContent = c.name;
    wrap.appendChild(img);
    wrap.appendChild(label);
    grid.appendChild(wrap);
  }
  modal.appendChild(grid);

  const btn = document.createElement('button');
  btn.className = 'btn-primary';
  btn.style.cssText = 'margin-top:14px;width:100%';
  btn.textContent = 'OK';
  btn.onclick = async () => {
    modal.remove();
    // Keep revealed cards visible in a persistent side panel
    renderRevealedPanel(data.cards, data.prompt);
    await sendDecision({ ok: true });
    pausePolling = false;
  };
  modal.appendChild(btn);
  document.body.appendChild(modal);
}

function showZonePickModal(data) {
  const modal = document.getElementById('zone-pick-modal');
  const title = document.getElementById('zone-pick-title');
  const grid  = document.getElementById('zone-pick-grid');
  const search = document.getElementById('zone-pick-search');

  title.textContent = data.prompt || 'Choisir une carte';
  search.value = '';
  modal.classList.remove('hidden');

  const cards = data.cards || [];
  const isMulti = data.multiSelect && (data.max || 1) > 1;
  const maxSel = data.max || 1;
  const minSel = data.min || (data.optional ? 0 : 1);
  const selectedIds = new Set();

  function makeCardDiv(c) {
    const div = document.createElement('div');
    div.className = 'zone-pick-card fetchable' + (selectedIds.has(c.id) ? ' selected' : '');
    div.dataset.cardId = c.id;
    div.dataset.card = c.name;
    if (selectedIds.has(c.id)) div.style.outline = '2px solid var(--gold,#c8a96e)';
    const sf = scryfallCards.get(c.name);
    const imgUrl = sfFaceImg(sf, c.name);
    div.innerHTML = imgUrl
      ? `<img src="${esc(imgUrl)}" alt="${esc(c.name)}">`
      : `<div style="width:100%;aspect-ratio:0.716;background:var(--bg-elevated);border:1px solid var(--border);border-radius:3px;display:flex;align-items:center;justify-content:center;padding:4px;font-size:0.58rem;color:var(--text-primary);text-align:center;line-height:1.2">${esc(c.name)}</div>`;
    div.innerHTML += `<span class="zone-pick-card-name">${esc(c.name)}</span>`;
    div.addEventListener('click', () => {
      if (!isMulti) {
        modal.classList.add('hidden');
        sendDecision({ cardId: c.id });
      } else {
        if (selectedIds.has(c.id)) {
          selectedIds.delete(c.id);
          div.style.outline = '';
        } else if (selectedIds.size < maxSel) {
          selectedIds.add(c.id);
          div.style.outline = '2px solid var(--gold,#c8a96e)';
        }
        updateMultiCounter();
      }
    });
    if (!sf) fetchCardImage(c.name);
    return div;
  }

  function buildGrid(filter) {
    grid.innerHTML = '';
    const filtered = cards.filter(c => !filter || c.name.toLowerCase().includes(filter));

    // Group by owner if multiple owners present (e.g. Cemetery Gatekeeper showing both graveyards)
    const owners = [...new Set(filtered.map(c => c.owner).filter(Boolean))];
    if (owners.length > 1) {
      for (const owner of owners) {
        const group = filtered.filter(c => c.owner === owner);
        if (!group.length) continue;
        const header = document.createElement('div');
        header.style.cssText = 'width:100%;font-size:0.68rem;font-weight:700;color:var(--gold,#c8a96e);' +
          'padding:4px 2px 2px;border-bottom:1px solid rgba(200,169,110,0.3);margin-bottom:4px;';
        header.textContent = '⚰ Cimetière de ' + owner;
        grid.appendChild(header);
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;';
        group.forEach(c => row.appendChild(makeCardDiv(c)));
        grid.appendChild(row);
      }
    } else {
      filtered.forEach(c => grid.appendChild(makeCardDiv(c)));
    }
  }

  buildGrid('');
  if (search._zonePickHandler) search.removeEventListener('input', search._zonePickHandler);
  search._zonePickHandler = () => buildGrid(search.value.toLowerCase().trim());
  search.addEventListener('input', search._zonePickHandler);

  // Footer — appended inside zone-pick-inner (the visible panel), not the overlay
  const inner = modal.querySelector('.zone-pick-inner');
  const footer = document.getElementById('zone-pick-footer') || (() => {
    const f = document.createElement('div');
    f.id = 'zone-pick-footer';
    f.style.cssText = 'padding:8px 12px;display:flex;gap:8px;justify-content:flex-end;align-items:center;border-top:1px solid rgba(200,169,110,0.2)';
    (inner || modal).appendChild(f);
    return f;
  })();
  footer.innerHTML = '';

  let multiCounter = null;
  function updateMultiCounter() {
    if (multiCounter) multiCounter.textContent = selectedIds.size + ' / ' + maxSel + ' sélectionné(s)';
  }

  if (isMulti) {
    multiCounter = document.createElement('span');
    multiCounter.style.cssText = 'font-size:0.8rem;color:var(--text-muted,#888);flex:1;';
    updateMultiCounter();
    footer.appendChild(multiCounter);
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'decision-btn';
    confirmBtn.textContent = '✓ Confirmer';
    confirmBtn.addEventListener('click', () => {
      if (selectedIds.size < minSel) { multiCounter.style.color = '#f66'; updateMultiCounter(); return; }
      modal.classList.add('hidden');
      sendDecision({ cardIds: Array.from(selectedIds) });
    });
    footer.appendChild(confirmBtn);
  }

  if (data.optional) {
    const skipBtn = document.createElement('button');
    skipBtn.className = 'decision-btn pass';
    skipBtn.textContent = '✕ Ne rien choisir';
    skipBtn.addEventListener('click', () => { modal.classList.add('hidden'); sendDecision({ cardId: null }); });
    footer.appendChild(skipBtn);
  }
}

// ── Arrange modal (Scry / Surveil) ─────────────────────────────────────────

// ── Coin flip / starting player modal ─────────────────────────────────────

function showCoinFlipModal(data) {
  const isFirstGame = !!data.isFirstGame;
  const chooserName = data.chooserName || 'Player 1';
  const opponentName = data.opponentName || 'AI';

  let modal = document.createElement('div');
  modal.id = 'coin-modal';
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9500;background:rgba(0,0,0,0.82);display:flex;align-items:center;justify-content:center;';

  const panel = document.createElement('div');
  panel.style.cssText = 'background:var(--bg-panel,#1a1a2e);border:1px solid var(--gold,#c8a96e);border-radius:12px;padding:28px 36px;display:flex;flex-direction:column;align-items:center;gap:18px;min-width:320px;';

  if (isFirstGame) {
    // Title
    const title = document.createElement('div');
    title.style.cssText = 'font-size:1.3rem;font-weight:bold;color:var(--gold,#c8a96e);letter-spacing:0.05em;';
    title.textContent = 'Pile ou Face';
    panel.appendChild(title);

    // Coin animation container
    const coinWrap = document.createElement('div');
    coinWrap.style.cssText = 'perspective:400px;';
    const coin = document.createElement('div');
    coin.className = 'coin-spin';
    coin.innerHTML = '<span class="coin-face coin-front">🪙</span><span class="coin-face coin-back">🪙</span>';
    coinWrap.appendChild(coin);
    panel.appendChild(coinWrap);

    // Result text (appears after spin)
    const result = document.createElement('div');
    result.style.cssText = 'font-size:1rem;color:var(--text-primary,#e0d5c5);opacity:0;transition:opacity 0.4s;text-align:center;';
    result.innerHTML = `<b style="color:var(--gold,#c8a96e)">${esc(chooserName)}</b> remporte le toss !`;
    panel.appendChild(result);

    // Show result after spin
    setTimeout(() => { result.style.opacity = '1'; }, 1600);

    modal.appendChild(panel);
    document.body.appendChild(modal);

    // Show choice buttons after animation
    setTimeout(() => {
      addStartingPlayerButtons(panel, modal, chooserName, opponentName);
    }, 2200);
  } else {
    // Games 2+: loser of last game chooses
    const title = document.createElement('div');
    title.style.cssText = 'font-size:1.1rem;font-weight:bold;color:var(--gold,#c8a96e);text-align:center;';
    title.innerHTML = `Game ${matchState ? matchState.game : ''}<br><span style="font-size:0.85rem;font-weight:normal;color:var(--text-muted,#aaa)">Vous avez perdu la partie précédente — vous choisissez</span>`;
    panel.appendChild(title);
    modal.appendChild(panel);
    document.body.appendChild(modal);
    addStartingPlayerButtons(panel, modal, chooserName, opponentName);
  }
}

function showTossResultModal(data) {
  const tossWinner = data.tossWinnerName || 'AI';
  const firstPlayer = data.firstPlayerName || tossWinner;
  const isFirstGame = !!data.isFirstGame;

  const modal = document.createElement('div');
  modal.id = 'coin-modal';
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9500;background:rgba(0,0,0,0.82);display:flex;align-items:center;justify-content:center;';

  const panel = document.createElement('div');
  panel.style.cssText = 'background:var(--bg-panel,#1a1a2e);border:1px solid var(--gold,#c8a96e);border-radius:12px;padding:28px 36px;display:flex;flex-direction:column;align-items:center;gap:18px;min-width:320px;';

  if (isFirstGame) {
    const title = document.createElement('div');
    title.style.cssText = 'font-size:1.3rem;font-weight:bold;color:var(--gold,#c8a96e);letter-spacing:0.05em;';
    title.textContent = 'Pile ou Face';
    panel.appendChild(title);

    const coinWrap = document.createElement('div');
    coinWrap.style.cssText = 'perspective:400px;';
    const coin = document.createElement('div');
    coin.className = 'coin-spin';
    coin.innerHTML = '<span class="coin-face coin-front">🪙</span><span class="coin-face coin-back">🪙</span>';
    coinWrap.appendChild(coin);
    panel.appendChild(coinWrap);

    const result = document.createElement('div');
    result.style.cssText = 'font-size:1rem;color:var(--text-primary,#e0d5c5);opacity:0;transition:opacity 0.4s;text-align:center;';
    result.innerHTML = `<b style="color:var(--gold,#c8a96e)">${esc(tossWinner)}</b> remporte le toss !`;
    panel.appendChild(result);
    setTimeout(() => { result.style.opacity = '1'; }, 1600);
  } else {
    const title = document.createElement('div');
    title.style.cssText = 'font-size:1.1rem;font-weight:bold;color:var(--gold,#c8a96e);text-align:center;';
    title.innerHTML = `Game ${matchState ? matchState.game : ''}<br><span style="font-size:0.85rem;font-weight:normal;color:var(--text-muted,#aaa)">${esc(tossWinner)} choisit de commencer</span>`;
    panel.appendChild(title);
  }

  modal.appendChild(panel);
  document.body.appendChild(modal);

  const delay = isFirstGame ? 2200 : 0;
  setTimeout(() => {
    const btn = document.createElement('button');
    btn.className = 'btn-primary';
    btn.style.cssText = 'padding:10px 28px;font-size:0.95rem;margin-top:4px;';
    btn.textContent = 'OK';
    btn.addEventListener('click', () => {
      modal.remove();
      showFirstPlayerBanner(firstPlayer);
      sendDecision({});
    });
    panel.appendChild(btn);
  }, delay);
}

function addStartingPlayerButtons(panel, modal, chooserName, opponentName) {
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:12px;margin-top:4px;';

  const btnFirst = document.createElement('button');
  btnFirst.className = 'btn-primary';
  btnFirst.style.cssText = 'padding:10px 22px;font-size:0.95rem;';
  btnFirst.textContent = '⚔ Je commence';
  btnFirst.addEventListener('click', () => {
    modal.remove();
    showFirstPlayerBanner(chooserName);
    sendDecision({ goFirst: true });
  });

  const btnPass = document.createElement('button');
  btnPass.className = 'btn-secondary';
  btnPass.style.cssText = 'padding:10px 18px;font-size:0.95rem;';
  btnPass.textContent = `🤝 ${esc(opponentName)} commence`;
  btnPass.addEventListener('click', () => {
    modal.remove();
    showFirstPlayerBanner(opponentName);
    sendDecision({ goFirst: false });
  });

  btnRow.appendChild(btnFirst);
  btnRow.appendChild(btnPass);
  panel.appendChild(btnRow);
}

function showFirstPlayerBanner(playerName) {
  let banner = document.getElementById('first-player-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'first-player-banner';
    banner.style.cssText = `
      position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9000;
      background:rgba(15,25,35,0.95);border:2px solid var(--gold,#c8a96e);border-radius:10px;
      padding:18px 40px;font-size:1.4rem;font-weight:bold;color:var(--gold,#c8a96e);
      text-align:center;pointer-events:none;transition:opacity 0.6s;
    `;
    document.body.appendChild(banner);
  }
  banner.innerHTML = `⚔ <b>${esc(playerName)}</b> commence !`;
  banner.style.opacity = '1';
  setTimeout(() => { banner.style.opacity = '0'; setTimeout(() => banner.remove(), 700); }, 2500);
}

function showArrangeModal(type, data) {
  const isSurveil = type === 'ARRANGE_SURVEIL';
  const cards = data.cards || [];
  const keepLabel = isSurveil ? 'Garder en haut' : 'Mettre en haut';
  const discardLabel = isSurveil ? 'Envoyer au cimetière' : 'Mettre en bas';
  const title = isSurveil ? 'Surveil' : 'Scry';

  // decisions[cardId] = 'TOP' | 'BOTTOM' | 'GRAVE'  (default = keepZone)
  const decisions = {};
  for (const c of cards) decisions[c.id] = data.keepZone;

  // Build modal overlay
  let modal = document.getElementById('arrange-modal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'arrange-modal';
  modal.style.cssText = `
    position:fixed;top:0;left:0;right:0;bottom:0;z-index:9000;
    background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;
  `;

  const panel = document.createElement('div');
  panel.style.cssText = `
    background:var(--bg-panel,#1a1a2e);border:1px solid var(--gold,#c8a96e);border-radius:8px;
    padding:16px;max-width:90vw;max-height:85vh;overflow-y:auto;
    display:flex;flex-direction:column;gap:12px;min-width:320px;
  `;

  const h = document.createElement('div');
  h.style.cssText = 'font-size:1.1rem;font-weight:bold;color:var(--gold,#c8a96e);margin-bottom:4px;';
  h.textContent = title + ' — ' + cards.length + ' carte' + (cards.length > 1 ? 's' : '');
  panel.appendChild(h);

  const cardRows = document.createElement('div');
  cardRows.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

  for (const c of cards) {
    const row = document.createElement('div');
    row.dataset.card = c.name;
    row.style.cssText = `
      display:flex;align-items:center;gap:10px;padding:8px;
      border:1px solid rgba(200,169,110,0.3);border-radius:6px;background:rgba(0,0,0,0.3);
    `;

    // Card image — data-card on imgWrap so hover tooltip can find it
    const imgWrap = document.createElement('div');
    imgWrap.style.cssText = 'width:60px;flex-shrink:0;cursor:default;';
    imgWrap.dataset.card = c.name;
    const sf = scryfallCards.get(c.name);
    const imgUrl = sfFaceImg(sf, c.name) || scryfallCache.get(c.name) || '';
    if (imgUrl) {
      const img = document.createElement('img');
      img.src = imgUrl;
      img.style.cssText = 'width:60px;border-radius:4px;pointer-events:none;';
      imgWrap.appendChild(img);
    } else {
      imgWrap.innerHTML = `<div style="width:60px;height:84px;background:#222;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:0.55rem;color:#aaa;padding:2px;text-align:center">${esc(c.name)}</div>`;
      fetchCardImage(c.name).then(u => {
        if (u) imgWrap.innerHTML = `<img src="${u}" style="width:60px;border-radius:4px;pointer-events:none;" alt="${esc(c.name)}">`;
      });
    }
    row.appendChild(imgWrap);

    // Card name
    const name = document.createElement('div');
    name.style.cssText = 'flex:1;font-size:0.8rem;color:var(--text-primary,#e0d5c5);';
    name.textContent = c.name;
    if (c.manaCost) { name.textContent += ' — ' + c.manaCost; }
    row.appendChild(name);

    // Buttons
    const btnWrap = document.createElement('div');
    btnWrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;';

    function makeBtn(label, zone) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.dataset.zone = zone;
      btn.style.cssText = `
        padding:4px 8px;border-radius:4px;cursor:pointer;font-size:0.75rem;
        border:1px solid rgba(200,169,110,0.4);background:rgba(0,0,0,0.4);color:#ddd;
        transition:background 0.15s;
      `;
      btn.addEventListener('click', () => {
        decisions[c.id] = zone;
        btnWrap.querySelectorAll('button').forEach(b => {
          b.style.background = b.dataset.zone === zone
            ? 'rgba(200,169,110,0.4)' : 'rgba(0,0,0,0.4)';
          b.style.color = b.dataset.zone === zone ? '#fff' : '#ddd';
        });
      });
      if (decisions[c.id] === zone) {
        btn.style.background = 'rgba(200,169,110,0.4)';
        btn.style.color = '#fff';
      }
      return btn;
    }

    btnWrap.appendChild(makeBtn(keepLabel, data.keepZone));
    btnWrap.appendChild(makeBtn(discardLabel, data.discardZone));
    row.appendChild(btnWrap);
    cardRows.appendChild(row);
  }
  panel.appendChild(cardRows);

  // Confirm button
  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = '✓ Confirmer';
  confirmBtn.style.cssText = `
    margin-top:8px;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:0.9rem;
    background:var(--gold,#c8a96e);color:#1a1a2e;border:none;font-weight:bold;align-self:flex-end;
  `;
  confirmBtn.addEventListener('click', () => {
    modal.remove();
    const result = cards.map(c => ({ cardId: c.id, zone: decisions[c.id] }));
    sendDecision({ decisions: result });
  });
  panel.appendChild(confirmBtn);

  modal.appendChild(panel);
  document.body.appendChild(modal);
}

// ── Choose Mode modal ─────────────────────────────────────────────────────

function showChooseModeModal(data) {
  if (document.getElementById('choose-mode-modal')) return; // already open, don't recreate
  pausePolling = true; // freeze polling while modal is open

  const modes = data.modes || [];
  const num = data.num ?? 1;
  const min = data.min ?? 1;  // ?? not || to allow min=0 (optional triggers like Hullbreaker Horror)
  const allowRepeat = !!data.allowRepeat;
  const selected = []; // indices (may repeat if allowRepeat)

  const modal = document.createElement('div');
  modal.id = 'choose-mode-modal';
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9000;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';

  const panel = document.createElement('div');
  panel.style.cssText = 'background:var(--bg-panel,#1a1a2e);border:1px solid var(--gold,#c8a96e);border-radius:8px;padding:16px;max-width:500px;width:90vw;display:flex;flex-direction:column;gap:10px;';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:1rem;font-weight:bold;color:var(--gold,#c8a96e);';
  title.textContent = (data.card || '') + ' — Choisir ' + num + ' mode(s)';
  panel.appendChild(title);

  const counter = document.createElement('div');
  counter.style.cssText = 'font-size:0.8rem;color:var(--text-muted,#888);';
  panel.appendChild(counter);

  // Shows selected list for allowRepeat mode (e.g., "Mode 1, Mode 1, Mode 2")
  const selectionHistory = document.createElement('div');
  selectionHistory.style.cssText = 'font-size:0.75rem;color:var(--text-muted,#888);min-height:1em;';
  if (allowRepeat) panel.appendChild(selectionHistory);

  const modeBtns = [];

  function updateUI() {
    counter.style.color = 'var(--text-muted,#888)';
    counter.textContent = selected.length + ' / ' + num + ' sélectionné(s)';

    if (allowRepeat) {
      const full = selected.length >= num;
      modeBtns.forEach(b => { b.disabled = full; b.style.opacity = full ? '0.4' : '1'; b.style.cursor = full ? 'default' : 'pointer'; });
      undoBtn.style.display = selected.length > 0 ? '' : 'none';
      const names = selected.map(i => (i + 1) + '. ' + (modes[i]?.description || 'Mode ' + (i+1)));
      selectionHistory.textContent = names.length ? 'Sélectionnés : ' + names.join(', ') : '';
    } else {
      modeBtns.forEach((b, i) => {
        const isSelected = selected.includes(modes[i].index);
        b.style.background = isSelected ? 'rgba(200,169,110,0.25)' : 'rgba(0,0,0,0.4)';
        b.style.border = isSelected ? '1px solid rgba(200,169,110,0.7)' : '1px solid rgba(200,169,110,0.3)';
      });
    }
  }

  const modeList = document.createElement('div');
  modeList.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
  for (const m of modes) {
    const btn = document.createElement('button');
    btn.style.cssText = 'padding:8px 12px;border-radius:5px;cursor:pointer;text-align:left;border:1px solid rgba(200,169,110,0.3);background:rgba(0,0,0,0.4);color:#ddd;font-size:0.8rem;transition:background 0.1s;';
    btn.textContent = (m.index + 1) + '. ' + (m.description || 'Mode ' + (m.index+1));
    btn.addEventListener('click', () => {
      if (allowRepeat) {
        if (selected.length < num) { selected.push(m.index); updateUI(); }
      } else {
        const pos = selected.indexOf(m.index);
        if (pos >= 0) selected.splice(pos, 1);
        else selected.push(m.index);
        updateUI();
      }
    });
    modeBtns.push(btn);
    modeList.appendChild(btn);
  }
  panel.appendChild(modeList);

  // Undo last button — only shown for allowRepeat
  const undoBtn = document.createElement('button');
  undoBtn.textContent = '↩ Annuler le dernier';
  undoBtn.style.cssText = 'padding:5px 12px;border-radius:5px;cursor:pointer;border:1px solid rgba(200,169,110,0.4);background:rgba(0,0,0,0.3);color:#aaa;font-size:0.75rem;align-self:flex-start;display:none;';
  undoBtn.addEventListener('click', () => { if (selected.length > 0) { selected.pop(); updateUI(); } });
  if (allowRepeat) panel.appendChild(undoBtn);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

  // "Passer" button — only shown when min=0 (optional effect like Hullbreaker Horror)
  if (min === 0) {
    const passBtn2 = document.createElement('button');
    passBtn2.textContent = 'Passer';
    passBtn2.style.cssText = 'padding:8px 16px;border-radius:6px;cursor:pointer;background:transparent;color:#aaa;border:1px solid rgba(200,169,110,0.3);font-size:0.85rem;';
    passBtn2.addEventListener('click', async () => {
      modal.remove();
      await sendDecision({ indices: [] });
      pausePolling = false;
    });
    btnRow.appendChild(passBtn2);
  }

  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = '✓ Confirmer';
  confirmBtn.style.cssText = 'padding:8px 20px;border-radius:6px;cursor:pointer;background:var(--gold,#c8a96e);color:#1a1a2e;border:none;font-weight:bold;';
  confirmBtn.addEventListener('click', async () => {
    if (selected.length < min && modes.length > 0) {
      counter.style.color = '#f66';
      counter.textContent = 'Choisir au moins ' + min + ' mode(s)';
      return;
    }
    modal.remove();
    await sendDecision({ indices: selected });
    pausePolling = false;
  });
  btnRow.appendChild(confirmBtn);
  panel.appendChild(btnRow);
  modal.appendChild(panel);
  document.body.appendChild(modal);
  updateUI();
}

// ── Choose Number modal ────────────────────────────────────────────────────

function showChooseNumberModal(data) {
  if (document.getElementById('choose-number-modal')) return; // already open
  pausePolling = true;
  const min = data.min ?? 0;
  const max = data.max ?? 10;
  const values = data.values || null;

  const modal = document.createElement('div');
  modal.id = 'choose-number-modal';
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9000;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';

  const panel = document.createElement('div');
  panel.style.cssText = 'background:var(--bg-panel,#1a1a2e);border:1px solid var(--gold,#c8a96e);border-radius:8px;padding:20px;max-width:340px;width:90vw;display:flex;flex-direction:column;gap:12px;align-items:center;';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:0.95rem;font-weight:bold;color:var(--gold,#c8a96e);text-align:center;';
  title.textContent = data.prompt || 'Choisir un nombre';
  panel.appendChild(title);

  if (values) {
    // Show discrete value buttons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;justify-content:center;';
    for (const v of values) {
      const btn = document.createElement('button');
      btn.textContent = v;
      btn.style.cssText = 'padding:8px 14px;border-radius:5px;cursor:pointer;border:1px solid var(--gold,#c8a96e);background:rgba(0,0,0,0.4);color:#ddd;font-size:1rem;';
      btn.addEventListener('click', async () => { modal.remove(); await sendDecision({ number: v }); pausePolling = false; });
      btnRow.appendChild(btn);
    }
    panel.appendChild(btnRow);
  } else {
    // Show range input
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.min = min; inp.max = max; inp.value = min;
    inp.style.cssText = 'width:100px;padding:6px;text-align:center;font-size:1.2rem;border-radius:5px;border:1px solid var(--gold,#c8a96e);background:#1a1a2e;color:#ddd;';
    panel.appendChild(inp);

    const range = document.createElement('input');
    range.type = 'range';
    range.min = min; range.max = max; range.value = min;
    range.style.cssText = 'width:200px;';
    range.addEventListener('input', () => { inp.value = range.value; });
    inp.addEventListener('input', () => { range.value = inp.value; });
    panel.appendChild(range);

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = '✓ Confirmer';
    confirmBtn.style.cssText = 'padding:8px 20px;border-radius:6px;cursor:pointer;background:var(--gold,#c8a96e);color:#1a1a2e;border:none;font-weight:bold;';
    confirmBtn.addEventListener('click', async () => {
      modal.remove();
      await sendDecision({ number: parseInt(inp.value) || min });
      pausePolling = false;
    });
    panel.appendChild(confirmBtn);
  }
  modal.appendChild(panel);
  document.body.appendChild(modal);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatPhase(p) {
  const map = {
    UNTAP: 'Untap', UPKEEP: 'Upkeep', DRAW: 'Draw',
    MAIN1: 'Main 1',
    COMBAT_BEGIN: 'Begin Combat',
    COMBAT_DECLARE_ATTACKERS: 'Attackers',
    COMBAT_DECLARE_BLOCKERS: 'Blockers',
    COMBAT_FIRST_STRIKE_DAMAGE: '1st Strike',
    COMBAT_DAMAGE: 'Combat Dmg',
    COMBAT_END: 'End Combat',
    MAIN2: 'Main 2', ENDOFTURN: 'End of Turn', CLEANUP: 'Cleanup'
  };
  return map[p] || p || '?';
}

function formatDecisionType(t) {
  const map = {
    CHOOSE_ACTION: 'Priority', DECLARE_ATTACKERS: 'Declare Attackers',
    DECLARE_BLOCKERS: 'Declare Blockers', MULLIGAN: 'Mulligan',
    CHOOSE_TARGETS: 'Choisir une cible',
    CONFIRM_ACTION: 'Confirmer', CONFIRM_TRIGGER: 'Trigger optionnel'
  };
  return map[t] || t || '?';
}

// ── Mulligan tuck panel ────────────────────────────────────────────────────

function showMulliganTuckPanel(data) {
  const panel    = document.getElementById('mulligan-tuck-panel');
  const body     = document.getElementById('mulligan-tuck-body');
  const hint     = document.getElementById('mulligan-tuck-hint');
  const confirm  = document.getElementById('mulligan-tuck-confirm');
  const header   = document.getElementById('mulligan-tuck-drag');
  if (!panel) return;

  const cards = data.hand || [];
  const need  = data.cardsToReturn || 0;
  const selected = new Set();

  panel.style.left = ''; panel.style.top = ''; panel.style.transform = '';
  panel.classList.remove('hidden');
  body.innerHTML = '';
  confirm.disabled = true;

  function updateHint() {
    hint.textContent = `${selected.size} / ${need} sélectionnée${need > 1 ? 's' : ''}`;
    confirm.disabled = selected.size !== need;
  }
  updateHint();

  for (const c of cards) {
    const wrap = document.createElement('div');
    wrap.className = 'mulligan-tuck-card';
    wrap.dataset.cardId = c.id;
    wrap.dataset.card = c.name;

    const img = document.createElement('img');
    img.alt = c.name;
    img.src = '';
    const nameLabel = document.createElement('div');
    nameLabel.className = 'card-name-label';
    nameLabel.textContent = c.name;
    wrap.appendChild(img);
    wrap.appendChild(nameLabel);

    // Load image
    const sf = scryfallCards.get(c.name);
    const url = sfFaceImg(sf, c.name) || scryfallCache.get(c.name) || '';
    if (url) img.src = url;
    else fetchCardImage(c.name).then(u => { if (u) img.src = u; });

    wrap.addEventListener('click', () => {
      if (selected.has(c.id)) {
        selected.delete(c.id);
        wrap.classList.remove('selected');
      } else if (selected.size < need) {
        selected.add(c.id);
        wrap.classList.add('selected');
      }
      updateHint();
    });
    body.appendChild(wrap);
  }

  // Draggable
  let dragging = false, ox = 0, oy = 0;
  header.onmousedown = e => {
    if (e.button !== 0) return;
    dragging = true;
    if (!panel.style.left || panel.style.left === '') {
      const r = panel.getBoundingClientRect();
      panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px';
      panel.style.transform = 'none';
    }
    ox = e.clientX - panel.getBoundingClientRect().left;
    oy = e.clientY - panel.getBoundingClientRect().top;
    e.preventDefault();
  };
  const onMove = e => { if (dragging) { panel.style.left = (e.clientX-ox)+'px'; panel.style.top = (e.clientY-oy)+'px'; } };
  const onUp   = () => { dragging = false; };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);

  confirm.onclick = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    panel.classList.add('hidden');
    sendDecision({ cardIds: [...selected] });
  };
}

// ── Confirm panel (floating YES/NO dialog) ─────────────────────────────────

(function initConfirmPanel() {
  const panel   = document.getElementById('confirm-panel');
  const handle  = document.getElementById('confirm-drag-handle');
  const textEl  = document.getElementById('confirm-panel-text');
  const cardEl  = document.getElementById('confirm-panel-card-wrap');
  const yesBtn  = document.getElementById('confirm-btn-yes');
  const noBtn   = document.getElementById('confirm-btn-no');
  if (!panel) return;

  function makeDraggable(p, h) {
    let dragging = false, ox = 0, oy = 0;
    h.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      dragging = true;
      if (!p.style.left || p.style.left === '') {
        const r = p.getBoundingClientRect();
        p.style.left = r.left + 'px'; p.style.top = r.top + 'px';
        p.style.transform = 'none';
      }
      ox = e.clientX - p.getBoundingClientRect().left;
      oy = e.clientY - p.getBoundingClientRect().top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      p.style.left = (e.clientX - ox) + 'px';
      p.style.top  = (e.clientY - oy) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }
  makeDraggable(panel, handle);

  window.showConfirmPanel = function(text, cardName, onYes, onNo) {
    textEl.textContent = text;
    cardEl.textContent = cardName ? '📋 ' + cardName : '';
    // Re-center each time
    panel.style.left = ''; panel.style.top = ''; panel.style.transform = '';
    panel.classList.remove('hidden');

    const cleanup = () => { panel.classList.add('hidden'); yesBtn.onclick = null; noBtn.onclick = null; };
    yesBtn.onclick = () => { cleanup(); onYes(); };
    noBtn.onclick  = () => { cleanup(); onNo(); };
  };
})();

// ── Stack window drag ──────────────────────────────────────────────────────

// Stack panel is now fixed to the right side — no dragging needed

// ── Targeting mode ─────────────────────────────────────────────────────────

let _zonePileTargetCleanup = null; // set by enterTargetingMode, called by cleanupTargeting

function enterTargetingMode(data) {
  pausePolling = true; // freeze re-renders while targeting
  const validTargets = data.validTargets || [];
  const min = data.min ?? 1;
  const max = data.max ?? 1;
  const spellName = data.spell || '';
  const isDivided = !!data.isDivided;
  const dividedTotal = data.dividedTotal || 0;

  // Build sets of valid target IDs
  const validCardIds = new Set();
  const validPlayerIds = new Set();
  for (const t of validTargets) {
    if (t.kind === 'card') validCardIds.add(String(t.id));
    else if (t.kind === 'player') validPlayerIds.add(String(t.id));
  }

  const chosen = [];
  // dividedAllocations: targetId → damage amount
  const dividedAllocations = {};

  // Update decision bar label
  const typeEl = document.getElementById('decision-type');
  const btnsEl = document.getElementById('decision-buttons');
  btnsEl.innerHTML = '';

  const targetLabel = isDivided
    ? `Distribuer ${dividedTotal} dégâts — ${spellName}`
    : `Cibler pour ${spellName} (${min === max ? min : min + '–' + max} cible${max > 1 ? 's' : ''})`;
  typeEl.textContent = targetLabel;

  if (data.description) {
    const hint = document.createElement('span');
    hint.className = 'decision-hint';
    hint.style.cssText = 'font-size:0.72rem;color:var(--text-muted,#999);max-width:320px;white-space:normal;line-height:1.3;';
    hint.innerHTML = formatMtgText(data.description);
    btnsEl.appendChild(hint);
  }

  // Target chips container — filled by refreshChips() after onTargetClick is defined
  const chipsWrap = document.createElement('div');
  chipsWrap.id = 'target-chips';
  chipsWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;align-items:center;max-width:500px;margin-top:2px;';
  btnsEl.appendChild(chipsWrap);

  // Remaining damage counter (only for divided spells)
  let remainingEl = null;
  if (isDivided) {
    remainingEl = document.createElement('span');
    remainingEl.className = 'decision-hint';
    remainingEl.style.cssText = 'font-size:0.85rem;font-weight:700;color:var(--gold,#c8a96e);margin-left:8px;';
    updateRemainingLabel();
    btnsEl.appendChild(remainingEl);
  }

  function getRemainingDamage() {
    const used = Object.values(dividedAllocations).reduce((a, b) => a + b, 0);
    return dividedTotal - used;
  }

  function updateRemainingLabel() {
    if (!remainingEl) return;
    const rem = getRemainingDamage();
    remainingEl.textContent = rem > 0 ? `⚡ ${rem} dégât${rem > 1 ? 's' : ''} restant${rem > 1 ? 's' : ''}` : '✓ Tous les dégâts distribués';
    remainingEl.style.color = rem === 0 ? 'var(--accent-win,#4caf7d)' : 'var(--gold,#c8a96e)';
  }

  // Build a floating damage badge on a targeted element
  function createDamageBadge(el, id) {
    let badge = el.querySelector('.dmg-allocation-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'dmg-allocation-badge';
      badge.style.cssText = 'position:absolute;top:2px;left:2px;z-index:20;' +
        'display:flex;align-items:center;gap:2px;background:rgba(0,0,0,0.85);' +
        'border:1px solid var(--gold,#c8a96e);border-radius:6px;padding:2px 4px;';
      el.style.position = 'relative';
      el.appendChild(badge);
    }
    const amt = dividedAllocations[id] || 1;
    badge.innerHTML = '';

    const minusBtn = document.createElement('button');
    minusBtn.textContent = '−';
    minusBtn.style.cssText = 'background:none;border:none;color:#fff;cursor:pointer;font-size:1rem;line-height:1;padding:0 3px;';
    minusBtn.onclick = e => {
      e.stopPropagation();
      const cur = dividedAllocations[id] || 1;
      if (cur <= 1) return; // minimum 1 damage per target
      dividedAllocations[id] = cur - 1;
      updateDamageBadge(el, id);
      updateRemainingLabel();
      updateConfirmBtn();
    };

    const valueEl = document.createElement('span');
    valueEl.style.cssText = 'min-width:18px;text-align:center;font-size:0.9rem;font-weight:700;color:var(--gold,#c8a96e);';
    valueEl.textContent = amt;

    const plusBtn = document.createElement('button');
    plusBtn.textContent = '+';
    plusBtn.style.cssText = 'background:none;border:none;color:#fff;cursor:pointer;font-size:1rem;line-height:1;padding:0 3px;';
    plusBtn.onclick = e => {
      e.stopPropagation();
      if (getRemainingDamage() <= 0) return; // no more damage to assign
      dividedAllocations[id] = (dividedAllocations[id] || 1) + 1;
      updateDamageBadge(el, id);
      updateRemainingLabel();
      updateConfirmBtn();
    };

    badge.appendChild(minusBtn);
    badge.appendChild(valueEl);
    badge.appendChild(plusBtn);
  }

  function updateDamageBadge(el, id) {
    const badge = el.querySelector('.dmg-allocation-badge');
    if (!badge) return;
    const valueEl = badge.querySelector('span');
    if (valueEl) valueEl.textContent = dividedAllocations[id] || 1;
  }

  function removeDamageBadge(el) {
    el.querySelector('.dmg-allocation-badge')?.remove();
  }

  function updateConfirmBtn() {
    const confirmBtn = document.getElementById('targeting-confirm-btn');
    if (!confirmBtn) return;
    if (isDivided) {
      // Valid when: at least min targets AND either 0 targets chosen OR all damage distributed
      const valid = chosen.length >= min && (chosen.length === 0 || getRemainingDamage() === 0);
      confirmBtn.classList.toggle('hidden', !valid);
    } else {
      confirmBtn.classList.toggle('hidden', chosen.length < min);
    }
  }

  // Highlight valid cards (battlefield, hand, and stack)
  document.querySelectorAll('.bf-card, .hand-card, .stack-item').forEach(el => {
    const cid = el.dataset.cardId;
    if (cid && validCardIds.has(cid)) el.classList.add('targetable');
  });

  // Highlight valid players (life element)
  document.querySelectorAll('.play-life[data-player-id]').forEach(el => {
    if (validPlayerIds.has(el.dataset.playerId)) el.classList.add('targetable');
  });

  // Single delegated click handler — catches clicks on targetable elements and their children
  function onDocTargetClick(e) {
    if (e.target.closest('.dmg-allocation-badge')) return;
    const el = e.target.closest('.bf-card[data-card-id], .hand-card[data-card-id], .stack-item[data-card-id], .play-life[data-player-id]');
    if (!el || !el.classList.contains('targetable')) return;
    const cid = el.dataset.cardId;
    const pid = el.dataset.playerId;
    const id = cid ? String(cid) : (pid ? String(pid) : null);
    if (!id) return;

    if (el.classList.contains('targeted')) {
      el.classList.remove('targeted');
      const idx = chosen.indexOf(id);
      if (idx !== -1) chosen.splice(idx, 1);
      if (isDivided) { delete dividedAllocations[id]; removeDamageBadge(el); updateRemainingLabel(); }
    } else if (chosen.length < max) {
      if (isDivided && dividedTotal > 0 && getRemainingDamage() <= 0) return;
      el.classList.add('targeted');
      chosen.push(id);
      if (isDivided) {
        const rem = getRemainingDamage();
        dividedAllocations[id] = (chosen.length >= max || rem === 1) ? rem : 1;
        createDamageBadge(el, id);
        updateRemainingLabel();
      }
    } else if (!isDivided && chosen.length === max) {
      // Swap target
      document.querySelectorAll('.targeted').forEach(t => t.classList.remove('targeted'));
      chosen.length = 0;
      el.classList.add('targeted');
      chosen.push(id);
    }
    updateConfirmBtn();
    drawLiveTargetingArrows(data.sourceCardId, chosen);
    refreshChips();
    e.stopPropagation();
  }
  document.addEventListener('click', onDocTargetClick, true); // capture phase — fires before other handlers

  // Store for cleanup
  const _docTargetCleanup = () => document.removeEventListener('click', onDocTargetClick, true);

  // Highlight zone piles (graveyard, exile, hand) when valid targets exist there
  const zoneTargetsByPile = {}; // pileId → [{id, name, zone}, ...]
  const players = playState?.players || [];
  const prefixes = ['self', 'opp'];
  const zoneMap = { Graveyard: 'gy', Exile: 'exile' };
  for (let pi = 0; pi < players.length; pi++) {
    const pfx = prefixes[pi] || ('p' + pi);
    for (const [zoneName, suffix] of Object.entries(zoneMap)) {
      const pileId = pfx + '-' + suffix + '-pile';
      const zoneCards = players[pi][zoneName.toLowerCase()] || [];
      const validHere = zoneCards.filter(c => validCardIds.has(String(c.id)));
      if (validHere.length) zoneTargetsByPile[pileId] = validHere.map(c => ({ ...c, zone: zoneName }));
    }
  }
  const overriddenOnclicks = {};
  for (const [pileId, targets] of Object.entries(zoneTargetsByPile)) {
    const pileEl = document.getElementById(pileId);
    if (!pileEl) continue;
    overriddenOnclicks[pileId] = pileEl.onclick;
    pileEl.classList.add('targetable');
    pileEl.onclick = () => {
      // Open a targeting picker showing only valid targets from this zone
      const modal = document.getElementById('zone-pick-modal');
      const titleEl = document.getElementById('zone-pick-title');
      const grid = document.getElementById('zone-pick-grid');
      const searchEl = document.getElementById('zone-pick-search');
      if (!modal) return;
      titleEl.textContent = `Cibler — ${targets[0]?.zone || 'Zone'} (${spellName})`;
      searchEl.value = '';
      grid.innerHTML = '';
      modal.classList.remove('hidden');

      function makeTargetDiv(c) {
        const div = document.createElement('div');
        div.className = 'zone-pick-card fetchable targetable';
        div.dataset.cardId = String(c.id);
        div.dataset.card = c.name;
        const sf = scryfallCards.get(c.name);
        const imgUrl = sfFaceImg(sf, c.name) || scryfallCache.get(c.name) || '';
        div.innerHTML = imgUrl
          ? `<img src="${esc(imgUrl)}" alt="${esc(c.name)}">`
          : `<div style="width:100%;aspect-ratio:0.716;background:var(--bg-elevated);border:1px solid var(--border);border-radius:3px;display:flex;align-items:center;justify-content:center;padding:4px;font-size:0.58rem;color:var(--text-primary);text-align:center;line-height:1.2">${esc(c.name)}</div>`;
        div.innerHTML += `<span class="zone-pick-card-name">${esc(c.name)}</span>`;
        if (!imgUrl) fetchCardImage(c.name).then(u => { if (u) div.querySelector('img,div')?.replaceWith(Object.assign(document.createElement('img'), {src: u, alt: c.name})); });
        div.addEventListener('click', () => {
          const cid = String(c.id);
          if (!chosen.includes(cid)) {
            if (chosen.length < max) {
              chosen.push(cid);
            } else {
              // Swap: replace oldest target with this one
              const oldId = chosen.shift();
              const oldEl = document.querySelector(`[data-card-id="${oldId}"].targeted`);
              if (oldEl) oldEl.classList.remove('targeted');
              chosen.push(cid);
            }
          }
          modal.classList.add('hidden');
          grid.innerHTML = '';
          drawLiveTargetingArrows(data.sourceCardId, chosen);
          if (chosen.length >= min && chosen.length <= max) {
            cleanupTargeting();
            const payload = { targets: chosen };
            sendDecision(payload);
            pausePolling = false;
          } else {
            updateConfirmBtn();
          }
        });
        return div;
      }

      function buildTargetGrid(filter) {
        grid.innerHTML = '';
        const filtered = filter ? targets.filter(c => c.name.toLowerCase().includes(filter)) : targets;
        filtered.forEach(c => grid.appendChild(makeTargetDiv(c)));
      }

      buildTargetGrid('');
      if (searchEl._zonePickHandler) searchEl.removeEventListener('input', searchEl._zonePickHandler);
      searchEl._zonePickHandler = () => buildTargetGrid(searchEl.value.toLowerCase().trim());
      searchEl.addEventListener('input', searchEl._zonePickHandler);

      // Close button
      const inner = modal.querySelector('.zone-pick-inner');
      let footer = document.getElementById('zone-pick-footer');
      if (!footer) {
        footer = document.createElement('div');
        footer.id = 'zone-pick-footer';
        footer.style.cssText = 'padding:8px 12px;display:flex;gap:8px;justify-content:flex-end;align-items:center;border-top:1px solid rgba(200,169,110,0.2)';
        (inner || modal).appendChild(footer);
      }
      footer.innerHTML = '';
      const closeBtn = document.createElement('button');
      closeBtn.className = 'btn-secondary btn-sm';
      closeBtn.textContent = 'Fermer';
      closeBtn.onclick = () => modal.classList.add('hidden');
      footer.appendChild(closeBtn);
    };
  }

  // Register zone pile cleanup so cleanupTargeting() can restore original onclicks
  _zonePileTargetCleanup = () => {
    _docTargetCleanup(); // remove delegated click handler
    for (const [pileId, origOnclick] of Object.entries(overriddenOnclicks)) {
      const pileEl = document.getElementById(pileId);
      if (pileEl) pileEl.onclick = origOnclick;
    }
  };

  // Cancel button
  const cancelBtn = makeDecisionBtn('✕ Annuler', 'pass', cancelTargeting);
  btnsEl.appendChild(cancelBtn);

  // Confirm button (shown when enough targets selected)
  const confirmBtn = makeDecisionBtn('✓ Confirmer', 'confirm hidden', confirmTargets);
  confirmBtn.id = 'targeting-confirm-btn';
  btnsEl.appendChild(confirmBtn);

  // If targeting is optional (min=0) and not divided, confirm is valid immediately
  if (min === 0 && !isDivided) confirmBtn.classList.remove('hidden');

  // Chip click handler — direct manipulation of chosen[], no DOM click needed
  function onChipClick(t) {
    const id = String(t.id);
    const idx = chosen.indexOf(id);
    if (idx !== -1) {
      // Deselect
      chosen.splice(idx, 1);
      if (isDivided) { delete dividedAllocations[id]; updateRemainingLabel(); }
      // Sync DOM element visual
      const domEl = document.querySelector(`[data-card-id="${id}"].targeted, [data-player-id="${id}"].targeted`);
      if (domEl) { domEl.classList.remove('targeted'); if (isDivided) removeDamageBadge(domEl); }
    } else if (!isDivided && chosen.length === max) {
      // Swap
      chosen.forEach(oldId => {
        const el = document.querySelector(`[data-card-id="${oldId}"].targeted, [data-player-id="${oldId}"].targeted`);
        if (el) el.classList.remove('targeted');
      });
      chosen.length = 0;
      chosen.push(id);
      const domEl = document.querySelector(`[data-card-id="${id}"].targetable, [data-player-id="${id}"].targetable`);
      if (domEl) domEl.classList.add('targeted');
    } else if (chosen.length < max) {
      if (isDivided && dividedTotal > 0 && getRemainingDamage() <= 0) return;
      chosen.push(id);
      if (isDivided) {
        const rem = getRemainingDamage();
        dividedAllocations[id] = chosen.length >= max ? rem : 1;
        const domEl = document.querySelector(`[data-card-id="${id}"].targetable`);
        if (domEl) createDamageBadge(domEl, id);
        updateRemainingLabel();
      } else {
        const domEl = document.querySelector(`[data-card-id="${id}"].targetable, [data-player-id="${id}"].targetable`);
        if (domEl) domEl.classList.add('targeted');
      }
    } else { return; }
    updateConfirmBtn();
    drawLiveTargetingArrows(data.sourceCardId, chosen);
    refreshChips();
  }

  function refreshChips() {
    chipsWrap.innerHTML = '';
    for (const t of validTargets) {
      const id = String(t.id);
      const isChosen = chosen.includes(id);
      const chip = document.createElement('button');
      chip.className = 'target-chip' + (isChosen ? ' target-chip-active' : '');
      const zoneLabel = t.zone && t.zone !== 'Battlefield' ? ` [${t.zone}]` : '';
      chip.textContent = t.name + zoneLabel;
      chip.addEventListener('click', () => onChipClick(t));
      chipsWrap.appendChild(chip);
    }
  }
  refreshChips();

  async function cancelTargeting() {
    cleanupTargeting();
    await sendDecision({ targets: [] });
    pausePolling = false;
  }

  async function confirmTargets() {
    cleanupTargeting();
    const payload = { targets: chosen };
    if (isDivided) payload.dividedAllocations = { ...dividedAllocations };
    await sendDecision(payload);
    pausePolling = false;
  }
}

// ── Order Zone mode (Ponder, Brainstorm…) ─────────────────────────────────

function enterOrderZoneMode(data) {
  if (document.getElementById('order-zone-modal')) return; // already open
  pausePolling = true;
  const cards = data.cards || [];       // [{id, name}, …] — original order
  const spellName = data.spell || 'Réordonner';
  const prompt = data.prompt || 'Arrange les cartes (gauche = dessus de bibliothèque)';

  // Working copy — display order = top → bottom
  let order = [...cards];

  const modal = document.createElement('div');
  modal.id = 'order-zone-modal';
  modal.className = 'order-zone-modal';

  const header = document.createElement('div');
  header.className = 'order-zone-header';
  header.textContent = spellName + ' — ' + prompt;
  modal.appendChild(header);

  const row = document.createElement('div');
  row.className = 'order-zone-row';
  modal.appendChild(row);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn-primary btn-sm order-zone-confirm';
  confirmBtn.textContent = '✓ Confirmer';
  confirmBtn.addEventListener('click', async () => {
    const ids = order.map(c => c.id);
    document.getElementById('order-zone-modal')?.remove();
    await sendDecision({ order: ids });
    pausePolling = false;
  });
  modal.appendChild(confirmBtn);

  function render() {
    row.innerHTML = '';
    order.forEach((card, idx) => {
      const wrap = document.createElement('div');
      wrap.className = 'order-zone-card';

      const label = document.createElement('div');
      label.className = 'order-zone-pos';
      label.textContent = idx === 0 ? '▲ Dessus' : idx === order.length - 1 ? '▼ Dessous' : (idx + 1) + '';
      wrap.appendChild(label);

      const img = document.createElement('img');
      img.alt = card.name;
      img.className = 'order-zone-img';
      const cached = scryfallCache.get(card.name);
      if (cached) img.src = cached;
      else { img.src = ''; fetchCardImage(card.name).then(u => { if (u) img.src = u; }); }
      wrap.appendChild(img);

      const name = document.createElement('div');
      name.className = 'order-zone-name';
      name.textContent = card.name;
      wrap.appendChild(name);

      // Arrow buttons
      const arrows = document.createElement('div');
      arrows.className = 'order-zone-arrows';
      if (idx > 0) {
        const left = document.createElement('button');
        left.className = 'order-zone-arrow';
        left.textContent = '◀';
        left.title = 'Monter (vers le dessus)';
        left.addEventListener('click', () => {
          [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
          render();
        });
        arrows.appendChild(left);
      }
      if (idx < order.length - 1) {
        const right = document.createElement('button');
        right.className = 'order-zone-arrow';
        right.textContent = '▶';
        right.title = 'Descendre (vers le dessous)';
        right.addEventListener('click', () => {
          [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
          render();
        });
        arrows.appendChild(right);
      }
      wrap.appendChild(arrows);
      row.appendChild(wrap);
    });
  }

  render();
  document.getElementById('play-board').appendChild(modal);
}

function cleanupTargeting() {
  // pausePolling is reset by the caller after sendDecision completes
  // _zonePileTargetCleanup also removes the delegated document click handler
  if (_zonePileTargetCleanup) { _zonePileTargetCleanup(); _zonePileTargetCleanup = null; }
  document.querySelectorAll('.targetable, .targeted').forEach(el => {
    el.classList.remove('targetable', 'targeted');
    el.querySelector('.dmg-allocation-badge')?.remove();
  });
}

// ── Attacker select mode ───────────────────────────────────────────────────

let _attackerSelectCleanup = null;

function enterAttackerSelectMode(data) {
  pausePolling = true;
  const attackerOptions  = data.attackers || [];
  const defenders        = data.defenders || [];
  const defId            = defenders.length ? defenders[0].id : null;
  const attackableIds    = new Set(attackerOptions.map(a => String(a.id)));
  const requiredIds      = new Set((data.requiredAttackers || []).map(String));
  const selected         = new Set(requiredIds); // pre-select required attackers

  const typeEl = document.getElementById('decision-type');
  const btnsEl = document.getElementById('decision-buttons');
  const label = requiredIds.size > 0
    ? 'Déclarer les attaquants — ' + requiredIds.size + ' doit(vent) attaquer'
    : 'Déclarer les attaquants — clic pour sélectionner';
  typeEl.textContent = label;
  btnsEl.innerHTML = '';

  btnsEl.appendChild(makeDecisionBtn('Pas d\'attaque', 'pass', async () => {
    cleanup(); await sendDecision({ assignments: [] }); pausePolling = false;
  }));
  const confirmBtn = makeDecisionBtn('Confirmer attaque (' + selected.size + ')', 'confirm', async () => {
    const assignments = defId ? [...selected].map(id => `${id}:${defId}`) : [];
    cleanup(); await sendDecision({ assignments }); pausePolling = false;
  });
  confirmBtn.id = 'attacker-confirm-btn';
  btnsEl.appendChild(confirmBtn);

  document.querySelectorAll('#self-bf-creatures .bf-card, #self-bf-other .bf-card').forEach(el => {
    if (!attackableIds.has(el.dataset.cardId)) return;
    if (requiredIds.has(el.dataset.cardId)) {
      el.classList.add('selected-attacker'); // pre-selected, locked — must attack
      // Required attackers can't be deselected; show a lock title
      el.title = (el.title ? el.title + ' — ' : '') + 'Doit attaquer';
    } else {
      el.classList.add('attackable');
      el.addEventListener('click', onClick);
    }
  });

  function onClick(e) {
    const el = e.currentTarget;
    const cid = el.dataset.cardId;
    if (selected.has(cid)) {
      selected.delete(cid);
      el.classList.remove('selected-attacker'); el.classList.add('attackable');
    } else {
      selected.add(cid);
      el.classList.remove('attackable'); el.classList.add('selected-attacker');
    }
    const btn = document.getElementById('attacker-confirm-btn');
    if (btn) btn.textContent = 'Confirmer attaque (' + selected.size + ')';
    e.stopPropagation();
  }

  function cleanup() {
    document.querySelectorAll('.attackable, .selected-attacker').forEach(el => {
      // Suppress the transform transition so the card snaps instantly back
      // instead of animating from 85deg → 90deg (visible "tilt" artefact)
      el.style.transition = 'none';
      el.classList.remove('attackable', 'selected-attacker');
      requestAnimationFrame(() => el.style.removeProperty('transition'));
      el.removeEventListener('click', onClick);
    });
    _attackerSelectCleanup = null;
  }
  _attackerSelectCleanup = cleanup;
}

function cleanupAttackerSelect() {
  if (_attackerSelectCleanup) _attackerSelectCleanup();
}

// ── Blocker assign mode ────────────────────────────────────────────────────

let _blockerAssignCleanup = null;

function enterBlockerAssignMode(data) {
  pausePolling = true;
  const blockerOptions = data.blockers  || [];
  const attackerList   = data.attackers || [];
  const blockableIds   = new Set(blockerOptions.map(b => String(b.id)));
  const attackerIds    = new Set(attackerList.map(a => String(a.id)));
  const attackerNames  = Object.fromEntries(attackerList.map(a => [String(a.id), a.name]));
  const assignments    = new Map(); // blockerId → attackerId
  let selectedBid      = null;     // blocker currently selected (step 1)

  const typeEl = document.getElementById('decision-type');
  const btnsEl = document.getElementById('decision-buttons');
  typeEl.textContent = 'Bloqueurs — clique une créature, puis un attaquant';
  btnsEl.innerHTML = '';

  btnsEl.appendChild(makeDecisionBtn('Pas de blocage', 'pass', async () => {
    cleanup(); await sendDecision({ assignments: [] }); pausePolling = false;
  }));
  const confirmBtn = makeDecisionBtn('Confirmer (0)', 'confirm', async () => {
    const list = [...assignments.entries()].map(([b, a]) => `${b}:${a}`);
    cleanup(); await sendDecision({ assignments: list }); pausePolling = false;
  });
  confirmBtn.id = 'blocker-confirm-btn';
  btnsEl.appendChild(confirmBtn);

  function refresh() {
    document.querySelectorAll('#self-bf-creatures .bf-card, #self-bf-other .bf-card').forEach(el => {
      if (!blockableIds.has(el.dataset.cardId)) return;
      const cid = el.dataset.cardId;
      el.classList.remove('blockable', 'blocker-selected', 'blocker-assigned');
      el.querySelector('.bf-block-badge')?.remove();
      if (cid === selectedBid) {
        el.classList.add('blocker-selected');
      } else if (assignments.has(cid)) {
        el.classList.add('blocker-assigned');
        const badge = document.createElement('span'); badge.className = 'bf-block-badge';
        badge.textContent = '→ ' + (attackerNames[assignments.get(cid)] || '?');
        el.appendChild(badge);
      } else {
        el.classList.add('blockable');
      }
    });
    document.querySelectorAll('#opp-bf-creatures .bf-card').forEach(el => {
      el.classList.remove('blocker-target-atk');
      if (selectedBid && attackerIds.has(el.dataset.cardId)) el.classList.add('blocker-target-atk');
    });
  }

  function onBlockerClick(e) {
    const cid = e.currentTarget.dataset.cardId;
    if (!blockableIds.has(cid)) return;
    selectedBid = (selectedBid === cid) ? null : cid;
    refresh(); e.stopPropagation();
  }

  function onAttackerClick(e) {
    if (!selectedBid) return;
    const aid = e.currentTarget.dataset.cardId;
    if (!attackerIds.has(aid)) return;
    assignments.set(selectedBid, aid);
    selectedBid = null;
    const btn = document.getElementById('blocker-confirm-btn');
    if (btn) btn.textContent = 'Confirmer (' + assignments.size + ')';
    refresh(); e.stopPropagation();
  }

  document.querySelectorAll('#self-bf-creatures .bf-card, #self-bf-other .bf-card').forEach(el => {
    if (blockableIds.has(el.dataset.cardId)) { el.classList.add('blockable'); el.addEventListener('click', onBlockerClick); }
  });
  document.querySelectorAll('#opp-bf-creatures .bf-card').forEach(el => {
    if (attackerIds.has(el.dataset.cardId)) el.addEventListener('click', onAttackerClick);
  });

  function cleanup() {
    document.querySelectorAll('.blockable,.blocker-selected,.blocker-assigned,.blocker-target-atk').forEach(el => {
      el.classList.remove('blockable', 'blocker-selected', 'blocker-assigned', 'blocker-target-atk');
      el.querySelector('.bf-block-badge')?.remove();
    });
    document.querySelectorAll('#self-bf-creatures .bf-card, #self-bf-other .bf-card').forEach(el => el.removeEventListener('click', onBlockerClick));
    document.querySelectorAll('#opp-bf-creatures .bf-card').forEach(el => el.removeEventListener('click', onAttackerClick));
    _blockerAssignCleanup = null;
  }
  _blockerAssignCleanup = cleanup;
}

function cleanupBlockerAssign() {
  if (_blockerAssignCleanup) _blockerAssignCleanup();
}

// ── Lazy image loader (IntersectionObserver) ──────────────────────────────
const lazyImgObserver = new IntersectionObserver(entries => {
  entries.forEach(async entry => {
    if (!entry.isIntersecting) return;
    const img = entry.target;
    const name = img.dataset.lazyCard;
    if (!name) return;
    lazyImgObserver.unobserve(img);
    const url = await fetchCardImage(name);
    if (url) {
      img.src = url;
      img.style.display = '';
    } else {
      img.remove(); // no image found — keep text-only layout
    }
  });
}, { rootMargin: '100px' });

function makeLazyCardImg(cardName) {
  const img = document.createElement('img');
  img.dataset.lazyCard = cardName;
  img.alt = cardName;
  img.style.cssText = 'width:100%;border-radius:5px;display:none';
  lazyImgObserver.observe(img);
  return img;
}

// ── Deck Builder ───────────────────────────────────────────────────────────

let builderDeck = { name: '', format: 'Commander', commander: [], mainboard: [] };
let builderInited = false;
let builderViewMode = localStorage.getItem('builder:viewMode') || 'list';   // 'list' | 'visual'
let builderSortBy   = localStorage.getItem('builder:sortBy')   || 'cmc';   // 'cmc' | 'name'
let builderGroupBy  = localStorage.getItem('builder:groupBy')  || 'type';  // 'type' | 'none'

// ── Builder helpers ─────────────────────────────────────────────────────────

const BUILDER_TYPES = [
  { key: 'creature',     label: 'Créatures',     priority: 0 },
  { key: 'planeswalker', label: 'Planeswalkers',  priority: 1 },
  { key: 'instant',      label: 'Éphémères',      priority: 2 },
  { key: 'sorcery',      label: 'Rituels',        priority: 3 },
  { key: 'enchantment',  label: 'Enchantements',  priority: 4 },
  { key: 'artifact',     label: 'Artefacts',      priority: 5 },
  { key: 'land',         label: 'Terres',         priority: 6 },
];

function builderCardMeta(name) {
  const sf = scryfallCards.get(name);
  const cmc = sf?.cmc ?? 0;
  const tl  = (sf?.type_line || sf?.card_faces?.[0]?.type_line || '').toLowerCase();
  for (const t of BUILDER_TYPES) {
    if (tl.includes(t.key)) return { label: t.label, priority: t.priority, cmc };
  }
  return { label: sf ? 'Autres' : '…', priority: 7, cmc };
}

function builderSortCards(cards) {
  return [...cards].sort((a, b) => {
    if (builderSortBy === 'cmc') {
      const d = builderCardMeta(a.name).cmc - builderCardMeta(b.name).cmc;
      return d !== 0 ? d : a.name.localeCompare(b.name);
    }
    return a.name.localeCompare(b.name);
  });
}

function builderGroupCards(cards) {
  if (builderGroupBy === 'none') return [{ label: null, cards: builderSortCards(cards) }];
  const map = new Map();
  for (const card of cards) {
    const { label, priority } = builderCardMeta(card.name);
    if (!map.has(label)) map.set(label, { label, priority, cards: [] });
    map.get(label).cards.push(card);
  }
  return [...map.values()]
    .sort((a, b) => a.priority - b.priority)
    .map(g => ({ ...g, cards: builderSortCards(g.cards) }));
}

function initBuilderView() {
  if (!builderInited) {
    // Search
    const searchInput = document.getElementById('builder-search-input');
    const searchBtn   = document.getElementById('builder-search-btn');
    searchBtn.addEventListener('click', () => builderSearch());
    searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') builderSearch(); });

    // Format selector in editor
    document.getElementById('builder-deck-format').addEventListener('change', e => {
      builderDeck.format = e.target.value;
      builderRenderDeck();
    });

    // List format selector
    document.getElementById('builder-list-format').addEventListener('change', () => builderLoadDeckList());

    // Save / new
    document.getElementById('builder-save-btn').addEventListener('click', builderSave);
    document.getElementById('builder-new-btn').addEventListener('click', builderNew);

    // View toggle buttons
    document.querySelectorAll('.builder-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        builderViewMode = btn.dataset.mode;
        localStorage.setItem('builder:viewMode', builderViewMode);
        document.querySelectorAll('.builder-view-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === builderViewMode));
        builderRenderDeck();
      });
    });

    // Sort / group selectors
    document.getElementById('builder-sort-by').addEventListener('change', e => {
      builderSortBy = e.target.value;
      localStorage.setItem('builder:sortBy', builderSortBy);
      builderRenderDeck();
    });
    document.getElementById('builder-group-by').addEventListener('change', e => {
      builderGroupBy = e.target.value;
      localStorage.setItem('builder:groupBy', builderGroupBy);
      builderRenderDeck();
    });

    builderInited = true;
  }

  // Restore saved display preferences
  document.querySelectorAll('.builder-view-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === builderViewMode));
  document.getElementById('builder-sort-by').value  = builderSortBy;
  document.getElementById('builder-group-by').value = builderGroupBy;

  document.getElementById('builder-deck-format').value = builderDeck.format;
  builderRenderDeck();
  builderLoadDeckList();
}

// ── Search ─────────────────────────────────────────────
async function builderSearch() {
  const q = document.getElementById('builder-search-input').value.trim();
  if (!q) return;
  const resultsEl = document.getElementById('builder-search-results');
  resultsEl.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:0.78rem">Recherche…</div>';

  try {
    const cards = await window.forgeApi.get('/api/cards/search?q=' + encodeURIComponent(q) + '&limit=50');
    if (!cards.length) {
      resultsEl.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:0.78rem">Aucun résultat.</div>';
      return;
    }

    resultsEl.innerHTML = '';
    cards.forEach(card => {
      const div = document.createElement('div');
      div.className = 'builder-card-result';
      div.dataset.card = card.name;

      // Lazy image — only fetches when scrolled into view
      const lazyImg = makeLazyCardImg(card.name);
      div.appendChild(lazyImg);

      const info = document.createElement('div');
      info.innerHTML = `
        <div class="builder-card-result-name">${esc(card.name)}</div>
        <div class="builder-card-result-meta">${esc(card.manaCost || '')}${card.manaCost && card.type ? ' · ' : ''}${esc(card.type || '')}</div>
        <div class="builder-card-result-btns">
          <button class="builder-add-btn" data-section="main">+ Main</button>
          <button class="builder-add-btn cmd" data-section="cmd">+ Cmd</button>
        </div>`;
      div.appendChild(info);

      info.querySelector('[data-section="main"]').addEventListener('click', e => {
        e.stopPropagation(); builderAddCard(card.name, 'main');
      });
      info.querySelector('[data-section="cmd"]').addEventListener('click', e => {
        e.stopPropagation(); builderAddCard(card.name, 'cmd');
      });
      resultsEl.appendChild(div);
    });
  } catch (err) {
    resultsEl.innerHTML = `<div style="padding:10px;color:var(--accent-loss);font-size:0.78rem">Erreur: ${esc(String(err))}</div>`;
  }
}

// ── Deck state ─────────────────────────────────────────
async function builderAddCard(name, section) {
  const list = section === 'cmd' ? builderDeck.commander : builderDeck.mainboard;
  const existing = list.find(c => c.name === name);
  if (existing) existing.qty++;
  else list.push({ name, qty: 1 });
  await fetchScryfallBatch([name]);
  builderRenderDeck();
}

function builderRemoveCard(name, section) {
  const list = section === 'cmd' ? builderDeck.commander : builderDeck.mainboard;
  const idx = list.findIndex(c => c.name === name);
  if (idx === -1) return;
  if (list[idx].qty > 1) list[idx].qty--;
  else list.splice(idx, 1);
  builderRenderDeck();
}

function builderNew() {
  builderDeck = { name: '', format: 'Commander', commander: [], mainboard: [] };
  document.getElementById('builder-deck-name').value = '';
  document.getElementById('builder-deck-format').value = 'Commander';
  builderRenderDeck();
}

// ── Render deck editor ─────────────────────────────────
function builderRenderDeck() {
  const content = document.getElementById('builder-deck-content');
  const status  = document.getElementById('builder-status');
  const mainTotal = builderDeck.mainboard.reduce((s, c) => s + c.qty, 0);
  const cmdTotal  = builderDeck.commander.reduce((s, c) => s + c.qty, 0);
  const total = mainTotal + cmdTotal;

  status.textContent = total
    ? `${total} carte${total > 1 ? 's' : ''} — main: ${mainTotal}, commander: ${cmdTotal}`
    : '';

  content.innerHTML = '';
  content.className = 'builder-deck-content' + (builderViewMode === 'visual' ? ' builder-deck-content--visual' : '');

  if (!mainTotal && !cmdTotal) {
    content.innerHTML = '<div class="builder-empty-deck">Deck vide. Cherche des cartes à gauche et clique + pour les ajouter.</div>';
    return;
  }

  const mkSection = builderViewMode === 'visual' ? builderMakeVisualSection : builderMakeListSection;

  if (builderDeck.commander.length) {
    content.appendChild(mkSection('Commander', builderDeck.commander, 'cmd'));
  }
  content.appendChild(mkSection('Mainboard', builderDeck.mainboard, 'main'));
}

function builderMakeListSection(title, cards, section) {
  const total = cards.reduce((s, c) => s + c.qty, 0);
  const wrapper = document.createElement('div');

  const sectionHeader = document.createElement('div');
  sectionHeader.className = 'builder-section-header';
  sectionHeader.innerHTML = `${esc(title)} <span class="builder-section-count">${total}</span>`;
  wrapper.appendChild(sectionHeader);

  const groups = builderGroupCards(cards);
  for (const group of groups) {
    if (group.label) {
      const groupCount = group.cards.reduce((s, c) => s + c.qty, 0);
      const gh = document.createElement('div');
      gh.className = 'builder-group-header';
      gh.innerHTML = `${esc(group.label)} <span class="builder-group-count">${groupCount}</span>`;
      wrapper.appendChild(gh);
    }
    for (const card of group.cards) {
      const row = document.createElement('div');
      row.className = 'builder-deck-row';
      row.dataset.card = card.name;
      row.innerHTML = `
        <span class="builder-row-qty">${card.qty}</span>
        <span class="builder-row-name">${esc(card.name)}</span>
        <div class="builder-row-btns">
          <button class="builder-row-btn plus" title="Ajouter">+</button>
          <button class="builder-row-btn" title="Retirer">−</button>
        </div>`;
      row.querySelector('.plus').addEventListener('click', () => builderAddCard(card.name, section));
      row.querySelector('.builder-row-btn:not(.plus)').addEventListener('click', () => builderRemoveCard(card.name, section));
      wrapper.appendChild(row);
    }
  }
  return wrapper;
}

function builderMakeVisualSection(title, cards, section) {
  const total = cards.reduce((s, c) => s + c.qty, 0);
  const wrapper = document.createElement('div');
  wrapper.className = 'builder-visual-section';

  // Section title (Commander / Mainboard)
  const sectionHeader = document.createElement('div');
  sectionHeader.className = 'builder-section-header';
  sectionHeader.innerHTML = `${esc(title)} <span class="builder-section-count">${total}</span>`;
  wrapper.appendChild(sectionHeader);

  const groups = builderGroupCards(cards);
  for (const group of groups) {
    const groupTotal = group.cards.reduce((s, c) => s + c.qty, 0);

    // Group header: "✦ Créatures (32)"
    const gh = document.createElement('div');
    gh.className = 'builder-visual-group-header';
    gh.innerHTML = group.label
      ? `<span class="builder-visual-group-icon">✦</span>${esc(group.label)} <span class="builder-visual-group-count">(${groupTotal})</span>`
      : `<span class="builder-visual-group-count">${groupTotal} cartes</span>`;
    wrapper.appendChild(gh);

    // Flat wrapping grid of card images
    const grid = document.createElement('div');
    grid.className = 'builder-visual-grid';

    for (const card of group.cards) {
      const wrap = document.createElement('div');
      wrap.className = 'builder-visual-card';
      wrap.dataset.card = card.name;
      wrap.title = card.name;

      const img = document.createElement('img');
      img.alt = card.name;
      img.className = 'builder-visual-img';
      const cached = scryfallCache.get(card.name);
      if (cached) img.src = cached;
      else { img.src = ''; fetchCardImage(card.name).then(u => { if (u) img.src = u; }); }
      wrap.appendChild(img);

      // Qty badge (only when > 1)
      if (card.qty > 1) {
        const badge = document.createElement('span');
        badge.className = 'builder-visual-qty';
        badge.textContent = '×' + card.qty;
        wrap.appendChild(badge);
      }

      // Hover overlay: name + +/- buttons
      const overlay = document.createElement('div');
      overlay.className = 'builder-visual-overlay';
      const nameEl = document.createElement('div');
      nameEl.className = 'builder-visual-card-name';
      nameEl.textContent = card.name;
      const btnRow = document.createElement('div');
      btnRow.className = 'builder-visual-btn-row';
      const plus = document.createElement('button');
      plus.className = 'builder-visual-btn';
      plus.textContent = '+';
      plus.title = 'Ajouter';
      plus.addEventListener('click', e => { e.stopPropagation(); builderAddCard(card.name, section); });
      const minus = document.createElement('button');
      minus.className = 'builder-visual-btn minus';
      minus.textContent = '−';
      minus.title = 'Retirer';
      minus.addEventListener('click', e => { e.stopPropagation(); builderRemoveCard(card.name, section); });
      btnRow.appendChild(plus);
      btnRow.appendChild(minus);
      overlay.appendChild(nameEl);
      overlay.appendChild(btnRow);
      wrap.appendChild(overlay);

      grid.appendChild(wrap);
    }
    wrapper.appendChild(grid);
  }
  return wrapper;
}

// ── Save ───────────────────────────────────────────────
async function builderSave() {
  const name = document.getElementById('builder-deck-name').value.trim();
  if (!name) { alert('Donne un nom au deck.'); return; }
  if (!builderDeck.mainboard.length && !builderDeck.commander.length) {
    alert('Le deck est vide.'); return;
  }

  builderDeck.name   = name;
  builderDeck.format = document.getElementById('builder-deck-format').value;

  const payload = {
    name,
    format: builderDeck.format,
    mainboard: builderDeck.mainboard,
    commander: builderDeck.commander
  };

  const btn = document.getElementById('builder-save-btn');
  btn.disabled = true; btn.textContent = '…';
  try {
    const res = await window.forgeApi.post('/api/decks/import', payload);
    if (res.success) {
      document.getElementById('builder-status').textContent = `✔ Deck "${name}" sauvegardé (${res.mainboardCount} + ${res.commanderCount} cartes)`;
      builderLoadDeckList();
    } else {
      alert('Erreur: ' + (res.error || 'inconnue'));
    }
  } catch (err) {
    alert('Erreur réseau: ' + err);
  } finally {
    btn.disabled = false; btn.textContent = '💾 Sauvegarder';
  }
}

// ── Deck list (right panel) ────────────────────────────
async function builderLoadDeckList() {
  const format = document.getElementById('builder-list-format').value;
  const listEl = document.getElementById('builder-decks-list');
  listEl.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:0.78rem">Chargement…</div>';

  try {
    const decks = await window.forgeApi.get('/api/decks?format=' + format.toLowerCase());
    listEl.innerHTML = '';
    if (!decks.length) {
      listEl.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:0.78rem">Aucun deck.</div>';
      return;
    }
    decks.forEach(d => {
      const item = document.createElement('div');
      item.className = 'builder-deck-item';
      item.innerHTML = `
        <span class="builder-deck-item-name" title="${esc(d.name)}">${esc(d.name)}</span>
        <button class="builder-deck-open-btn">Ouvrir</button>
        <button class="builder-deck-del-btn" title="Supprimer">🗑</button>`;
      item.querySelector('.builder-deck-open-btn').addEventListener('click', () => builderOpenDeck(d.name, format));
      item.querySelector('.builder-deck-del-btn').addEventListener('click', () => builderDeleteDeck(d.name, format, item));
      listEl.appendChild(item);
    });
  } catch (err) {
    listEl.innerHTML = `<div style="padding:10px;color:var(--accent-loss);font-size:0.78rem">Erreur: ${esc(String(err))}</div>`;
  }
}

async function builderOpenDeck(name, format) {
  try {
    const data = await window.forgeApi.get(`/api/decks/detail?name=${encodeURIComponent(name)}&format=${format.toLowerCase()}`);
    builderDeck.name   = data.name || name;
    builderDeck.format = format;
    builderDeck.commander = [];
    builderDeck.mainboard = [];

    (data.cards || []).forEach(c => {
      const entry = { name: c.name, qty: c.qty || 1 };
      if (c.section === 'Commander') builderDeck.commander.push(entry);
      else builderDeck.mainboard.push(entry);
    });

    document.getElementById('builder-deck-name').value  = builderDeck.name;
    document.getElementById('builder-deck-format').value = builderDeck.format;
    const allNames = (data.cards || []).map(c => c.name);
    await fetchScryfallBatch(allNames);
    builderRenderDeck();
  } catch (err) {
    alert('Impossible d\'ouvrir le deck: ' + err);
  }
}

async function builderDeleteDeck(name, format, itemEl) {
  if (!confirm(`Supprimer le deck "${name}" ?`)) return;
  try {
    const res = await window.forgeApi.delete(`/api/decks?name=${encodeURIComponent(name)}&format=${format.toLowerCase()}`);
    if (res && res.ok) {
      itemEl.remove();
      // If the open deck was this one, clear the editor
      if (builderDeck.name === name) builderNew();
    } else {
      alert('Erreur: ' + (res?.error || 'inconnue'));
    }
  } catch (err) {
    alert('Erreur réseau: ' + err);
  }
}
