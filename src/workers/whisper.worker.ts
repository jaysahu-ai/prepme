// Runs Whisper in a worker so the UI stays responsive. Model downloads once, then is cached by the browser.
import { pipeline } from "@huggingface/transformers";
const MODEL = "Xenova/whisper-base.en"; // swap for whisper-tiny.en (faster) or a larger model (more accurate)
let asr: any = null;
let loading: Promise<any> | null = null;

async function loadModel() {
  if (asr) return asr;
  if (!loading) {
    loading = pipeline("automatic-speech-recognition", MODEL, {
      device: "gpu" in navigator ? "webgpu" : "wasm",
      progress_callback: (p: any) => self.postMessage({ type: "progress", p }),
    }).then((model: any) => {
      asr = model;
      self.postMessage({ type: "model-ready" });
      return model;
    }).catch((err: unknown) => {
      loading = null; // Allow the user to retry after a network or runtime failure.
      throw err;
    });
  }
  return loading;
}

const PROMPT = "Umm, let me think like, hmm... Okay, here's what I'm, like, thinking.";
const rms = (a: Float32Array) => { let e = 0, n = 0; for (let i = 0; i < a.length; i += 8) { e += a[i] * a[i]; n++; } return Math.sqrt(e / (n || 1)); };

// Second pass: Whisper is given a filler-heavy "previous text" so it keeps "um"/"uh" instead of cleaning them up.
// Transformers.js has no prompt_ids option, so the prompt tokens are passed as decoder_input_ids.
async function fillerPass(audio: Float32Array): Promise<string> {
  const { processor, tokenizer, model } = asr;
  const ids = tokenizer.encode(`<|startofprev|> ${PROMPT}<|startoftranscript|><|notimestamps|>`, { add_special_tokens: false });
  const promptText: string = tokenizer.decode(ids, { skip_special_tokens: true }).trim();
  const CH = 30 * 16000; // Whisper works on 30 s windows
  let out = "";
  for (let s = 0; s < audio.length; s += CH) {
    const chunk = audio.subarray(s, s + CH);
    if (rms(chunk) < 0.003) continue; // skip near-silence so the prompt can't be echoed back
    const { input_features } = await processor(chunk);
    const gen = await model.generate({ inputs: input_features, decoder_input_ids: [ids], max_new_tokens: 220 });
    const seq = typeof gen.tolist === "function" ? gen.tolist()[0] : gen[0];
    let text: string = tokenizer.decode(seq, { skip_special_tokens: true }).trim();
    if (text.startsWith(promptText)) text = text.slice(promptText.length).trim(); // drop the prompt if it was echoed in the output
    out += " " + text;
  }
  return out.trim();
}

self.onmessage = async (e: MessageEvent<{ type: "preload" | "retry" | "transcribe"; audio?: Float32Array; thorough?: boolean }>) => {
  if (e.data.type === "preload" || e.data.type === "retry") {
    try { await loadModel(); }
    catch (err) { self.postMessage({ type: "model-error", message: String(err) }); }
    return;
  }
  if (e.data.type !== "transcribe" || !e.data.audio) return;
  try {
    try { await loadModel(); }
    catch (err) { self.postMessage({ type: "model-error", message: String(err) }); throw err; }
    self.postMessage({ type: "status", status: "Transcribing…" });
    const out = await asr(e.data.audio, { return_timestamps: "word", chunk_length_s: 30, stride_length_s: 5 });
    const words = (out.chunks ?? []).map((c: any) => ({ text: c.text.trim(), start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] }));

    let fillerText: string | undefined;
    if (e.data.thorough) {
      self.postMessage({ type: "status", status: "Checking for filler words…" });
      try { fillerText = await fillerPass(e.data.audio); console.log("Filler pass transcript:", fillerText); }
      catch (err) { console.warn("Filler pass failed, using the normal transcript only:", err); }
    }
    self.postMessage({ type: "done", text: out.text, words, fillerText });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err) });
  }
};
