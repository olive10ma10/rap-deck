import { analyzeSong, VOICE_STEP, ANALYSIS_V } from './analysis.js';

// ================= 保存（スマホの中だけ・IndexedDB） =================
const DB_NAME = 'rapdeck';
let dbp;
function db() {
  dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('songs', { keyPath: 'id' });
      r.result.createObjectStore('blobs');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const store = {
  songs: () => tx('songs', 'readonly', (s) => s.getAll()),
  putSong: (song) => tx('songs', 'readwrite', (s) => s.put(song)),
  delSong: (id) => tx('songs', 'readwrite', (s) => s.delete(id)),
  blob: (id) => tx('blobs', 'readonly', (s) => s.get(id)),
  putBlob: (id, b) => tx('blobs', 'readwrite', (s) => s.put(b, id)),
  delBlob: (id) => tx('blobs', 'readwrite', (s) => s.delete(id)),
};

// ================= 種類の見分け =================
const TYPES = {
  beat: { label: 'ビート', icon: '🥁' },
  orig: { label: '原曲', icon: '🎤' },
  vocal: { label: '声のみ', icon: '🗣' },
  part: { label: 'パーツ', icon: '🎛' },
};
const TYPE_ORDER = ['beat', 'orig', 'vocal', 'part'];

const RE_BEAT = /(instrumental|inst(?![a-z])|no[_ -]?vocals?|off[_ -]?vocal|karaoke|ビート|伴奏|オケ|カラオケ)/i;
const RE_VOCAL = /(vocals?(?![a-z])|acapella|アカペラ|声のみ|声だけ)/i;
const RE_PART = /^(drums|bass|other|piano|guitar|ドラム|ベース|その他)$/i;
const RE_ORIG = /(原曲|元の音声|audio[_ -]?only|original)/i;
const RE_JUNK = /(downloaded|edited|screenrecording|\d{2}-\d{2}-\d{4}|\d{2}-\d{2}-\d{2}|_\d+$|\(\d+\)|generation)/gi;

const stripExt = (n) => n.replace(/\.[^.]+$/, '');
const isVideo = (f) => /^video\//.test(f.type) || /\.(mp4|mov)$/i.test(f.name);

function guessType(name) {
  const base = stripExt(name);
  const tail = base.split(' - ').pop().trim();
  for (const t of TYPE_ORDER) if (tail === TYPES[t].label) return t;
  if (RE_BEAT.test(base)) return 'beat';
  if (RE_VOCAL.test(base)) return 'vocal';
  if (RE_PART.test(base.trim())) return 'part';
  return 'orig';
}

// 同じ曲のファイルをまとめるための名前
function guessTitle(name) {
  const base = stripExt(name);
  if (base.includes(' - ')) return base.split(' - ').slice(0, -1).join(' - ').trim();
  const noType = base.replace(RE_BEAT, ' ').replace(RE_VOCAL, ' ').replace(RE_ORIG, ' ');
  const noNum = (x) => x.replace(/(^|[\s_])\d{1,2}(?=[\s_]|$)/g, ' ');
  const clean = (x) => x.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  // 画面収録のように日付しか無い名前は、日付ごと残して同じ録画どうしをまとめる
  return clean(noNum(noType.replace(RE_JUNK, ' '))) || clean(noNum(noType)) || base;
}

// ================= 状態 =================
const S = {
  songs: [],
  cur: null,          // 開いている曲
  playing: false,
  loaded: false,
  sr: 44100,
  length: 0,          // サンプル数
  pos: 0, rate: 0, posAt: 0,
  loopBars: 0,
  analyzing: new Set(),
  countIn: localStorage.getItem('countIn') !== '0',
};

const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k);
  return el;
};
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const fmt = (sec) => {
  if (sec == null || !isFinite(sec)) return '--:--';
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};
const fmt1 = (sec) => `${fmt(sec)}.${Math.floor((Math.max(0, sec) % 1) * 10)}`;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}

// 曲ごとの値（手で直した値があればそれを優先）
const bpmOf = (s) => s.bpmManual || s.analysis?.bpm || null;
const beat0Of = (s) => (s.beat0Manual ?? s.analysis?.beat0) || 0;
const entryOf = (s) => (s.entryManual ?? s.analysis?.entry) ?? null;
const beatLen = (s) => (bpmOf(s) ? 60 / bpmOf(s) : null);
// 「入り」を一番近い拍に合わせた位置。ここを1小節目1拍目として数える
function anchorOf(s) {
  const T = beatLen(s), e = entryOf(s), b0 = beat0Of(s);
  if (!T) return e ?? 0;
  if (e == null) return b0;
  return b0 + Math.round((e - b0) / T) * T;
}

// ================= 音（AudioWorklet） =================
let ctx, node, silentEl, audioReady;
// タップした瞬間に呼ぶ（iPhoneはタップの中でしか音を出し始められない）
function ensureAudio() {
  if (ctx) {
    ctx.resume();
    silentEl.play().catch(() => {});
    return audioReady;
  }
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  // iPhoneのマナーモードでも音が出るように、無音の<audio>を一緒に流す
  silentEl = new Audio(silentWav());
  silentEl.loop = true;
  silentEl.setAttribute('playsinline', '');
  silentEl.play().catch(() => {});
  ctx.resume();
  S.sr = ctx.sampleRate;
  audioReady = ctx.audioWorklet.addModule('deck-worklet.js').then(() => {
    node = new AudioWorkletNode(ctx, 'deck', { numberOfInputs: 0, outputChannelCount: [2] });
    node.connect(ctx.destination);
    node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'pos') { S.pos = m.pos; S.rate = m.rate; S.posAt = performance.now(); }
      else if (m.type === 'ended') { S.playing = false; renderTransport(); }
    };
  });
  return audioReady;
}
function silentWav() {
  const n = 4410, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 44100, true); v.setUint32(28, 88200, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
const send = (m, transfer) => node && node.port.postMessage(m, transfer || []);

// 今の再生位置（秒）。エンジンからの報告の間を補う
function nowSec() {
  if (!S.loaded) return 0;
  const dt = (performance.now() - S.posAt) / 1000;
  const p = S.pos + S.rate * S.sr * Math.min(dt, 0.1);
  return Math.max(0, Math.min(S.length, p)) / S.sr;
}

async function loadIntoDeck(song) {
  S.loaded = false;
  S.playing = false;
  send({ type: 'pause' });
  const decoded = [];
  for (const l of song.layers) {
    const blob = await store.blob(l.id);
    if (!blob) continue;
    try {
      const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
      decoded.push({ l, buf });
    } catch (e) {
      console.warn(e);
      toast(`${l.name} が読めませんでした`);
    }
    if (S.cur !== song) return false;
  }
  if (!decoded.length) return false;
  const length = Math.max(...decoded.map((d) => d.buf.length));
  const layers = [], transfer = [];
  for (const { l, buf } of decoded) {
    const ch = (c) => {
      const a = new Float32Array(length);
      a.set(buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)));
      transfer.push(a.buffer);
      return a;
    };
    layers.push({ id: l.id, L: ch(0), R: buf.numberOfChannels > 1 ? ch(1) : undefined, on: !!song.on?.[l.id] });
  }
  send({ type: 'load', layers, length }, transfer);
  S.length = length;
  S.pos = 0; S.rate = 0; S.posAt = performance.now();
  S.loaded = true;
  return true;
}

function play() {
  if (!S.loaded) return;
  ensureAudio();
  if (nowSec() >= S.length / S.sr - 0.05) seek(0);
  send({ type: 'play', instant: true });
  S.playing = true;
  renderTransport();
}
function pauseDeck() {
  send({ type: 'pause' });
  S.playing = false;
  renderTransport();
}
function seek(sec) {
  const p = Math.max(0, Math.min(S.length - 1, sec * S.sr));
  send({ type: 'seek', pos: p });
  S.pos = p; S.posAt = performance.now();
  if (S.loopBars) setLoop(S.loopBars);
}
function setLoop(bars) {
  S.loopBars = bars;
  const s = S.cur, T = beatLen(s);
  if (!bars || !T) { send({ type: 'loop', loop: null }); S.loop = null; return; }
  const bar = 4 * T, a = anchorOf(s);
  const start = Math.max(0, a + Math.floor((nowSec() - a + 0.05) / bar) * bar);
  S.loop = { start, end: start + bars * bar };
  send({ type: 'loop', loop: { start: start * S.sr, end: S.loop.end * S.sr } });
}

// ================= 画面：ライブラリ =================
function renderLibrary() {
  const list = $('#songs');
  const q = $('#search').value.trim().toLowerCase();
  list.replaceChildren();
  const songs = S.songs
    .filter((s) => !q || s.title.toLowerCase().includes(q))
    .sort((a, b) => (b.lastPlayed || b.created) - (a.lastPlayed || a.created));
  $('#searchWrap').hidden = S.songs.length < 6;
  $('#empty').hidden = S.songs.length > 0;
  for (const s of songs) {
    const types = TYPE_ORDER.filter((t) => s.layers.some((l) => l.type === t));
    const e = entryOf(s), bpm = bpmOf(s);
    const busy = S.analyzing.has(s.id);
    list.append(
      h('button', { class: 'card', onclick: () => openSong(s) },
        h('div', { class: 'card-top' },
          h('span', { class: 'title' }, s.title),
          h('span', { class: 'dur' }, fmt(s.analysis?.duration))),
        h('div', { class: 'chips' },
          types.map((t) => h('span', { class: `chip t-${t}` }, `${TYPES[t].icon} ${TYPES[t].label}`))),
        h('div', { class: 'meta' },
          busy ? h('span', { class: 'busy' }, '解析中…')
            : [e != null ? h('span', {}, `入り ${fmt1(e)}`) : h('span', { class: 'dim' }, '入り 不明'),
              bpm ? h('span', {}, `${bpm.toFixed(0)} BPM`) : null])),
    );
  }
}

// ================= 取り込み =================
let pending = []; // { file, title, type, use }

function startImport(files, intoSong = null) {
  files = [...files];
  if (!files.length) return;
  pending = files.map((f) => ({
    file: f,
    title: intoSong ? intoSong.title : guessTitle(f.name),
    type: guessType(f.name),
    use: true,
  }));
  // 音声ファイルがある曲では動画は使わない
  const titles = new Set(pending.filter((p) => !isVideo(p.file)).map((p) => p.title));
  for (const p of pending) if (isVideo(p.file) && titles.has(p.title)) p.use = false;
  // 同じ名前の wav と m4a があれば、軽い m4a だけ使う
  const seen = new Map();
  for (const p of pending) {
    if (!p.use) continue;
    const k = stripExt(p.file.name);
    const q = seen.get(k);
    if (!q) { seen.set(k, p); continue; }
    const drop = /\.wav$/i.test(p.file.name) ? p : q;
    drop.use = false;
    if (drop === q) seen.set(k, p);
  }
  renderImport(intoSong);
  openSheet('#importSheet');
}

function renderImport(intoSong) {
  const body = $('#importBody');
  body.replaceChildren();
  const groups = new Map();
  for (const p of pending) {
    if (!groups.has(p.title)) groups.set(p.title, []);
    groups.get(p.title).push(p);
  }
  const titles = [...groups.keys()];
  for (const [title, items] of groups) {
    const g = h('div', { class: 'igroup' });
    const input = h('input', { class: 'ititle', value: title, disabled: !!intoSong,
      onchange: (e) => { const v = e.target.value.trim() || title; items.forEach((p) => (p.title = v)); renderImport(intoSong); } });
    g.append(h('label', { class: 'small' }, intoSong ? '追加先' : '曲名'), input);
    for (const p of items) {
      const typeSel = h('select', { onchange: (e) => (p.type = e.target.value) },
        TYPE_ORDER.map((t) => h('option', { value: t, selected: p.type === t }, `${TYPES[t].icon} ${TYPES[t].label}`)));
      const moveSel = intoSong ? null : h('select', { class: 'move', onchange: (e) => {
        const v = e.target.value;
        if (v === '__new') p.title = prompt('新しい曲名', guessTitle(p.file.name)) || p.title;
        else p.title = v;
        renderImport(intoSong);
      } },
      titles.map((t) => h('option', { value: t, selected: t === p.title }, t)),
      h('option', { value: '__new' }, '＋ 別の曲にする'));
      g.append(h('div', { class: `ifile ${p.use ? '' : 'off'}` },
        h('label', { class: 'use' }, h('input', { type: 'checkbox', checked: p.use, onchange: (e) => { p.use = e.target.checked; renderImport(intoSong); } })),
        h('div', { class: 'iname' }, h('div', { class: 'fname' }, p.file.name),
          h('div', { class: 'irow' }, typeSel, moveSel))));
    }
    body.append(g);
  }
  const n = pending.filter((p) => p.use).length;
  $('#importGo').textContent = `${n}個を保存して解析`;
  $('#importGo').disabled = !n;
  $('#importGo').onclick = () => saveImport(intoSong);
}

async function saveImport(intoSong) {
  closeSheet();
  const use = pending.filter((p) => p.use);
  pending = [];
  const touched = new Map();
  try {
    for (const p of use) {
      let song = intoSong || S.songs.find((s) => s.title === p.title) || touched.get(p.title);
      if (!song) {
        song = { id: uid(), title: p.title, created: Date.now(), layers: [], on: {} };
        S.songs.push(song);
      }
      touched.set(song.title, song);
      const id = uid();
      await store.putBlob(id, p.file);
      song.layers.push({ id, type: p.type, name: p.file.name, size: p.file.size });
      song.layers.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
    }
  } catch (e) {
    console.error(e);
    alert('保存できませんでした（スマホの空き容量が足りない可能性があります）');
  }
  for (const song of touched.values()) {
    defaultOn(song);
    await store.putSong(song);
  }
  navigator.storage?.persist?.();
  renderLibrary();
  if (intoSong && S.cur === intoSong) {
    renderLayers();
    await loadIntoDeck(intoSong);
  }
  for (const song of touched.values()) await analyze(song);
}

function defaultOn(song) {
  if (song.layers.some((l) => song.on?.[l.id])) return;
  song.on = {};
  const first = (t) => song.layers.filter((l) => l.type === t);
  const pick = first('beat').slice(0, 1).length ? first('beat').slice(0, 1)
    : first('part').length ? first('part') : first('orig').slice(0, 1).length ? first('orig').slice(0, 1) : song.layers.slice(0, 1);
  pick.forEach((l) => (song.on[l.id] = true));
}

async function analyze(song) {
  S.analyzing.add(song.id);
  renderLibrary();
  if (S.cur === song) renderPlayerInfo();
  try {
    song.analysis = await analyzeSong(song.layers, store.blob, (msg) => {
      if (S.cur === song) $('#status').textContent = msg;
    });
    await store.putSong(song);
  } catch (e) {
    console.error(e);
    toast(`${song.title} の解析に失敗しました`);
  }
  S.analyzing.delete(song.id);
  renderLibrary();
  if (S.cur === song) { $('#status').textContent = ''; buildWave(); renderPlayerInfo(); }
}

// ================= 画面：プレイヤー =================
async function openSong(song) {
  ensureAudio(); // タップの直後に音の準備を始める（iPhoneの決まり）
  S.cur = song;
  S.loopBars = 0; S.loop = null;
  song.lastPlayed = Date.now();
  store.putSong(song);
  show('player');
  history.pushState({ p: 'player' }, '');
  $('#pTitle').textContent = song.title;
  $('#discLabel').textContent = song.title;
  renderLayers();
  buildWave();
  renderPlayerInfo();
  renderTransport();
  $('#status').textContent = '読み込み中…';
  await ensureAudio();
  const ok = await loadIntoDeck(song);
  if (S.cur !== song) return;
  $('#status').textContent = ok ? '' : '再生できるファイルがありません';
  if (ok) { play(); mediaSession(song); }
}

function closePlayer() {
  pauseDeck();
  S.cur = null;
  show('library');
  renderLibrary();
}

function renderLayers() {
  const s = S.cur, box = $('#layers');
  box.replaceChildren();
  for (const l of s.layers) {
    const on = !!s.on?.[l.id];
    const same = s.layers.filter((x) => x.type === l.type);
    const label = same.length > 1 ? `${TYPES[l.type].label}${same.indexOf(l) + 1}` : TYPES[l.type].label;
    box.append(h('button', { class: `layer t-${l.type} ${on ? 'on' : ''}`, onclick: () => toggleLayer(l) },
      `${TYPES[l.type].icon} ${label}`));
  }
}

function toggleLayer(l) {
  const s = S.cur;
  s.on ||= {};
  // 原曲を入れたらビート・声を外す（逆も）。同時に鳴らすと音が二重になるため
  const turningOn = !s.on[l.id];
  if (turningOn && l.type === 'orig') s.layers.forEach((x) => { if (x.id !== l.id) s.on[x.id] = false; });
  if (turningOn && l.type !== 'orig') s.layers.forEach((x) => { if (x.type === 'orig') s.on[x.id] = false; });
  s.on[l.id] = turningOn;
  for (const x of s.layers) send({ type: 'gain', id: x.id, value: s.on[x.id] ? 1 : 0 });
  store.putSong(s);
  renderLayers();
}

function renderPlayerInfo() {
  const s = S.cur;
  if (!s) return;
  const bpm = bpmOf(s);
  $('#bpm').textContent = bpm ? `${bpm.toFixed(1)} BPM` : 'BPM --';
  const e = entryOf(s);
  $('#entryInfo').textContent = S.analyzing.has(s.id) ? '解析中…' : e != null ? `入り ${fmt1(e)}` : '入り 不明';
}

function renderTransport() {
  $('#play').textContent = S.playing ? '❚❚' : '▶';
  $('#play').classList.toggle('on', S.playing);
  const lb = $('#loop');
  lb.textContent = S.loopBars ? `🔁 ${S.loopBars}小節` : '🔁';
  lb.classList.toggle('on', !!S.loopBars);
}

// ---------- 波形 ----------
let waveImg = null;
function buildWave() {
  const s = S.cur, c = $('#wave');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, hgt = c.clientHeight;
  if (!w) return;
  c.width = w * dpr; c.height = hgt * dpr;
  const off = document.createElement('canvas');
  off.width = c.width; off.height = c.height;
  const g = off.getContext('2d');
  g.scale(dpr, dpr);
  const a = s.analysis;
  const dur = a?.duration || 0;
  waveImg = { off, dur, w, h: hgt };
  if (!a || !dur) return;
  const on = s.layers.filter((l) => s.on?.[l.id] && a.peaks[l.id]);
  const src = (on.length ? on : s.layers.filter((l) => a.peaks[l.id])).map((l) => a.peaks[l.id]);
  if (!src.length) return;
  const n = src[0].length;
  const vals = new Array(n).fill(0).map((_, i) => Math.max(...src.map((p) => p[i] || 0)));
  const max = Math.max(1, ...vals);
  const mid = (hgt - 10) / 2;
  const bw = w / n;
  g.fillStyle = getCss('--wave');
  for (let i = 0; i < n; i++) {
    const v = (vals[i] / max) * mid * 0.95;
    g.fillRect(i * bw, mid - v, Math.max(1, bw), Math.max(1, v * 2));
  }
  // 小節の線（入りを1小節目として）
  const T = beatLen(s);
  if (T) {
    const bar = 4 * T, an = anchorOf(s);
    g.fillStyle = getCss('--grid');
    // 線が詰まりすぎる時は4小節ごとだけ引く
    const every = (bar / dur) * w < 8 ? 4 : 1;
    let k = Math.ceil(-an / bar);
    for (let t = an + k * bar; t < dur; t += bar, k++) {
      if (k % every) continue;
      g.globalAlpha = k % 4 === 0 ? 0.6 : 0.25;
      g.fillRect((t / dur) * w, 0, 1, hgt - 10);
    }
    g.globalAlpha = 1;
  }
  // 声が入っている区間（下の帯）
  if (a.voice) {
    g.fillStyle = getCss('--voice');
    for (let i = 0; i < a.voice.length; i++) {
      if (a.voice[i] === '1') g.fillRect(((i * VOICE_STEP) / dur) * w, hgt - 6, Math.max(1, (VOICE_STEP / dur) * w + 0.5), 5);
    }
  }
}
const getCss = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function drawWave(t) {
  const c = $('#wave');
  if (!waveImg) return;
  const g = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, c.width, c.height);
  g.drawImage(waveImg.off, 0, 0);
  g.scale(dpr, dpr);
  const { dur, w, h: hgt } = waveImg;
  if (!dur) return;
  const s = S.cur;
  // 再生済みの部分を明るく
  const x = (t / dur) * w;
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = getCss('--accent');
  g.globalAlpha = 0.85;
  g.fillRect(0, 0, x, hgt - 10);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  if (S.loop) {
    g.fillStyle = getCss('--loop');
    g.fillRect((S.loop.start / dur) * w, 0, ((S.loop.end - S.loop.start) / dur) * w, hgt - 10);
  }
  const e = entryOf(s);
  if (e != null) {
    const ex = (e / dur) * w;
    g.fillStyle = getCss('--entry');
    g.fillRect(ex - 1, 0, 2, hgt - 8);
    g.font = 'bold 10px -apple-system, sans-serif';
    g.fillText('入り', Math.min(ex + 3, w - 22), 11);
  }
  g.fillStyle = getCss('--text');
  g.fillRect(x - 1, 0, 2, hgt);
}

function waveSeek(e) {
  const c = $('#wave');
  const r = c.getBoundingClientRect();
  const dur = S.length / S.sr;
  if (!dur) return;
  seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur);
}

// ---------- 小節カウンター と カウントイン ----------
function renderCounter(t) {
  const s = S.cur, T = beatLen(s);
  const out = $('#counter'), big = $('#count');
  if (!T) { out.textContent = ''; big.textContent = ''; return; }
  const an = anchorOf(s);
  const beats = (t - an) / T;
  if (beats < 0) {
    const left = Math.ceil(-beats - 1e-6);
    out.textContent = left > 4 ? `入りまで ${Math.ceil(left / 4)}小節` : `入りまで ${left}拍`;
  } else {
    const b = Math.floor(beats + 1e-6);
    out.textContent = `${Math.floor(b / 4) + 1}小節 ${(b % 4) + 1}拍`;
  }
  let txt = '';
  if (S.countIn && entryOf(s) != null && S.rate > 0.5) {
    if (beats >= -4 && beats < 0) txt = String(Math.ceil(-beats - 1e-6));
    else if (beats >= 0 && beats < 1) txt = 'IN';
  }
  if (big.textContent !== txt) {
    big.textContent = txt;
    big.classList.remove('pop');
    if (txt) { void big.offsetWidth; big.classList.add('pop'); }
  }
  // 拍ごとに光る
  const phase = ((t - an) / T) % 1;
  $('#beatDot').style.opacity = S.rate > 0.5 && (phase + 1) % 1 < 0.15 ? 1 : 0.15;
}

// ---------- レコード（スクラッチ） ----------
const RPS = 33.333 / 60; // 1秒に回る回数
const disc = { touching: false, last: 0, acc: 0, lastT: 0, cx: 0, cy: 0 };

function setupDisc() {
  const el = $('#disc');
  const angleOf = (e) => Math.atan2(e.clientY - disc.cy, e.clientX - disc.cx);
  el.addEventListener('pointerdown', (e) => {
    if (!S.loaded) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    disc.cx = r.left + r.width / 2; disc.cy = r.top + r.height / 2;
    disc.touching = true;
    disc.last = angleOf(e);
    disc.acc = 0;
    disc.lastT = performance.now();
    el.classList.add('held');
    send({ type: 'scratch', on: true });
  });
  el.addEventListener('pointermove', (e) => {
    if (!disc.touching) return;
    const a = angleOf(e);
    let d = a - disc.last;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    // 中心のすぐ近くは角度が暴れるので無視
    if (Math.hypot(e.clientX - disc.cx, e.clientY - disc.cy) > 18) disc.acc += d;
    disc.last = a;
  });
  const up = () => {
    if (!disc.touching) return;
    disc.touching = false;
    el.classList.remove('held');
    send({ type: 'scratch', on: false });
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);

  const cut = $('#cut');
  const close = (e) => { e.preventDefault(); cut.classList.add('on'); send({ type: 'fader', open: false }); };
  const open = () => { cut.classList.remove('on'); send({ type: 'fader', open: true }); };
  cut.addEventListener('pointerdown', close);
  cut.addEventListener('pointerup', open);
  cut.addEventListener('pointercancel', open);
  cut.addEventListener('pointerleave', open);
}

function discFrame(now) {
  if (disc.touching) {
    const dt = Math.max(0.001, (now - disc.lastT) / 1000);
    send({ type: 'hand', rate: disc.acc / dt / (2 * Math.PI * RPS) });
    disc.acc = 0;
    disc.lastT = now;
  }
}

// ---------- 毎フレーム ----------
function frame(now) {
  if (S.cur) {
    discFrame(now);
    const t = nowSec();
    drawWave(t);
    $('#disc').style.transform = `rotate(${(t * RPS * 360) % 360}deg)`;
    $('#time').textContent = `${fmt(t)} / ${fmt(S.length / S.sr)}`;
    renderCounter(t);
  }
  requestAnimationFrame(frame);
}

// ================= 調整シート =================
let taps = [];
function renderEdit() {
  const s = S.cur, body = $('#editBody');
  body.replaceChildren();
  const T = beatLen(s);
  const save = () => { store.putSong(s); buildWave(); renderPlayerInfo(); renderEdit(); renderLibrary(); if (S.loopBars) setLoop(S.loopBars); };
  const e = entryOf(s), bpm = bpmOf(s);

  body.append(
    h('section', {},
      h('h3', {}, '入り', h('span', { class: 'val' }, e != null ? fmt1(e) : '不明'),
        s.entryManual != null ? h('span', { class: 'tag' }, '手動') : null),
      h('div', { class: 'row' },
        h('button', { disabled: !T || e == null, onclick: () => { s.entryManual = e - T; save(); } }, '−1拍'),
        h('button', { disabled: !T || e == null, onclick: () => { s.entryManual = e + T; save(); } }, '+1拍'),
        h('button', { class: 'primary', onclick: () => { s.entryManual = nowSec(); save(); toast('今の位置を入りにしました'); } }, '今の位置を入りに'),
        h('button', { disabled: s.entryManual == null, onclick: () => { delete s.entryManual; save(); } }, '自動に戻す')),
      h('p', { class: 'hint' }, '曲を流しながら、ラップが始まった瞬間に「今の位置を入りに」を押すと確実です。')),
    h('section', {},
      h('h3', {}, 'テンポ', h('span', { class: 'val' }, bpm ? `${bpm.toFixed(1)} BPM` : '--'),
        s.bpmManual ? h('span', { class: 'tag' }, '手動') : null),
      h('div', { class: 'row' },
        h('button', { disabled: !bpm, onclick: () => { s.bpmManual = bpm / 2; save(); } }, '÷2'),
        h('button', { disabled: !bpm, onclick: () => { s.bpmManual = bpm * 2; save(); } }, '×2'),
        h('button', { class: 'primary tap', onpointerdown: (ev) => { ev.preventDefault(); tapTempo(s, save); } }, 'TAP'),
        h('button', { disabled: !s.bpmManual && s.beat0Manual == null, onclick: () => { delete s.bpmManual; delete s.beat0Manual; save(); } }, '自動に戻す')),
      h('p', { class: 'hint' }, '小節の数え方がズレる時は、曲に合わせてTAPを4回以上押してください。')),
    h('section', {},
      h('h3', {}, '曲名'),
      h('input', { class: 'ititle', value: s.title, onchange: (ev) => { s.title = ev.target.value.trim() || s.title; $('#pTitle').textContent = s.title; $('#discLabel').textContent = s.title; save(); } })),
    h('section', {},
      h('h3', {}, 'ファイル'),
      s.layers.map((l) => h('div', { class: 'ifile' },
        h('div', { class: 'iname' }, h('div', { class: 'fname' }, l.name),
          h('div', { class: 'irow' },
            h('select', { onchange: async (ev) => { l.type = ev.target.value; await store.putSong(s); renderLayers(); analyze(s); } },
              TYPE_ORDER.map((t) => h('option', { value: t, selected: l.type === t }, `${TYPES[t].icon} ${TYPES[t].label}`))),
            h('button', { class: 'danger small', onclick: () => removeLayer(s, l) }, '外す'))))),
      h('button', { class: 'btn', disabled: S.analyzing.has(s.id), onclick: () => { closeSheet(); analyze(s); } }, '↻ 解析し直す'),
      h('label', { class: 'btn' }, '＋ ファイルを追加',
        h('input', { type: 'file', multiple: true, accept: 'audio/*,video/mp4,.m4a,.wav,.mp3', hidden: true,
          onchange: (ev) => { closeSheet(); startImport(ev.target.files, s); } }))),
    h('section', {},
      h('label', { class: 'switch' },
        h('input', { type: 'checkbox', checked: S.countIn, onchange: (ev) => { S.countIn = ev.target.checked; localStorage.setItem('countIn', S.countIn ? '1' : '0'); } }),
        '入りの前に 4・3・2・1 を表示')),
    h('section', {},
      h('button', { class: 'danger', onclick: () => deleteSong(s) }, 'この曲を削除')),
  );
}

function tapTempo(s, save) {
  const t = nowSec(), now = performance.now();
  if (taps.length && now - taps[taps.length - 1].now > 2000) taps = [];
  taps.push({ t, now });
  taps = taps.slice(-8);
  if (taps.length >= 4) {
    const iv = (taps[taps.length - 1].now - taps[0].now) / (taps.length - 1) / 1000;
    s.bpmManual = 60 / iv;
    s.beat0Manual = S.playing ? t : beat0Of(s);
    save();
  } else toast(`TAP ${taps.length}`);
}

async function removeLayer(s, l) {
  if (!confirm(`${l.name} をこの曲から外しますか？`)) return;
  s.layers = s.layers.filter((x) => x !== l);
  delete s.on?.[l.id];
  await store.delBlob(l.id);
  if (!s.layers.length) return deleteSong(s, true);
  defaultOn(s);
  await store.putSong(s);
  closeSheet();
  renderLayers();
  await loadIntoDeck(s);
  analyze(s);
}

async function deleteSong(s, skipConfirm) {
  if (!skipConfirm && !confirm(`「${s.title}」を削除しますか？`)) return;
  for (const l of s.layers) await store.delBlob(l.id);
  await store.delSong(s.id);
  S.songs = S.songs.filter((x) => x !== s);
  closeSheet();
  closePlayer();
}

// ================= 共通 =================
function show(name) {
  document.body.dataset.screen = name;
}
function openSheet(sel) {
  $('#scrim').hidden = false;
  document.querySelectorAll('.sheet').forEach((x) => (x.hidden = true));
  $(sel).hidden = false;
}
function closeSheet() {
  $('#scrim').hidden = true;
  document.querySelectorAll('.sheet').forEach((x) => (x.hidden = true));
}

function mediaSession(song) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: song.title, artist: 'ラップデッキ' });
  navigator.mediaSession.setActionHandler('play', play);
  navigator.mediaSession.setActionHandler('pause', pauseDeck);
}

async function init() {
  S.songs = await store.songs();
  renderLibrary();
  // 解析のやり方が新しくなっていたら、保存済みの曲も順番に解析し直す
  (async () => {
    for (const s of S.songs) if (s.analysis?.v !== ANALYSIS_V) await analyze(s);
  })();
  $('#pick').addEventListener('change', (e) => { startImport(e.target.files); e.target.value = ''; });
  $('#search').addEventListener('input', renderLibrary);
  $('#back').addEventListener('click', () => history.back());
  window.addEventListener('popstate', () => { closeSheet(); if (S.cur) closePlayer(); });
  $('#play').addEventListener('click', () => (S.playing ? pauseDeck() : play()));
  $('#toEntry').addEventListener('click', () => {
    const s = S.cur, T = beatLen(s), e = entryOf(s);
    seek(e == null ? 0 : Math.max(0, anchorOf(s) - (T ? 8 * T : 4)));
    play();
  });
  const barJump = (k) => { const T = beatLen(S.cur); seek(nowSec() + k * (T ? 4 * T : 5)); };
  $('#prevBar').addEventListener('click', () => barJump(-1));
  $('#nextBar').addEventListener('click', () => barJump(1));
  $('#loop').addEventListener('click', () => {
    if (!beatLen(S.cur)) return toast('テンポが分からないためループできません');
    const next = { 0: 4, 4: 8, 8: 16, 16: 0 }[S.loopBars];
    setLoop(next);
    renderTransport();
  });
  $('#edit').addEventListener('click', () => { renderEdit(); openSheet('#editSheet'); });
  $('#scrim').addEventListener('click', closeSheet);
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheet));
  const wave = $('#wave');
  wave.addEventListener('pointerdown', (e) => { wave.setPointerCapture(e.pointerId); waveSeek(e); });
  wave.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') if (wave.hasPointerCapture(e.pointerId)) waveSeek(e); });
  window.addEventListener('resize', () => S.cur && buildWave());
  setupDisc();
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
}

init();
