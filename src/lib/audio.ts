// Decode any recorded blob (WebM/Opus, MP4, WAV) to 16 kHz mono Float32 for Whisper.
export async function decodeTo16kMono(blob: Blob): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, 16000); // decodeAudioData resamples to 16 kHz
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  if (buf.numberOfChannels === 1) return buf.getChannelData(0);
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < out.length; i++) out[i] += d[i] / buf.numberOfChannels; }
  return out;
}
