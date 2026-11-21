// Runs Whisper in a worker so the UI stays responsive. Model downloads once, then is cached by the browser.
const MODEL = "Xenova/whisper-base.en"; // swap for whisper-tiny.en (faster) or a larger model (more accurate)
let asr: any = null;
let loading: Promise<any> | null = null;
let lastFetchIssue = "";

// Transformers.js otherwise surfaces only a generic "Load failed" in some browsers.
// Include the resource URL so a blocked model/WASM request can be diagnosed from the app.
const fetchFromHub = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    const response = await fetchFromHub(input, init);
    if (!response.ok) lastFetchIssue = `${response.status} ${response.statusText} — ${url}`;
    return response;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    lastFetchIssue = `Network/CORS request failed for ${url}: ${reason}`;
    throw new Error(lastFetchIssue);
  }
};

async function loadModel() {
  if (asr) return asr;
  if (!loading) {
    // Import after installing fetch diagnostics so Transformers.js requests use the wrapper.
    loading = (async () => {
      const { env, pipeline } = await import("@huggingface/transformers");
      // Route Hub file requests through this app's Cloudflare Worker. This avoids
      // browser CORS/network blocks on Hugging Face's redirected CDN hosts.
      env.remoteHost = self.location.origin;
      env.remotePathTemplate = "hf/{model}/resolve/{revision}/{file}";
      const model = await pipeline("automatic-speech-recognition", MODEL, {
        // Use the browser's local CPU/WASM backend for widest compatibility.
        device: "wasm",
        progress_callback: (p: any) => self.postMessage({ type: "progress", p }),
      });
      asr = model;
      self.postMessage({ type: "model-ready" });
      return model;
    })().catch((err: unknown) => {
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
    lastFetchIssue = "";
    try { await loadModel(); }
    catch (err) { self.postMessage({ type: "model-error", message: lastFetchIssue || String(err) }); }
    return;
  }
  if (e.data.type !== "transcribe" || !e.data.audio) return;
  try {
    lastFetchIssue = "";
    try { await loadModel(); }
    catch (err) { self.postMessage({ type: "model-error", message: lastFetchIssue || String(err) }); throw err; }
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
