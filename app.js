'use strict';

// ===== Configurazione =====
const CDN = 'https://cdn.emulatorjs.org/stable/data/';
const PREFIX = 'gbainsieme-v1-';

// Indici dei tasti RetroArch usati da EmulatorJS
const BTN = { B: 0, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, A: 8, L: 10, R: 11 };
// Stessa disposizione predefinita di EmulatorJS, così host e ospite usano gli stessi tasti
const KEYMAP = {
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
  KeyZ: 'A', KeyX: 'B', KeyQ: 'L', KeyE: 'R', Enter: 'START', KeyV: 'SELECT',
};
// Gamepad con mappatura standard (Xbox/PlayStation)
const PAD_MAP = { 1: 'A', 0: 'B', 4: 'L', 5: 'R', 9: 'START', 8: 'SELECT', 12: 'UP', 13: 'DOWN', 14: 'LEFT', 15: 'RIGHT' };

const $ = (s) => document.querySelector(s);

// ===== Cattura dell'audio dell'emulatore =====
// Ogni suono diretto agli altoparlanti viene copiato anche in un flusso trasmissibile.
const audioTaps = [];
let onNewAudio = () => {};
(() => {
  const orig = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode) {
      const ctx = dest.context;
      if (!ctx.__gbaTap) {
        ctx.__gbaTap = ctx.createMediaStreamDestination();
        audioTaps.push(ctx.__gbaTap);
        setTimeout(() => onNewAudio(), 0);
      }
      try { orig.call(this, ctx.__gbaTap); } catch (_) { /* ignora */ }
    }
    return orig.call(this, dest, ...rest);
  };
})();

// ===== Utilità =====
function show(id) {
  document.querySelectorAll('.screen').forEach((el) => { el.hidden = el.id !== id; });
}
function store(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* ignora */ } }
function load(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
function getName() { return $('#name').value.trim().slice(0, 24) || 'Anonimo'; }
function setStatus(who, text) {
  $('#' + who + 'Status').textContent = text;
  if (who === 'guest') updateMobileBar();
}
function randomCode() {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (const x of crypto.getRandomValues(new Uint8Array(6))) s += a[x % a.length];
  return s;
}
function isTyping(e) { return e.target && e.target.closest && e.target.closest('input, textarea'); }

function addMsg(logSel, who, text, extra) {
  const log = $(logSel);
  const p = document.createElement('div');
  p.className = 'msg' + (who ? '' : ' sys');
  if (who) {
    const b = document.createElement('b');
    b.textContent = who + ': ';
    p.append(b);
  }
  p.append(document.createTextNode(text));
  if (extra) p.append(extra);
  log.append(p);
  log.scrollTop = log.scrollHeight;
}

function setupChat(formSel, onSend) {
  const form = $(formSel);
  const input = form.querySelector('input');
  // I tasti scritti in chat non devono arrivare al gioco
  ['keydown', 'keyup', 'keypress'].forEach((t) => input.addEventListener(t, (e) => e.stopPropagation()));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    onSend(text.slice(0, 500));
  });
}

// ===================================================================
// HOST: chi ha il gioco e lo trasmette
// ===================================================================
const host = { peer: null, guests: new Map(), control: 'host', started: false, video: null, active: false };

function startHost(file) {
  store('name', getName());
  host.active = true;
  show('host');
  startUsageMeter('#hostUsage');

  Object.assign(window, {
    EJS_player: '#game',
    EJS_core: 'gba',
    EJS_gameUrl: URL.createObjectURL(file),
    EJS_gameName: file.name.replace(/\.[^.]+$/, ''),
    EJS_pathtodata: CDN,
    EJS_startOnLoaded: true,
    EJS_color: '#7c5cff',
    EJS_onGameStart: onGameStart,
  });
  const s = document.createElement('script');
  s.src = CDN + 'loader.js';
  document.body.append(s);

  setupChat('#hostChatForm', (text) => {
    addMsg('#hostLog', getName(), text);
    broadcast({ t: 'chat', who: getName(), text });
  });
  $('#copyBtn').onclick = async () => {
    const link = $('#roomLink').value;
    try {
      await navigator.clipboard.writeText(link);
      $('#copyBtn').textContent = 'Copiato!';
    } catch (_) {
      $('#roomLink').select();
      $('#copyBtn').textContent = 'Premi Ctrl+C';
    }
    setTimeout(() => { $('#copyBtn').textContent = 'Copia link'; }, 2000);
  };
  $('#takeBack').onclick = () => setControl('host');

  openRoom();
}

function gameCanvas() {
  return (window.EJS_emulator && window.EJS_emulator.canvas) || document.querySelector('#game canvas');
}

function buildStream() {
  const canvas = gameCanvas();
  if (!canvas) return null;
  if (!host.video || host.video.readyState === 'ended') host.video = canvas.captureStream(60).getVideoTracks()[0];
  const tracks = [host.video];
  const tap = audioTaps[audioTaps.length - 1];
  const audio = tap && tap.stream.getAudioTracks()[0];
  if (audio) tracks.push(audio);
  return new MediaStream(tracks);
}

function onGameStart() {
  host.started = true;
  setStatus('host', 'Gioco avviato! Manda il link ai tuoi amici.');
  for (const id of host.guests.keys()) callGuest(id);
  setupSaves();
}

// ===== Salvataggi =====
// 1) copia automatica nel browser (IndexedDB), 2) download/upload del file .sav
const saveDB = {
  open() {
    return new Promise((res, rej) => {
      // v2: aggiunto l'archivio 'roms' (copia locale dei giochi scaricati da GitHub)
      const r = indexedDB.open('gbainsieme', 2);
      r.onupgradeneeded = () => {
        for (const s of ['saves', 'roms']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async get(key, store = 'saves') {
    try {
      const db = await this.open();
      return await new Promise((res, rej) => {
        const r = db.transaction(store).objectStore(store).get(key);
        r.onsuccess = () => res(r.result || null);
        r.onerror = () => rej(r.error);
      });
    } catch (_) { return null; }
  },
  async set(key, value, store = 'saves') {
    try {
      const db = await this.open();
      await new Promise((res, rej) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value, key);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      return true;
    } catch (_) { return false; }
  },
};

const saves = { last: null, timer: null };
const saveKey = () => 'sav:' + window.EJS_gameName;
const gm = () => window.EJS_emulator && window.EJS_emulator.gameManager;

async function readSave() {
  const g = gm();
  if (!g) return null;
  try {
    const data = await g.getSaveFile();
    return data && data.length ? new Uint8Array(data) : null;
  } catch (_) { return null; }
}

function writeSave(bytes) {
  const g = gm();
  const path = g.getSaveFilePath();
  const dir = path.substring(0, path.lastIndexOf('/'));
  try { g.FS.mkdirTree(dir); } catch (_) { /* esiste già */ }
  try { g.FS.unlink(path); } catch (_) { /* non esisteva */ }
  g.FS.writeFile(path, bytes);
  g.loadSaveFiles();
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function isBlank(bytes) { return !bytes || bytes.every((x) => x === 0xff) || bytes.every((x) => x === 0); }
function timeStr(t) { return new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }); }

async function backupToBrowser() {
  if (saves.cloudDirty && saves.last && !isBlank(saves.last)) {
    saves.cloudDirty = false;
    queueUpload(saves.last);
  }
  const data = await readSave();
  if (!data || isBlank(data) || sameBytes(data, saves.last)) return;
  const time = Date.now();
  saves.last = data;
  if (await saveDB.set(saveKey(), { data, time })) {
    $('#saveInfo').textContent = 'Copia nel browser aggiornata alle ' + timeStr(time) + '.';
  } else {
    $('#saveInfo').textContent = '⚠ Il browser non permette di salvare: usa "Scarica .sav".';
  }
  queueUpload(data);
  // Dopo ogni salvataggio nel gioco salvo anche la sessione, così non resta mai più vecchia del .sav
  if (session.timer) saveSession('sav');
}

async function setupSaves() {
  $('#saveDl').disabled = false;
  $('#saveUp').disabled = false;
  $('#saveUpLabel').classList.remove('disabled');

  // Se l'emulatore non ha trovato un salvataggio ma noi ne abbiamo una copia, la ripristiniamo
  let current = await readSave();
  const backup = await saveDB.get(saveKey());
  if (backup && isBlank(current)) {
    try {
      writeSave(backup.data);
      restartGame();
      current = backup.data;
      addMsg('#hostLog', null, 'Salvataggio ripristinato dalla copia del ' + new Date(backup.time).toLocaleString('it-IT') + '.');
    } catch (_) { /* ignora */ }
  }
  saves.last = current;
  if (backup) $('#saveInfo').textContent = 'Ultima copia nel browser: ' + new Date(backup.time).toLocaleString('it-IT') + '.';

  // Confronto con il salvataggio su GitHub (se l'archivio è collegato)
  if (gh.cfg) await initialCloudSync(current);

  // Sessione (punto esatto della partita) salvata su GitHub
  if (gh.cfg) setupSessions();

  saves.timer = setInterval(backupToBrowser, 15000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) backupToBrowser(); });
  window.addEventListener('pagehide', backupToBrowser);

  $('#saveDl').onclick = async () => {
    const data = await readSave();
    if (!data || isBlank(data)) {
      $('#saveInfo').textContent = 'Non c\'è ancora nessun salvataggio: salva prima dal menu del gioco.';
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
    a.download = window.EJS_gameName + '.sav';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    backupToBrowser();
  };

  $('#saveUp').onchange = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!window.confirm('Caricare "' + file.name + '"?\nIl gioco ripartirà e i progressi non salvati andranno persi.')) return;
    const data = new Uint8Array(await file.arrayBuffer());
    try {
      writeSave(data);
      restartGame();
      await saveDB.set(saveKey(), { data, time: Date.now() });
      saves.last = data;
      $('#saveInfo').textContent = 'Salvataggio "' + file.name + '" caricato.';
      queueUpload(data);
    } catch (err) {
      $('#saveInfo').textContent = '⚠ Non sono riuscito a caricare il file.';
    }
  };
}

function restartGame() {
  const g = gm();
  if (g && typeof g.restart === 'function') g.restart();
}

// ===================================================================
// Archivio privato su GitHub: giochi (rom/) e salvataggi (salvataggi/)
// ===================================================================
const gh = {
  cfg: null,
  load() {
    try { this.cfg = JSON.parse(load('gh-config') || 'null'); } catch (_) { this.cfg = null; }
    return this.cfg;
  },
  save() { store('gh-config', JSON.stringify(this.cfg)); },
  clear() { this.cfg = null; try { localStorage.removeItem('gh-config'); } catch (_) { /* ignora */ } },
  api(path, { accept, method = 'GET', body } = {}) {
    const headers = {
      Authorization: 'Bearer ' + this.cfg.token,
      Accept: accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body) headers['Content-Type'] = 'application/json';
    return fetch('https://api.github.com/repos/' + this.cfg.repo + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store',
    });
  },
  savePath(name) { return '/contents/salvataggi/' + encodeURIComponent(name + '.sav'); },
  async getSave(name) {
    const res = await this.api(this.savePath(name));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    return { sha: j.sha, data: fromB64(j.content || '') };
  },
  putSave(name, data, sha) {
    return this.api(this.savePath(name), {
      method: 'PUT',
      body: { message: 'Salvataggio ' + name, content: toB64(data), ...(sha ? { sha } : {}) },
    });
  },
};

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64) {
  const s = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function hashBytes(b) {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16) + ':' + b.length;
}
const syncKey = () => 'sync:' + window.EJS_gameName;
function setCloud(text) { const el = $('#cloudInfo'); el.hidden = false; el.textContent = text; }

async function initialCloudSync(local) {
  const name = window.EJS_gameName;
  setCloud('☁ Controllo il salvataggio su GitHub…');
  let remote;
  try { remote = await gh.getSave(name); } catch (e) {
    setCloud('⚠ GitHub non raggiungibile (' + e.message + '). Il gioco salva comunque nel browser.');
    saves.cloudDirty = true;
    return;
  }
  const localBlank = isBlank(local);
  if (!remote) {
    if (!localBlank) await uploadSave(local);
    else setCloud('☁ Nessun salvataggio su GitHub per ora: verrà caricato al primo salvataggio.');
    return;
  }
  const rh = hashBytes(remote.data);
  if (!localBlank && hashBytes(local) === rh) {
    await saveDB.set(syncKey(), { sha: remote.sha, hash: rh });
    setCloud('☁ Salvataggio allineato con GitHub.');
    return;
  }
  const state = (await saveDB.get(syncKey())) || {};
  const remoteChanged = remote.sha !== state.sha;
  const localChanged = !localBlank && hashBytes(local) !== state.hash;
  let useRemote;
  if (localBlank || (remoteChanged && !localChanged)) useRemote = true;
  else if (!remoteChanged && localChanged) useRemote = false;
  else {
    useRemote = window.confirm(
      'Il salvataggio su GitHub è diverso da quello di questo browser.\n\n'
      + 'OK = usa quello su GitHub\nAnnulla = tieni quello di questo browser (e aggiorna GitHub)');
  }
  if (useRemote) {
    try {
      writeSave(remote.data);
      restartGame();
      saves.last = remote.data;
      await saveDB.set(saveKey(), { data: remote.data, time: Date.now() });
      await saveDB.set(syncKey(), { sha: remote.sha, hash: rh });
      setCloud('☁ Salvataggio scaricato da GitHub.');
      addMsg('#hostLog', null, 'Salvataggio caricato da GitHub.');
    } catch (_) {
      setCloud('⚠ Non sono riuscito ad applicare il salvataggio di GitHub.');
    }
  } else {
    await uploadSave(local);
  }
}

async function uploadSave(data) {
  if (!gh.cfg) return;
  const name = window.EJS_gameName;
  try {
    const state = (await saveDB.get(syncKey())) || {};
    let res = await gh.putSave(name, data, state.sha);
    if (res.status === 409 || res.status === 422) {
      // Il file su GitHub è cambiato: prendo il riferimento aggiornato e riprovo
      const r = await gh.getSave(name);
      res = await gh.putSave(name, data, r && r.sha);
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    await saveDB.set(syncKey(), { sha: j.content.sha, hash: hashBytes(data) });
    setCloud('☁ Salvato su GitHub alle ' + timeStr(Date.now()) + '.');
  } catch (e) {
    saves.cloudDirty = true;
    setCloud('⚠ Invio a GitHub non riuscito (' + e.message + '). Riprovo tra poco.');
  }
}

saves.queue = Promise.resolve();
function queueUpload(data) {
  if (!gh.cfg) return;
  saves.queue = saves.queue.then(() => uploadSave(data));
}

// ----- Libreria nella pagina iniziale -----
function libFail(msg) {
  $('#ghSetup').hidden = false;
  $('#ghLib').hidden = true;
  $('#ghError').textContent = msg;
  return false;
}

async function refreshRoms() {
  $('#ghError').textContent = '';
  const list = $('#romList');
  let res;
  try { res = await gh.api('/contents/rom'); } catch (_) { return libFail('GitHub non raggiungibile.'); }
  if (res.status === 401) return libFail('Chiave non valida o scaduta.');
  let items = [];
  if (res.status === 404) {
    const repo = await gh.api('');
    if (!repo.ok) return libFail('Non trovo il repository, o la chiave non ha accesso.');
  } else if (!res.ok) {
    return libFail('Errore GitHub (' + res.status + ').');
  } else {
    items = (await res.json()).filter((i) => i.type === 'file' && /\.(gba|gb|gbc|zip|7z)$/i.test(i.name));
  }

  $('#ghSetup').hidden = true;
  $('#ghLib').hidden = false;
  list.textContent = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'La cartella rom è vuota. Aggiungi un gioco e sincronizza.';
    list.append(li);
  }
  for (const item of items) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'btn';
    b.type = 'button';
    const title = document.createElement('span');
    title.textContent = item.name.replace(/\.[^.]+$/, '');
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = (item.size / 1048576).toFixed(1) + ' MB';
    b.append(title, size);
    b.onclick = () => loadRomFromGitHub(item, b, size);
    li.append(b);
    list.append(li);
  }
  return true;
}

async function loadRomFromGitHub(item, btn, label) {
  btn.disabled = true;
  try {
    // Se il gioco è già stato scaricato (stessa versione), lo prendo dalla copia nel browser
    const cached = await saveDB.get(item.path, 'roms');
    let blob;
    if (cached && cached.sha === item.sha && cached.blob) {
      label.textContent = 'Avvio…';
      blob = cached.blob;
    } else {
      label.textContent = 'Scarico…';
      const path = item.path.split('/').map(encodeURIComponent).join('/');
      const res = await gh.api('/contents/' + path, { accept: 'application/vnd.github.raw' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      blob = await res.blob();
      await saveDB.set(item.path, { sha: item.sha, blob }, 'roms');
    }
    startHost(new File([blob], item.name));
  } catch (e) {
    btn.disabled = false;
    label.textContent = 'Errore, riprova';
    $('#ghError').textContent = 'Download non riuscito (' + e.message + ').';
  }
}

// ===================================================================
// Sessioni: il punto esatto della partita, salvato su GitHub (sessioni/<gioco>.state.gz)
// ===================================================================
const session = { sha: null, lastHash: null, busy: false, timer: null };
const SESSION_EVERY_MIN = 10;
const sessionPath = () => '/contents/sessioni/' + encodeURIComponent(window.EJS_gameName + '.state.gz');
function setSession(text) { const el = $('#sessionInfo'); el.hidden = false; el.textContent = text; }

async function gzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function gunzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function readState() {
  const g = gm();
  if (!g || typeof g.getState !== 'function') return null;
  const st = await g.getState();
  return st && st.length ? new Uint8Array(st) : null;
}

async function saveSession(reason) {
  if (!gh.cfg || session.busy) return;
  session.busy = true;
  try {
    const state = await readState();
    if (!state) throw new Error('stato non disponibile');
    const h = hashBytes(state);
    if (h === session.lastHash && reason === 'auto') return;
    setSession('⏳ Salvo la sessione su GitHub…');
    const content = toB64(await gzip(state));
    const body = (sha) => ({ message: 'Sessione ' + window.EJS_gameName, content, ...(sha ? { sha } : {}) });
    let res = await gh.api(sessionPath(), { method: 'PUT', body: body(session.sha) });
    if (res.status === 409 || res.status === 422) {
      const meta = await gh.api(sessionPath());
      const sha = meta.ok ? (await meta.json()).sha : null;
      res = await gh.api(sessionPath(), { method: 'PUT', body: body(sha) });
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    session.sha = (await res.json()).content.sha;
    session.lastHash = h;
    setSession('⏯ Sessione salvata su GitHub alle ' + timeStr(Date.now()) + '.');
  } catch (e) {
    setSession('⚠ Sessione non salvata (' + e.message + ').');
  } finally {
    session.busy = false;
  }
}

async function resumeSession() {
  const meta = await gh.api(sessionPath());
  if (meta.status === 404) { setSession('Nessuna sessione salvata per questo gioco: la prima verrà salvata tra ' + SESSION_EVERY_MIN + ' minuti o col pulsante.'); return; }
  if (!meta.ok) throw new Error('HTTP ' + meta.status);
  const info = await meta.json();
  session.sha = info.sha;
  const raw = await gh.api(sessionPath(), { accept: 'application/vnd.github.raw' });
  if (!raw.ok) throw new Error('HTTP ' + raw.status);
  const state = await gunzip(new Uint8Array(await raw.arrayBuffer()));
  // piccola attesa: l'emulatore potrebbe essere appena ripartito per il .sav
  await new Promise((r) => setTimeout(r, 800));
  gm().loadState(state);
  session.lastHash = hashBytes(state);
  // Il salvataggio contenuto nella sessione non va trattato come "nuovo salvataggio"
  await new Promise((r) => setTimeout(r, 500));
  saves.last = (await readSave()) || saves.last;
  setSession('⏯ Sessione ripresa da GitHub.');
  addMsg('#hostLog', null, 'Partita ripresa dal punto esatto in cui l\'avevi lasciata.');
}

async function setupSessions() {
  $('#sessionBtn').hidden = false;
  $('#sessionBtn').onclick = () => saveSession('manuale');
  setSession('⏳ Cerco una sessione salvata…');
  try { await resumeSession(); } catch (e) { setSession('⚠ Non sono riuscito a riprendere la sessione (' + e.message + ').'); }
  session.timer = setInterval(() => saveSession('auto'), SESSION_EVERY_MIN * 60000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveSession('auto'); });
}

// ===================================================================
// Indicatore dei consumi del ripetitore
// ===================================================================
const usage = { prev: new Map(), session: 0, relaySession: 0, timer: null };
const FREE_GB = 1000;
const monthKey = () => 'turn-mese-' + new Date().toISOString().slice(0, 7);
function fmtBytes(b) {
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1).replace('.', ',') + ' MB';
  return (b / 1073741824).toFixed(2).replace('.', ',') + ' GB';
}

function activeConnections() {
  const list = [];
  if (host.active) {
    for (const g of host.guests.values()) list.push(g.conn, g.call);
  } else if (guest.active) {
    list.push(guest.conn, guest.call);
  }
  return list.map((c) => c && c.peerConnection).filter(Boolean);
}

async function pcStats(pc) {
  const s = await pc.getStats();
  let pair = null;
  s.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = s.get(r.selectedCandidatePairId); });
  if (!pair) s.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
  if (!pair) return null;
  const l = s.get(pair.localCandidateId);
  const rm = s.get(pair.remoteCandidateId);
  return {
    bytes: (pair.bytesSent || 0) + (pair.bytesReceived || 0),
    relay: (l && l.candidateType === 'relay') || (rm && rm.candidateType === 'relay'),
  };
}

function startUsageMeter(sel) {
  const el = $(sel);
  const INTERVAL = 2000;
  usage.timer = setInterval(async () => {
    let delta = 0, relayDelta = 0, anyRelay = false, any = false;
    const seen = new Set();
    for (const pc of activeConnections()) {
      seen.add(pc);
      let st;
      try { st = await pcStats(pc); } catch (_) { continue; }
      if (!st) continue;
      any = true;
      const d = Math.max(0, st.bytes - (usage.prev.get(pc) || 0));
      usage.prev.set(pc, st.bytes);
      delta += d;
      if (st.relay) { anyRelay = true; relayDelta += d; }
    }
    for (const pc of [...usage.prev.keys()]) if (!seen.has(pc)) usage.prev.delete(pc);

    usage.session += delta;
    usage.relaySession += relayDelta;
    let month = Number(load(monthKey())) || 0;
    if (relayDelta) { month += relayDelta; store(monthKey(), String(month)); }

    const kbps = Math.round((delta * 8) / (INTERVAL / 1000) / 1000);
    const mode = !any ? '—' : anyRelay ? '🔁 tramite ripetitore' : '🔗 diretto (non consuma)';
    el.hidden = false;
    el.textContent = '📶 ' + mode + ' · ' + kbps + ' kbps'
      + ' · sessione ' + fmtBytes(usage.session)
      + ' (ripetitore ' + fmtBytes(usage.relaySession) + ')'
      + ' · mese ' + fmtBytes(month) + ' / ' + FREE_GB + ' GB gratis';
  }, INTERVAL);
}

function initLibrary() {
  const owner = location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : '';
  if (owner) $('#ghRepo').value = owner + '/gba-privato';

  $('#ghForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const repo = $('#ghRepo').value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
    const token = $('#ghToken').value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) { libFail('Inserisci repository e chiave.'); return; }
    gh.cfg = { repo, token };
    $('#ghError').textContent = 'Collego…';
    if (await refreshRoms()) { gh.save(); $('#ghToken').value = ''; } else gh.cfg = null;
  });
  $('#ghRefresh').onclick = () => refreshRoms();
  $('#ghLogout').onclick = () => { gh.clear(); libFail(''); };

  if (gh.load()) {
    refreshRoms().then((ok) => { if (!ok) gh.cfg = null; });
  }
}

// Se l'audio parte dopo il video, ritrasmetto per includerlo
let audioTimer = null;
onNewAudio = () => {
  if (!host.started) return;
  clearTimeout(audioTimer);
  audioTimer = setTimeout(() => { for (const id of host.guests.keys()) callGuest(id); }, 300);
};

function callGuest(id) {
  const g = host.guests.get(id);
  if (!g || !host.started) return;
  const stream = buildStream();
  if (!stream) return;
  if (g.call) { try { g.call.close(); } catch (_) { /* ignora */ } }
  g.call = host.peer.call(id, stream);
}

// ===== Ripetitore TURN =====
// I ripetitori predefiniti di PeerJS non esistono più: senza uno nostro, PC e telefono
// spesso non riescono a collegarsi. Le credenziali le fornisce Metered (Open Relay).
async function fetchTurnServers(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  const list = Array.isArray(j) ? j : j.iceServers;
  if (!Array.isArray(list) || !list.length) throw new Error('risposta non valida');
  return list;
}

// Ripetitore di Cloudflare (credenziali temporanee generate dal worker in cloudflare-turn/)
const TURN_URL = 'https://sparkling-cherry-61ae.filippo-melara.workers.dev';

async function peerOptions(logSel) {
  const url = load('turn-url') || TURN_URL;
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (url) {
    try {
      iceServers.push(...await fetchTurnServers(url));
    } catch (e) {
      addMsg(logSel, null, '⚠ Ripetitore non disponibile (' + e.message + '): il collegamento potrebbe non riuscire.');
    }
  }
  return { config: { iceServers } };
}

function initTurnSettings() {
  const info = $('#turnInfo');
  if (load('turn-url')) { info.textContent = '✓ Ripetitore configurato.'; $('#turnBox').open = false; }
  $('#turnForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('#turnUrl').value.trim();
    if (!/^https:\/\//i.test(url)) { info.textContent = 'L\'indirizzo deve iniziare con https://'; return; }
    info.textContent = 'Provo il ripetitore…';
    try {
      const list = await fetchTurnServers(url);
      const ok = list.some((s) => [].concat(s.urls || s.url || []).some((u) => /^turns?:/i.test(u)));
      if (!ok) throw new Error('nessun server TURN nella risposta');
      store('turn-url', url);
      $('#turnUrl').value = '';
      info.textContent = '✓ Ripetitore salvato e funzionante.';
    } catch (err) {
      info.textContent = '⚠ Non funziona (' + err.message + '). Controlla l\'indirizzo.';
    }
  });
  $('#turnClear').onclick = () => {
    try { localStorage.removeItem('turn-url'); } catch (_) { /* ignora */ }
    info.textContent = 'Ripetitore rimosso.';
  };
}

async function openRoom() {
  const code = randomCode();
  const peer = new Peer(PREFIX + code, await peerOptions('#hostLog'));
  host.peer = peer;

  peer.on('open', () => {
    $('#roomLink').value = location.origin + location.pathname + '?stanza=' + code;
    $('#roomCode').textContent = code.toUpperCase();
    $('#shareBox').hidden = false;
    setStatus('host', host.started ? 'Stanza pronta!' : 'Stanza pronta. Il gioco si sta caricando…');
  });

  peer.on('connection', (conn) => {
    conn.on('open', () => {
      const name = String((conn.metadata && conn.metadata.name) || 'Ospite').slice(0, 24);
      host.guests.set(conn.peer, { conn, name, call: null });
      addMsg('#hostLog', null, name + ' è entrato.');
      sendTo(conn, { t: 'control', who: host.control });
      callGuest(conn.peer);
      renderGuests();
    });
    conn.on('data', (d) => onGuestData(conn.peer, d));
    conn.on('close', () => dropGuest(conn.peer));
    conn.on('error', () => dropGuest(conn.peer));
  });

  peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
  peer.on('error', (e) => {
    if (e.type === 'unavailable-id') { peer.destroy(); openRoom(); return; }
    if (e.type === 'peer-unavailable') return;
    setStatus('host', 'Problema di connessione (' + e.type + '). Ricarica la pagina se persiste.');
  });
}

function guestName(id) { const g = host.guests.get(id); return g ? g.name : 'Ospite'; }

function dropGuest(id) {
  const g = host.guests.get(id);
  if (!g) return;
  if (g.call) { try { g.call.close(); } catch (_) { /* ignora */ } }
  host.guests.delete(id);
  addMsg('#hostLog', null, g.name + ' è uscito.');
  if (host.control === id) setControl('host');
  renderGuests();
}

function sendTo(conn, msg) { if (conn && conn.open) conn.send(msg); }
function broadcast(msg, except) {
  for (const [id, g] of host.guests) if (id !== except) sendTo(g.conn, msg);
}

function press(index, value) {
  const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
  if (gm) gm.simulateInput(0, index, value);
}
function releaseAll() { for (const i of Object.values(BTN)) press(i, 0); }

function onGuestData(id, d) {
  if (!d || typeof d !== 'object') return;
  switch (d.t) {
    case 'key':
      if (host.control === id && Object.prototype.hasOwnProperty.call(BTN, d.b)) press(BTN[d.b], d.d ? 1 : 0);
      break;
    case 'chat': {
      const text = String(d.text || '').slice(0, 500);
      const who = guestName(id);
      addMsg('#hostLog', who, text);
      broadcast({ t: 'chat', who, text }, id);
      break;
    }
    case 'ask': {
      const btn = document.createElement('button');
      btn.className = 'btn mini primary';
      btn.textContent = 'Dai i comandi';
      btn.onclick = () => { setControl(id); btn.remove(); };
      addMsg('#hostLog', null, guestName(id) + ' chiede i comandi.', btn);
      break;
    }
    case 'giveback':
      if (host.control === id) setControl('host');
      break;
  }
}

function setControl(who) {
  releaseAll();
  host.control = who;
  broadcast({ t: 'control', who });
  if (who === 'host') {
    $('#controlState').textContent = '🎮 I comandi sono tuoi';
    addMsg('#hostLog', null, 'Hai ripreso i comandi.');
  } else {
    $('#controlState').textContent = '👉 Comanda ' + guestName(who);
    addMsg('#hostLog', null, 'Comandi passati a ' + guestName(who) + '.');
  }
  $('#takeBack').hidden = who === 'host';
  renderGuests();
}

function renderGuests() {
  const ul = $('#guestList');
  ul.textContent = '';
  if (!host.guests.size) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nessuno per ora';
    ul.append(li);
    return;
  }
  for (const [id, g] of host.guests) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = g.name;
    li.append(span);
    if (host.control === id) {
      const s = document.createElement('span');
      s.textContent = '🎮 comanda';
      li.append(s);
    } else {
      const b = document.createElement('button');
      b.className = 'btn mini';
      b.textContent = 'Dai i comandi';
      b.onclick = () => setControl(id);
      li.append(b);
    }
    ul.append(li);
  }
}

// Quando comanda un ospite, la tastiera dell'host non arriva al gioco
['keydown', 'keyup'].forEach((type) => window.addEventListener(type, (e) => {
  if (host.active && host.control !== 'host' && !isTyping(e)) e.stopImmediatePropagation();
}, true));

// ===================================================================
// OSPITE: guarda e, quando riceve i comandi, gioca
// ===================================================================
const guest = { peer: null, conn: null, hasControl: false, pressed: new Set(), active: false };

async function startGuest(rawCode) {
  const code = extractCode(rawCode);
  if (!code) return;
  store('name', getName());
  guest.active = true;
  document.body.classList.add('mode-guest');
  show('guest');
  keepAwake();
  startUsageMeter('#guestUsage');
  history.replaceState(null, '', location.pathname + '?stanza=' + code);
  setStatus('guest', 'Mi collego alla stanza ' + code.toUpperCase() + '…');

  const peer = new Peer(await peerOptions('#guestLog'));
  guest.peer = peer;

  // Diagnostica: mostra a che punto si ferma il collegamento
  const diag = (t) => {
    $('#guestDiag').hidden = false;
    $('#guestDiag').textContent = t;
    guest.diagMsg = stage === 'ok' ? null : t;
    updateMobileBar();
  };
  let stage = 'server';
  diag('Passo 1/3: contatto il server di collegamento…');
  const watchdog = setInterval(() => {
    const pc = guest.conn && guest.conn.peerConnection;
    const ice = pc ? pc.iceConnectionState : '-';
    if (stage === 'server') diag('Passo 1/3: non riesco a raggiungere il server di collegamento. Controlla la connessione internet del telefono.');
    else if (stage === 'room') diag('Passo 2/3: server raggiunto, cerco la stanza… (stato: ' + ice + ')');
    if (stage === 'room' && (ice === 'failed' || ice === 'disconnected')) {
      diag('Passo 3/3 fallito: il collegamento diretto con il PC non riesce (stato: ' + ice + '). '
        + 'Spesso succede con la rete dati del telefono: prova col Wi-Fi.');
    }
  }, 4000);

  peer.on('open', () => {
    stage = 'room';
    diag('Passo 2/3: server raggiunto, cerco la stanza…');
    const conn = peer.connect(PREFIX + code, { reliable: true, metadata: { name: getName() } });
    guest.conn = conn;
    conn.on('open', () => {
      stage = 'ok';
      guest.connected = true;
      clearInterval(watchdog);
      diag('Passo 3/3: collegato al PC dell\'host ✓');
      setStatus('guest', 'Connesso! Aspetto che l\'host avvii il gioco…');
    });
    conn.on('error', (e) => diag('Errore del collegamento: ' + (e.type || e.message || e)));
    conn.on('data', onHostData);
    conn.on('close', () => {
      guest.live = false;
      guest.connected = false;
      setGuestControl(false);
      setStatus('guest', 'La stanza è stata chiusa dall\'host.');
    });
  });

  peer.on('call', (call) => {
    guest.call = call;
    call.answer();
    call.on('stream', (stream) => {
      const v = $('#remote');
      v.srcObject = stream;
      v.muted = false;
      v.play().catch(() => {
        // Il browser blocca l'audio automatico: parto muto e chiedo un tocco
        v.muted = true;
        v.play().catch(() => {});
        $('#unmute').hidden = false;
      });
      guest.live = true;
      setStatus('guest', 'In diretta 🔴');
    });
  });

  peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
  peer.on('error', (e) => {
    setStatus('guest', e.type === 'peer-unavailable'
      ? 'Stanza non trovata. Controlla il link o chiedi all\'host di riaprirla.'
      : 'Problema di connessione (' + e.type + ').');
  });

  $('#unmute').onclick = () => {
    const v = $('#remote');
    v.muted = false;
    v.play().catch(() => {});
    $('#unmute').hidden = true;
  };
  $('#askBtn').onclick = () => {
    if (guest.hasControl) {
      send({ t: 'giveback' });
    } else {
      send({ t: 'ask' });
      addMsg('#guestLog', null, 'Richiesta inviata all\'host.');
    }
  };
  $('#askBtnM').onclick = () => $('#askBtn').click();
  setupChat('#guestChatForm', (text) => {
    addMsg('#guestLog', getName(), text);
    send({ t: 'chat', text });
  });
  setupGuestInput();
}

function extractCode(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/stanza=([a-z0-9]+)/i);
  const code = (m ? m[1] : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  return code || null;
}

function send(msg) { if (guest.conn && guest.conn.open) guest.conn.send(msg); }

function onHostData(d) {
  if (!d || typeof d !== 'object') return;
  if (d.t === 'control') {
    const mine = d.who === guest.peer.id;
    if (mine !== guest.hasControl) {
      addMsg('#guestLog', null, mine ? 'Hai i comandi! 🎮' : 'I comandi sono passati a un altro giocatore.');
    }
    setGuestControl(mine);
  } else if (d.t === 'chat') {
    addMsg('#guestLog', String(d.who || '?').slice(0, 24), String(d.text || '').slice(0, 500));
  }
}

function setGuestControl(on) {
  if (!on) releaseGuest();
  guest.hasControl = on;
  document.body.classList.toggle('has-control', on);
  $('#controlBadge').textContent = on ? '🎮 Hai i comandi!' : '👀 Stai guardando';
  $('#askBtn').textContent = on ? 'Restituisci i comandi' : 'Chiedi i comandi';
  updateMobileBar();
}

// Barra compatta per il telefono in verticale
function updateMobileBar() {
  const el = $('#mStatus');
  if (!el || !guest.active) return;
  el.textContent = guest.live ? $('#controlBadge').textContent : (guest.diagMsg || $('#guestStatus').textContent);
  $('#askBtnM').textContent = guest.hasControl ? 'Restituisci' : 'Chiedi i comandi';
  $('#askBtnM').hidden = !guest.connected;
}

// Tiene lo schermo acceso mentre si guarda
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') await navigator.wakeLock.request('screen');
  } catch (_) { /* non supportato o negato */ }
}
document.addEventListener('visibilitychange', () => {
  if (guest.active && document.visibilityState === 'visible') keepAwake();
});

function gPress(b, down) {
  if (!guest.hasControl) return;
  if (down === guest.pressed.has(b)) return;
  if (down) guest.pressed.add(b); else guest.pressed.delete(b);
  document.querySelectorAll('.pad [data-b="' + b + '"]').forEach((el) => el.classList.toggle('on', down));
  send({ t: 'key', b, d: down ? 1 : 0 });
}
function releaseGuest() { for (const b of [...guest.pressed]) gPress(b, false); }

function setupGuestInput() {
  // Tastiera
  window.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;
    const b = KEYMAP[e.code];
    if (!b) return;
    e.preventDefault();
    gPress(b, true);
  });
  window.addEventListener('keyup', (e) => {
    const b = KEYMAP[e.code];
    if (b) gPress(b, false);
  });
  window.addEventListener('blur', releaseGuest);

  // Tasti sullo schermo
  document.querySelectorAll('.pad [data-b]').forEach((el) => {
    const b = el.dataset.b;
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); gPress(b, true); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => el.addEventListener(t, () => gPress(b, false)));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  // Gamepad
  const padState = {};
  const poll = () => {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const now = {};
    for (const gp of pads) {
      if (!gp) continue;
      for (const [i, b] of Object.entries(PAD_MAP)) if (gp.buttons[i] && gp.buttons[i].pressed) now[b] = true;
      const [x = 0, y = 0] = gp.axes;
      if (x < -0.5) now.LEFT = true;
      if (x > 0.5) now.RIGHT = true;
      if (y < -0.5) now.UP = true;
      if (y > 0.5) now.DOWN = true;
    }
    for (const b of Object.keys(BTN)) {
      const p = !!now[b];
      if (p !== !!padState[b]) { padState[b] = p; gPress(b, p); }
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
}

// ===================================================================
// Avvio
// ===================================================================
$('#name').value = load('name') || '';

$('#romFile').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) startHost(file);
});

$('#joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#joinCode').value;
  if (extractCode(code)) startGuest(code);
  else $('#joinCode').focus();
});

initLibrary();
initTurnSettings();

const invited = new URLSearchParams(location.search).get('stanza');
if (invited && extractCode(invited)) {
  // Aperto da un link d'invito: entro subito nella stanza, senza premere "Entra"
  if (!$('#name').value.trim()) $('#name').value = 'Ospite';
  startGuest(invited);
}
