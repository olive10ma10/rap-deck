import { analyzeSong, VOICE_STEP, ANALYSIS_V } from './analysis.js';
import { icon } from './icons.js';

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
  beat: { label: 'ビート', icon: 'drum' },
  orig: { label: '原曲', icon: 'music' },
  vocal: { label: '声のみ', icon: 'mic-vocal' },
  part: { label: 'パーツ', icon: 'sliders-horizontal' },
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
const ls = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const S = {
  songs: [],
  cur: null,          // 開いている曲
  mode: ls.get('mode', 'dj'),   // 'dj'（スクラッチ） / 'listen'（画面を消しても流れる）
  auto: ls.get('auto', '1') !== '0', // 聴くモードで次の曲へ進む
  queue: [],          // 続けて流す順番（曲のid）
  playing: false,
  // DJ（AudioWorklet）
  deckSong: null, sr: 44100, length: 0, pos: 0, rate: 0, posAt: 0,
  loopBars: 0, loop: null,
  analyzing: new Set(),
  countIn: ls.get('countIn', '1') !== '0',
};
const isListen = () => S.mode === 'listen';

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
const typeChip = (t, cls = 'chip') => h('span', { class: `${cls} t-${t}` }, icon(TYPES[t].icon), TYPES[t].label);

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

// ================= DJモードの音（AudioWorklet） =================
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
      else if (m.type === 'ended' && !isListen()) { S.playing = false; renderTransport(); }
    };
  });
  return audioReady;
}
// DJモードを使わない間は止めて、電池とメモリを節約する
function sleepDeck() {
  send({ type: 'load', layers: [], length: 0 });
  S.deckSong = null;
  silentEl?.pause();
  ctx?.suspend();
}
let silentUrl;
function silentWav() {
  if (silentUrl) return silentUrl;
  const n = 4410, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 44100, true); v.setUint32(28, 88200, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  return (silentUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
}
const send = (m, transfer) => node && node.port.postMessage(m, transfer || []);

async function loadIntoDeck(song) {
  S.deckSong = null;
  send({ type: 'pause' });
  const decoded = [];
  for (const l of song.layers) {
    const blob = await store.blob(l.id);
    if (!blob) continue;
    try {
      decoded.push({ l, buf: await ctx.decodeAudioData(await blob.arrayBuffer()) });
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
  S.deckSong = song;
  return true;
}

// ================= 聴くモードの音（<audio>：画面を消しても流れる） =================
const audioEl = new Audio();
audioEl.preload = 'auto';
audioEl.setAttribute('playsinline', '');
let listenKey = '', listenUrl = '', listenUnlocked = false;

// タップの中で一度鳴らしておくと、あとから曲を入れ替えても再生できる
function unlockListen() {
  if (listenUnlocked) return;
  listenUnlocked = true;
  if (!audioEl.src) {
    audioEl.src = silentWav();
    audioEl.play().then(() => audioEl.pause()).catch(() => {});
  }
}

const onIds = (song) => {
  const ids = song.layers.filter((l) => song.on?.[l.id]).map((l) => l.id);
  return ids.length ? ids : song.layers.slice(0, 1).map((l) => l.id);
};

// 鳴らすファイルが1つならそのまま、2つ以上（ビート＋声など）なら1本に重ねてから流す
async function loadListen(song) {
  const ids = onIds(song);
  const key = song.id + ':' + ids.join(',');
  if (key === listenKey) return true;
  let blob;
  if (ids.length === 1) {
    blob = await store.blob(ids[0]);
  } else {
    $('#status').textContent = '重ねています…';
    try {
      const bufs = [];
      for (const id of ids) {
        const b = await store.blob(id);
        if (b) bufs.push(await new OfflineAudioContext(2, 1, 44100).decodeAudioData(await b.arrayBuffer()));
      }
      const len = Math.max(...bufs.map((b) => b.length));
      const oc = new OfflineAudioContext(2, len, 44100);
      for (const b of bufs) {
        const src = oc.createBufferSource();
        src.buffer = b;
        src.connect(oc.destination);
        src.start(0);
      }
      blob = wavBlob(await oc.startRendering());
    } catch (e) {
      console.warn(e);
      blob = await store.blob(ids[0]);
    }
    if ($('#status').textContent === '重ねています…') $('#status').textContent = '';
  }
  if (S.cur !== song || !blob) return false;
  if (listenUrl) URL.revokeObjectURL(listenUrl);
  listenUrl = URL.createObjectURL(blob);
  listenKey = key;
  audioEl.src = listenUrl;
  await new Promise((r) => {
    audioEl.addEventListener('loadedmetadata', r, { once: true });
    audioEl.addEventListener('error', r, { once: true });
  });
  return true;
}

function wavBlob(buf) {
  const ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVEfmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  w(36, 'data'); out.setUint32(40, n * ch * 2, true);
  const data = [...Array(ch)].map((_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([out], { type: 'audio/wav' });
}

audioEl.addEventListener('play', () => { if (isListen()) { S.playing = true; renderTransport(); } });
audioEl.addEventListener('pause', () => { if (isListen()) { S.playing = false; renderTransport(); } });
audioEl.addEventListener('timeupdate', () => {
  if (!isListen()) return;
  if (S.loop && audioEl.currentTime >= S.loop.end) audioEl.currentTime = S.loop.start;
  positionState();
});
audioEl.addEventListener('ended', () => {
  if (!isListen()) return;
  S.playing = false;
  renderTransport();
  if (S.auto) nextSong();
});

// ================= 再生の操作（どちらのモードでも同じ） =================
function nowSec() {
  if (!S.cur) return 0;
  if (isListen()) return audioEl.currentTime || 0;
  if (!S.deckSong) return 0;
  const dt = (performance.now() - S.posAt) / 1000;
  const p = S.pos + S.rate * S.sr * Math.min(dt, 0.1);
  return Math.max(0, Math.min(S.length, p)) / S.sr;
}
function durSec() {
  if (isListen()) return isFinite(audioEl.duration) ? audioEl.duration : S.cur?.analysis?.duration || 0;
  return S.deckSong ? S.length / S.sr : S.cur?.analysis?.duration || 0;
}
const moving = () => (isListen() ? S.playing : S.rate > 0.5);

function play() {
  if (isListen()) {
    if (!listenKey) return;
    if (audioEl.ended) audioEl.currentTime = 0;
    audioEl.play().catch(() => toast('もう一度 再生を押してください'));
    return;
  }
  if (!S.deckSong) return;
  ensureAudio();
  if (nowSec() >= durSec() - 0.05) seek(0);
  send({ type: 'play', instant: true });
  S.playing = true;
  renderTransport();
}
function pause() {
  if (isListen()) audioEl.pause();
  else {
    send({ type: 'pause' });
    S.playing = false;
    renderTransport();
  }
}
function seek(sec) {
  sec = Math.max(0, Math.min(durSec() - 0.01, sec));
  if (isListen()) audioEl.currentTime = sec;
  else {
    const p = sec * S.sr;
    send({ type: 'seek', pos: p });
    S.pos = p; S.posAt = performance.now();
  }
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
function sortedSongs() {
  return [...S.songs].sort((a, b) => (b.lastPlayed || b.created) - (a.lastPlayed || a.created));
}
function renderLibrary() {
  const list = $('#songs');
  const q = $('#search').value.trim().toLowerCase();
  list.replaceChildren();
  const songs = sortedSongs().filter((s) => !q || s.title.toLowerCase().includes(q));
  $('#searchWrap').hidden = S.songs.length < 6;
  $('#empty').hidden = S.songs.length > 0;
  $('#playAll').hidden = S.songs.length < 2;
  for (const s of songs) {
    const types = TYPE_ORDER.filter((t) => s.layers.some((l) => l.type === t));
    const e = entryOf(s), bpm = bpmOf(s);
    const busy = S.analyzing.has(s.id);
    list.append(
      h('button', { class: `card ${S.cur === s ? 'now' : ''}`, onclick: () => openSong(s) },
        h('div', { class: 'card-top' },
          h('span', { class: 'title' }, s.title),
          h('span', { class: 'dur' }, fmt(s.analysis?.duration))),
        h('div', { class: 'chips' }, types.map((t) => typeChip(t))),
        h('div', { class: 'meta' },
          busy ? h('span', { class: 'busy' }, '解析中…')
            : [e != null ? h('span', { class: 'entry' }, `入り ${fmt1(e)}`) : h('span', { class: 'dim' }, '入り 不明'),
              bpm ? h('span', {}, `${bpm.toFixed(0)} BPM`) : null])),
    );
  }
}

// ホーム画面から開いていない時だけ、追加の案内を出す
function renderInstallHint() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('#install').hidden = standalone || ls.get('installHint') === '0';
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
  openPanel('#importPanel');
}

function typeSelect(value, onchange) {
  return h('select', { onchange: (e) => onchange(e.target.value) },
    TYPE_ORDER.map((t) => h('option', { value: t, selected: value === t }, TYPES[t].label)));
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
    const input = h('input', { class: 'ititle', value: title, disabled: !!intoSong, enterkeyhint: 'done', autocapitalize: 'off', autocorrect: 'off',
      onchange: (e) => { const v = e.target.value.trim() || title; items.forEach((p) => (p.title = v)); renderImport(intoSong); } });
    g.append(h('label', { class: 'small' }, intoSong ? '追加先' : '曲名'), input);
    for (const p of items) {
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
          h('div', { class: 'irow' }, typeSelect(p.type, (v) => (p.type = v)), moveSel))));
    }
    body.append(g);
  }
  const n = pending.filter((p) => p.use).length;
  $('#importGo').textContent = `${n}個を保存して解析`;
  $('#importGo').disabled = !n;
  $('#importGo').onclick = () => saveImport(intoSong);
}

async function saveImport(intoSong) {
  closePanel();
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
  if (intoSong && S.cur === intoSong) await reloadCurrent();
  for (const song of touched.values()) await analyze(song);
}

function defaultOn(song) {
  if (song.layers.some((l) => song.on?.[l.id])) return;
  song.on = {};
  const of = (t) => song.layers.filter((l) => l.type === t);
  const pick = of('beat').length ? of('beat').slice(0, 1)
    : of('part').length ? of('part') : of('orig').length ? of('orig').slice(0, 1) : song.layers.slice(0, 1);
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
// opts.push=false は「次の曲へ」のように画面の履歴を増やさない時
async function openSong(song, opts = {}) {
  if (opts.mode) setModeFlag(opts.mode);
  // タップの直後に音の準備を始める（iPhoneの決まり）
  unlockListen();
  if (!isListen()) ensureAudio();
  if (!opts.queue) S.queue = sortedSongs().map((s) => s.id);
  else S.queue = opts.queue;
  const wasOpen = !!S.cur;
  pause();
  S.cur = song;
  S.loopBars = 0; S.loop = null;
  song.lastPlayed = Date.now();
  store.putSong(song);
  show('player');
  if (!wasOpen && opts.push !== false) history.pushState({ p: 'player' }, '');
  $('#pTitle').textContent = song.title;
  $('#discLabel').textContent = song.title;
  $('#coverTitle').textContent = song.title;
  renderLayers();
  buildWave();
  renderPlayerInfo();
  renderTransport();
  const ok = await loadCurrent(song);
  if (S.cur !== song) return;
  if (ok) play();
  mediaSession(song);
}

// 今のモードで、今の曲を鳴らせる状態にする
async function loadCurrent(song) {
  $('#status').textContent = '読み込み中…';
  let ok;
  if (isListen()) {
    ok = await loadListen(song);
  } else {
    await ensureAudio();
    ok = S.deckSong === song || (await loadIntoDeck(song));
  }
  if (S.cur === song) $('#status').textContent = ok ? '' : '再生できるファイルがありません';
  return ok;
}

async function reloadCurrent() {
  const s = S.cur, t = nowSec(), was = S.playing;
  pause();
  renderLayers();
  S.deckSong = null; listenKey = '';
  if (await loadCurrent(s)) { seek(t); if (was) play(); }
}

function setModeFlag(mode) {
  S.mode = mode;
  ls.set('mode', mode);
  document.body.dataset.mode = mode;
  document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
}

// DJ ⇄ 聴く。再生位置はそのまま引き継ぐ
async function switchMode(mode) {
  if (mode === S.mode || !S.cur) return;
  if (mode === 'listen') unlockListen(); else ensureAudio();
  const song = S.cur, t = nowSec(), was = S.playing;
  pause();
  setModeFlag(mode);
  if (mode === 'listen') sleepDeck();
  else { audioEl.removeAttribute('src'); audioEl.load(); listenKey = ''; }
  renderTransport();
  if (await loadCurrent(song)) {
    seek(t);
    if (S.loopBars) setLoop(S.loopBars);
    if (was) play();
  }
  if (mode === 'listen') toast('画面を消しても流れ続けます');
}

function nextSong(dir = 1) {
  const q = S.queue.filter((id) => S.songs.some((s) => s.id === id));
  if (!q.length || !S.cur) return;
  const i = q.indexOf(S.cur.id);
  const next = S.songs.find((s) => s.id === q[(i + dir + q.length) % q.length]);
  if (next) openSong(next, { queue: q, push: false });
}

function closePlayer() {
  pause();
  sleepDeck();
  audioEl.removeAttribute('src');
  audioEl.load();
  listenKey = '';
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
      icon(TYPES[l.type].icon), label));
  }
}

async function toggleLayer(l) {
  const s = S.cur;
  s.on ||= {};
  // 原曲を入れたらビート・声を外す（逆も）。同時に鳴らすと音が二重になるため
  const turningOn = !s.on[l.id];
  if (!turningOn && s.layers.filter((x) => s.on[x.id]).length === 1) return; // 全部消すと何も鳴らない
  if (turningOn && l.type === 'orig') s.layers.forEach((x) => { if (x.id !== l.id) s.on[x.id] = false; });
  if (turningOn && l.type !== 'orig') s.layers.forEach((x) => { if (x.type === 'orig') s.on[x.id] = false; });
  s.on[l.id] = turningOn;
  store.putSong(s);
  renderLayers();
  buildWave();
  if (isListen()) {
    const t = nowSec(), was = S.playing;
    if (await loadListen(s)) { seek(t); if (was) play(); }
  } else {
    for (const x of s.layers) send({ type: 'gain', id: x.id, value: s.on[x.id] ? 1 : 0 });
  }
}

function renderPlayerInfo() {
  const s = S.cur;
  if (!s) return;
  const bpm = bpmOf(s);
  $('#bpm').textContent = bpm ? `${bpm.toFixed(1)} BPM` : 'BPM --';
  const e = entryOf(s);
  $('#entryInfo').textContent = S.analyzing.has(s.id) ? '解析中…' : e != null ? `入り ${fmt1(e)}` : '入り 不明';
  const q = S.queue, i = q.indexOf(s.id);
  const next = S.songs.find((x) => x.id === q[(i + 1) % q.length]);
  $('#nextTitle').textContent = next && next !== s ? next.title : '—';
  $('#autoNext').checked = S.auto;
}

function renderTransport() {
  const p = $('#play');
  p.replaceChildren(icon(S.playing ? 'pause' : 'play', 'big'));
  p.setAttribute('aria-label', S.playing ? '一時停止' : '再生');
  const lb = $('#loop');
  lb.replaceChildren(icon('repeat'), h('small', {}, S.loopBars ? `${S.loopBars}小節` : 'ループ'));
  lb.classList.toggle('on', !!S.loopBars);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = S.playing ? 'playing' : 'paused';
}

// ---------- 波形 ----------
let waveImg = null;
function buildWave() {
  const s = S.cur, c = $('#wave');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, hgt = c.clientHeight;
  if (!w || !s) return;
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
  const r = $('#wave').getBoundingClientRect();
  const dur = durSec();
  if (!dur) return;
  seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur);
}

// ---------- 小節カウンター と カウントイン ----------
function renderCounter(t) {
  const s = S.cur, T = beatLen(s);
  const out = $('#counter');
  if (!T) { out.textContent = ''; setCount(''); return; }
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
  if (S.countIn && entryOf(s) != null && moving()) {
    if (beats >= -4 && beats < 0) txt = String(Math.ceil(-beats - 1e-6));
    else if (beats >= 0 && beats < 1) txt = 'IN';
  }
  setCount(txt);
  // 拍ごとに光る
  const phase = ((t - an) / T) % 1;
  $('#beatDot').style.opacity = moving() && (phase + 1) % 1 < 0.15 ? 1 : 0.15;
}

// レコードの上（DJ）とジャケットの上（聴く）の両方に出す
function setCount(txt) {
  document.querySelectorAll('.count').forEach((big) => {
    if (big.textContent === txt) return;
    big.textContent = txt;
    big.classList.remove('pop');
    if (txt) { void big.offsetWidth; big.classList.add('pop'); }
  });
}

// ---------- レコード（スクラッチ） ----------
const RPS = 33.333 / 60; // 1秒に回る回数
const disc = { touching: false, last: 0, acc: 0, lastT: 0, cx: 0, cy: 0 };

function setupDisc() {
  const el = $('#disc');
  const angleOf = (e) => Math.atan2(e.clientY - disc.cy, e.clientX - disc.cx);
  el.addEventListener('pointerdown', (e) => {
    if (!S.deckSong) return;
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
  if (S.cur && !document.hidden) {
    const t = nowSec();
    if (!isListen()) {
      discFrame(now);
      $('#disc').style.transform = `rotate(${(t * RPS * 360) % 360}deg)`;
    } else if (S.loop && t >= S.loop.end) {
      audioEl.currentTime = S.loop.start;
    }
    drawWave(t);
    $('#time').textContent = `${fmt(t)} / ${fmt(durSec())}`;
    renderCounter(t);
  }
  requestAnimationFrame(frame);
}

// ================= 調整の画面 =================
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
      h('input', { class: 'ititle', value: s.title, enterkeyhint: 'done', autocapitalize: 'off', autocorrect: 'off',
        onchange: (ev) => { s.title = ev.target.value.trim() || s.title; $('#pTitle').textContent = s.title; $('#discLabel').textContent = s.title; $('#coverTitle').textContent = s.title; save(); mediaSession(s); } })),
    h('section', {},
      h('h3', {}, 'ファイル'),
      s.layers.map((l) => h('div', { class: 'ifile' },
        h('div', { class: 'ftype' }, icon(TYPES[l.type].icon)),
        h('div', { class: 'iname' }, h('div', { class: 'fname' }, l.name),
          h('div', { class: 'irow' },
            typeSelect(l.type, async (v) => { l.type = v; await store.putSong(s); renderLayers(); renderEdit(); analyze(s); }),
            h('button', { class: 'danger small', onclick: () => removeLayer(s, l) }, icon('trash-2'), '外す'))))),
      h('div', { class: 'row' },
        h('label', { class: 'btn' }, icon('file-plus'), 'ファイルを追加',
          h('input', { type: 'file', multiple: true, accept: 'audio/*,video/mp4,.m4a,.wav,.mp3', hidden: true,
            onchange: (ev) => startImport(ev.target.files, s) })),
        h('button', { disabled: S.analyzing.has(s.id), onclick: () => { closePanel(); analyze(s); } }, icon('rotate-ccw'), '解析し直す'))),
    h('section', {},
      h('label', { class: 'switch' },
        h('input', { type: 'checkbox', checked: S.countIn, onchange: (ev) => { S.countIn = ev.target.checked; ls.set('countIn', S.countIn ? '1' : '0'); } }),
        '入りの前に 4・3・2・1 を表示')),
    h('section', {},
      h('button', { class: 'danger', onclick: () => deleteSong(s) }, icon('trash-2'), 'この曲を削除')),
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
  renderEdit();
  await reloadCurrent();
  analyze(s);
}

async function deleteSong(s, skipConfirm) {
  if (!skipConfirm && !confirm(`「${s.title}」を削除しますか？`)) return;
  for (const l of s.layers) await store.delBlob(l.id);
  await store.delSong(s.id);
  S.songs = S.songs.filter((x) => x !== s);
  hidePanels();
  closePlayer();
  history.go(-2);
}

// ================= 共通 =================
function show(name) {
  document.body.dataset.screen = name;
}
// 続きの画面は、下から出さずにその場で開く（素材帳の決まり）
function openPanel(sel) {
  const already = document.querySelector('.panel:not([hidden])');
  hidePanels();
  $(sel).hidden = false;
  $(sel).scrollTop = 0;
  if (!already) history.pushState({ panel: sel }, '');
}
function hidePanels() {
  document.querySelectorAll('.panel').forEach((x) => (x.hidden = true));
}
function closePanel() {
  if (history.state?.panel) history.back();
  else hidePanels();
}

function mediaSession(song) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title,
    artist: 'ラップデッキ',
    artwork: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
  const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch {} };
  set('play', play);
  set('pause', pause);
  set('seekbackward', () => seek(nowSec() - 10));
  set('seekforward', () => seek(nowSec() + 10));
  set('seekto', (d) => seek(d.seekTime));
  set('previoustrack', () => (nowSec() > 3 ? seek(0) : nextSong(-1)));
  set('nexttrack', () => nextSong(1));
}
function positionState() {
  try {
    const d = durSec();
    if (d && navigator.mediaSession?.setPositionState) navigator.mediaSession.setPositionState({ duration: d, position: Math.min(d, nowSec()), playbackRate: 1 });
  } catch {}
}

function staticIcons() {
  document.querySelectorAll('[data-icon]').forEach((el) => el.prepend(icon(el.dataset.icon, el.dataset.iconClass || '')));
}

async function init() {
  staticIcons();
  setModeFlag(S.mode);
  renderTransport();
  S.songs = await store.songs();
  renderLibrary();
  renderInstallHint();
  // 解析のやり方が新しくなっていたら、保存済みの曲も順番に解析し直す
  (async () => {
    for (const s of S.songs) if (s.analysis?.v !== ANALYSIS_V) await analyze(s);
  })();

  $('#pick').addEventListener('change', (e) => { startImport(e.target.files); e.target.value = ''; });
  $('#search').addEventListener('input', renderLibrary);
  $('#playAll').addEventListener('click', () => {
    const q = sortedSongs().map((s) => s.id);
    S.auto = true; ls.set('auto', '1');
    openSong(S.songs.find((s) => s.id === q[0]), { mode: 'listen', queue: q });
  });
  $('#installClose').addEventListener('click', () => { ls.set('installHint', '0'); renderInstallHint(); });
  $('#aboutBtn').addEventListener('click', () => openPanel('#aboutPanel'));
  $('#back').addEventListener('click', () => history.back());
  window.addEventListener('popstate', () => {
    if (document.querySelector('.panel:not([hidden])')) return hidePanels();
    if (S.cur) closePlayer();
  });
  document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => switchMode(b.dataset.mode)));
  $('#play').addEventListener('click', () => (S.playing ? pause() : play()));
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
    setLoop({ 0: 4, 4: 8, 8: 16, 16: 0 }[S.loopBars]);
    renderTransport();
  });
  $('#nextBtn').addEventListener('click', () => nextSong(1));
  $('#autoNext').addEventListener('change', (e) => { S.auto = e.target.checked; ls.set('auto', S.auto ? '1' : '0'); });
  $('#edit').addEventListener('click', () => { renderEdit(); openPanel('#editPanel'); });
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanel));
  const wave = $('#wave');
  wave.addEventListener('pointerdown', (e) => { wave.setPointerCapture(e.pointerId); waveSeek(e); });
  wave.addEventListener('pointermove', (e) => { if (wave.hasPointerCapture(e.pointerId)) waveSeek(e); });
  window.addEventListener('resize', () => S.cur && buildWave());
  // iPhone の Safari でピンチの拡大を止める
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  // キーボードで入力欄が隠れないように
  document.addEventListener('focusin', (e) => {
    if (e.target.matches('input, select')) setTimeout(() => e.target.scrollIntoView({ block: 'nearest' }), 300);
  });
  setupDisc();
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
}

init();
