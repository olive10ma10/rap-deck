// レコード1枚ぶんの再生エンジン。
// 再生位置を「速さ」で動かすので、普通の再生もスクラッチ（逆回転・停止）も同じ仕組みで鳴らせる。
class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.layers = [];      // { id, L, R, gain, target }
    this.length = 0;
    this.pos = 0;          // サンプル位置（小数あり）
    this.rate = 0;         // 今の速さ（1 = 普通、負 = 逆回転）
    this.motor = 0;        // モーターが目指す速さ（再生中 1 / 停止 0）
    this.scratching = false;
    this.handRate = 0;     // 指が動かしている速さ
    this.fader = 1;        // カット（クロスフェーダー）
    this.faderTarget = 1;
    this.loop = null;      // { start, end }
    this.tick = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'load':
        this.layers = m.layers.map((l) => ({ id: l.id, L: l.L, R: l.R || l.L, gain: l.on ? 1 : 0, target: l.on ? 1 : 0 }));
        this.length = m.length;
        this.pos = 0; this.rate = 0; this.motor = 0; this.loop = null;
        break;
      case 'gain': {
        const l = this.layers.find((x) => x.id === m.id);
        if (l) l.target = m.value;
        break;
      }
      case 'play': this.motor = 1; if (m.instant) this.rate = 1; break;
      case 'pause': this.motor = 0; break;
      case 'seek': this.pos = Math.max(0, Math.min(this.length - 1, m.pos)); break;
      case 'scratch': this.scratching = m.on; this.handRate = 0; break;
      case 'hand': this.handRate = m.rate; break;
      case 'fader': this.faderTarget = m.open ? 1 : 0; break;
      case 'loop': this.loop = m.loop; break;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    const n = oL.length;
    const len = this.length;
    if (!len) { oL.fill(0); if (oR !== oL) oR.fill(0); return true; }

    // 指で触っている時は速く追従、離したらモーターでゆっくり戻る
    const target = this.scratching ? this.handRate : this.motor;
    const k = this.scratching ? 0.002 : (this.motor ? 0.0005 : 0.002);
    const layers = this.layers;

    for (let i = 0; i < n; i++) {
      this.rate += (target - this.rate) * k;
      this.fader += (this.faderTarget - this.fader) * 0.01;

      let p = this.pos;
      const i0 = p | 0;
      const f = p - i0;
      const i1 = i0 + 1 < len ? i0 + 1 : i0;
      let sL = 0, sR = 0;
      for (let j = 0; j < layers.length; j++) {
        const l = layers[j];
        l.gain += (l.target - l.gain) * 0.003;
        if (l.gain < 0.0005 && l.target === 0) continue;
        sL += (l.L[i0] + (l.L[i1] - l.L[i0]) * f) * l.gain;
        sR += (l.R[i0] + (l.R[i1] - l.R[i0]) * f) * l.gain;
      }
      // 速さがほぼ0の時は音を絞って「プツッ」というノイズを防ぐ
      const a = Math.abs(this.rate);
      const g = (a < 0.05 ? a / 0.05 : 1) * this.fader;
      oL[i] = sL * g;
      oR[i] = sR * g;

      p += this.rate;
      if (this.loop && this.rate > 0 && p >= this.loop.end) p = this.loop.start + (p - this.loop.end);
      if (p < 0) p = 0;
      if (p >= len - 1) {
        p = len - 1;
        if (!this.scratching && this.motor) { this.motor = 0; this.rate = 0; this.port.postMessage({ type: 'ended' }); }
      }
      this.pos = p;
    }

    if (++this.tick % 3 === 0) this.port.postMessage({ type: 'pos', pos: this.pos, rate: this.rate });
    return true;
  }
}

registerProcessor('deck', DeckProcessor);
