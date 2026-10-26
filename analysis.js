// 曲の解析：テンポ（BPM）、入り（声が始まる位置）、声が入っている区間、波形。
// すべてスマホの中で計算する。

const SR = 22050;          // 解析用に音を軽くする
const HOP = 256;           // 1コマ ≈ 11.6ms
const FPS = SR / HOP;
const VOICE_FPS = 10;      // 声の区間は0.1秒きざみで保存
export const ANALYSIS_V = 2; // 解析のやり方を変えたら上げる（保存済みの曲も解析し直される）

const pause = () => new Promise((r) => setTimeout(r, 0));

export async function decodeMono(blob) {
  const ctx = new OfflineAudioContext(1, 1, SR);
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  const n = buf.length, ch = buf.numberOfChannels;
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i];
  }
  if (ch > 1) for (let i = 0; i < n; i++) out[i] /= ch;
  return out;
}

export function peaks(x, buckets = 1200) {
  const out = new Array(buckets).fill(0);
  const step = x.length / buckets;
  for (let b = 0; b < buckets; b++) {
    let m = 0;
    const s = Math.floor(b * step), e = Math.min(x.length, Math.floor((b + 1) * step));
    for (let i = s; i < e; i += 4) { const v = Math.abs(x[i]); if (v > m) m = v; }
    out[b] = Math.min(255, Math.round(m * 255));
  }
  return out;
}

function frameRms(x) {
  const n = Math.floor(x.length / HOP);
  const out = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (let i = t * HOP, e = i + HOP; i < e; i++) s += x[i] * x[i];
    out[t] = Math.sqrt(s / HOP);
  }
  return out;
}

// 低・中・高の3つの帯域で「音が急に大きくなった所」を拾う
function onsetEnvelope(x) {
  const a1 = 1 - Math.exp(-2 * Math.PI * 200 / SR);
  const a2 = 1 - Math.exp(-2 * Math.PI * 2000 / SR);
  const n = Math.floor(x.length / HOP);
  const on = new Float32Array(n);
  let lo = 0, m = 0, prev = [0, 0, 0];
  for (let t = 0; t < n; t++) {
    let eLo = 0, eMid = 0, eHi = 0;
    for (let i = t * HOP, e = i + HOP; i < e; i++) {
      const v = x[i];
      lo += a1 * (v - lo);
      m += a2 * (v - m);
      const hi = v - m, mid = m - lo;
      eLo += lo * lo; eMid += mid * mid; eHi += hi * hi;
    }
    const c = [Math.log1p(1000 * eLo / HOP), Math.log1p(1000 * eMid / HOP), Math.log1p(1000 * eHi / HOP)];
    let s = 0;
    for (let b = 0; b < 3; b++) { const d = c[b] - prev[b]; if (d > 0) s += d; }
    on[t] = s;
    prev = c;
  }
  // ゆっくりした音量変化を引いて、打点だけを残す
  const w = 8, sm = new Float32Array(n);
  let acc = 0;
  for (let t = 0; t < n; t++) {
    acc += on[t];
    if (t >= 2 * w + 1) acc -= on[t - 2 * w - 1];
    const c = t - w;
    if (c >= 0) sm[c] = Math.max(0, on[c] - acc / (2 * w + 1));
  }
  return sm;
}

function combScore(on, period) {
  let best = -1, bestPhase = 0;
  for (let ph = 0; ph < period; ph += 1) {
    let s = 0;
    for (let p = ph; p < on.length; p += period) s += on[Math.round(p)] || 0;
    if (s > best) { best = s; bestPhase = ph; }
  }
  return { score: best, phase: bestPhase };
}

export function estimateTempo(on) {
  const n = on.length;
  const minLag = Math.floor(FPS * 60 / 200), maxLag = Math.ceil(FPS * 60 / 55);
  const ac = new Float32Array(maxLag * 4 + 2);
  for (let l = minLag; l < ac.length && l < n; l++) {
    let s = 0;
    for (let i = 0; i + l < n; i++) s += on[i] * on[i + l];
    ac[l] = s / (n - l);
  }
  let bestL = 0, bestS = -1;
  for (let l = minLag; l <= maxLag; l++) {
    const bpm = 60 * FPS / l;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 95) / 0.7) ** 2);
    const s = (ac[l] + 0.5 * ac[2 * l] + 0.25 * ac[4 * l]) * prior;
    if (s > bestS) { bestS = s; bestL = l; }
  }
  if (!bestL) return null;
  // 曲全体で一番ズレない周期に細かく合わせる
  let best = { score: -1 };
  for (let p = bestL - 0.6; p <= bestL + 0.6; p += 0.02) {
    const r = combScore(on, p);
    if (r.score > best.score) best = { ...r, period: p };
  }
  return { bpm: 60 * FPS / best.period, beat0: best.phase / FPS };
}

// 声の大きさから「声が入っている区間」と「入り」を求める
function voiceActivity(v) {
  const rms = frameRms(v);
  const n = rms.length;
  const w = 4, sm = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, t - w); k <= Math.min(n - 1, t + w); k++) { s += rms[k]; c++; }
    sm[t] = s / c;
  }
  const sorted = Array.from(sm).sort((a, b) => a - b);
  const hi = sorted[Math.floor(n * 0.98)] || 0;
  const lo = sorted[Math.floor(n * 0.1)] || 0;
  // ずっと声が続く曲（無音が無い）でも基準が上がりすぎないように上限を付ける
  const thr = Math.max(hi * 0.12, Math.min(lo * 3, hi * 0.3), 0.002);
  const act = new Uint8Array(n);
  for (let t = 0; t < n; t++) act[t] = sm[t] > thr ? 1 : 0;

  let entry = null;
  const win = Math.round(FPS);
  for (let t = 0; t < n - win; t++) {
    if (!act[t]) continue;
    let c = 0;
    for (let k = t; k < t + win; k++) c += act[k];
    if (c >= win * 0.5) {
      let s = t;
      while (s > 0 && t - s < FPS * 0.3 && sm[s - 1] > thr * 0.5) s--;
      entry = s / FPS;
      break;
    }
  }
  const step = FPS / VOICE_FPS;
  let voice = '';
  for (let p = 0; p < n; p += step) {
    let c = 0, k = 0;
    for (let i = Math.floor(p); i < Math.min(n, Math.floor(p + step)); i++) { c += act[i]; k++; }
    voice += k && c / k >= 0.5 ? '1' : '0';
  }
  return { entry, voice: hi > 0.003 ? voice : '', hasVoice: hi > 0.003 && entry !== null };
}

// 原曲とビートの時間のズレを探す（a[i] ≒ b[i + lag]）
function findLag(a, b) {
  const H = 32, R = 120;
  const len = Math.min(a.length, b.length);
  const start = Math.floor(len * 0.3), span = Math.min(SR * 20, len - start - R * H - 1);
  if (span < SR) return 0;
  const env = (x) => {
    const e = new Float32Array(Math.floor(len / H));
    for (let t = 0; t < e.length; t++) { let s = 0; for (let i = t * H; i < t * H + H; i++) s += Math.abs(x[i]); e[t] = s; }
    return e;
  };
  const ea = env(a), eb = env(b);
  const s0 = Math.floor(start / H), s1 = s0 + Math.floor(span / H);
  let bestC = -Infinity, coarse = 0;
  for (let l = -R; l <= R; l++) {
    let c = 0;
    for (let t = s0; t < s1; t++) c += ea[t] * (eb[t + l] || 0);
    if (c > bestC) { bestC = c; coarse = l * H; }
  }
  let bestF = -Infinity, lag = coarse;
  const fs = start, fe = Math.min(start + SR, len - Math.abs(coarse) - H - 1);
  for (let l = coarse - H; l <= coarse + H; l++) {
    let c = 0;
    for (let i = fs; i < fe; i++) c += a[i] * (b[i + l] || 0);
    if (c > bestF) { bestF = c; lag = l; }
  }
  return lag;
}

function subtractBeat(orig, beat) {
  const lag = findLag(orig, beat);
  let ab = 0, bb = 0;
  for (let i = 0; i < orig.length; i += 3) { const bv = beat[i + lag] || 0; ab += orig[i] * bv; bb += bv * bv; }
  const g = bb ? ab / bb : 1;
  const v = new Float32Array(orig.length);
  for (let i = 0; i < orig.length; i++) v[i] = orig[i] - g * (beat[i + lag] || 0);
  return v;
}

// song.layers の Blob を受け取って解析結果を返す
export async function analyzeSong(layers, getBlob, onStep = () => {}) {
  const res = { v: ANALYSIS_V, peaks: {}, duration: 0, bpm: null, beat0: 0, entry: null, voice: '' };
  const pcm = {};
  for (const l of layers) {
    onStep(`${l.name} を読み込み中`);
    try {
      pcm[l.id] = await decodeMono(await getBlob(l.id));
    } catch (e) {
      console.warn('decode failed', l.name, e);
      continue;
    }
    res.peaks[l.id] = peaks(pcm[l.id]);
    res.duration = Math.max(res.duration, pcm[l.id].length / SR);
    await pause();
  }
  const pick = (type) => layers.find((l) => l.type === type && pcm[l.id]);
  const beat = pick('beat'), orig = pick('orig'), vocal = pick('vocal');
  const parts = layers.filter((l) => l.type === 'part' && pcm[l.id]);

  onStep('テンポを測定中');
  let rhythm = beat && pcm[beat.id];
  if (!rhythm && parts.length) {
    rhythm = new Float32Array(Math.max(...parts.map((p) => pcm[p.id].length)));
    for (const p of parts) pcm[p.id].forEach((v, i) => { rhythm[i] += v; });
  }
  rhythm = rhythm || (orig && pcm[orig.id]) || (vocal && pcm[vocal.id]);
  if (rhythm) {
    const t = estimateTempo(onsetEnvelope(rhythm));
    if (t) { res.bpm = t.bpm; res.beat0 = t.beat0; }
  }
  await pause();

  onStep('入りを探し中');
  let voiceSig = vocal && pcm[vocal.id];
  if (!voiceSig && orig && beat) voiceSig = subtractBeat(pcm[orig.id], pcm[beat.id]);
  if (voiceSig) {
    const va = voiceActivity(voiceSig);
    res.entry = va.entry;
    res.voice = va.voice;
  }
  return res;
}

export const VOICE_STEP = 1 / VOICE_FPS;
