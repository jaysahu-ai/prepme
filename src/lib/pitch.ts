// Pitch and volume variation from raw 16 kHz mono audio. No dependencies.
export interface PitchStats {
  avgHz: number; stdSemitones: number; rangeSemitones: number;
  volumeVarDb: number; voicedRatio: number;
}
const std = (a: number[]) => {
  const m = a.reduce((x, y) => x + y, 0) / (a.length || 1);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length || 1));
};
const pct = (s: number[], p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];

export function pitchStats(x: Float32Array, sr = 16000): PitchStats {
  const W = Math.round(sr * 0.05), hop = Math.round(sr * 0.02);
  const minLag = Math.floor(sr / 400), maxLag = Math.ceil(sr / 75);
  const starts: number[] = [], rms: number[] = [];
  for (let s = 0; s + W + maxLag + 1 < x.length; s += hop) {
    let e = 0; for (let i = 0; i < W; i++) e += x[s + i] ** 2;
    starts.push(s); rms.push(Math.sqrt(e / W));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const gate = Math.max(0.005, 0.1 * (sorted[Math.floor(sorted.length * 0.9)] ?? 0));

  let f0: number[] = [];
  const db: number[] = [];
  const nsdf = new Float32Array(maxLag + 2);
  starts.forEach((s, f) => {
    if (rms[f] < gate) return;
    let max = 0;
    for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
      let num = 0, den = 0;
      for (let i = 0; i < W; i++) { const a = x[s + i], b = x[s + i + lag]; num += a * b; den += a * a + b * b; }
      nsdf[lag] = den ? (2 * num) / den : 0;
      if (lag >= minLag && lag <= maxLag && nsdf[lag] > max) max = nsdf[lag];
    }
    if (max < 0.6) return; // unvoiced or noisy
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (nsdf[lag] >= 0.9 * max && nsdf[lag] >= nsdf[lag - 1] && nsdf[lag] >= nsdf[lag + 1]) {
        const a = nsdf[lag - 1], b = nsdf[lag], c = nsdf[lag + 1];
        const d = a - 2 * b + c;
        f0.push(sr / (lag + (d ? (0.5 * (a - c)) / d : 0)));
        db.push(20 * Math.log10(rms[f]));
        break;
      }
    }
  });
  // 3-point median filter removes single-frame jumps (octave errors)
  f0 = f0.map((v, i) => (i && i < f0.length - 1 ? [f0[i - 1], v, f0[i + 1]].sort((p, q) => p - q)[1] : v));
  if (f0.length < 10) return { avgHz: 0, stdSemitones: 0, rangeSemitones: 0, volumeVarDb: 0, voicedRatio: 0 };

  const med = [...f0].sort((a, b) => a - b)[Math.floor(f0.length / 2)];
  const st = f0.map(f => 12 * Math.log2(f / med)).sort((a, b) => a - b);
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    avgHz: Math.round(f0.reduce((a, b) => a + b, 0) / f0.length),
    stdSemitones: r(std(st)),
    rangeSemitones: r(pct(st, 0.95) - pct(st, 0.05)),
    volumeVarDb: r(std(db)),
    voicedRatio: r(f0.length / (starts.length || 1)),
  };
}
