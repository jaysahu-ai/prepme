import { useEffect, useRef, useState } from "react";
import { analyze, type Metrics, type Word } from "./lib/analyze";
import { decodeTo16kMono } from "./lib/audio";
import { pitchStats } from "./lib/pitch";
import { deleteAllSessions, deleteSession, listSessions, saveSession, type Session } from "./lib/db";

// Targets used for labels and for judging "better / worse". Edit to taste.
const PACE_RANGE: [number, number] = [110, 160]; // words per minute
const PITCH_FLAT = 2, PITCH_VARIED = 3.5;        // pitch variation in semitones (rough guide)

type Phase = "idle" | "recording" | "processing";
type View = "sessions" | "progress";
type Dir = "down" | "up" | "range"; // which direction counts as improvement
type ModelState = "loading" | "ready" | "error";

const r2 = (n: number) => Math.round(n * 100) / 100;
const fmtDuration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const repeatsPerMin = (m: Metrics) =>
  r2((m.repeatedWords + m.repeatedPhrases.reduce((a, p) => a + p.count, 0)) / Math.max(m.durationSec / 60, 1 / 60));
const paceLabel = (w: number) => (w < PACE_RANGE[0] ? "A little slow" : w > PACE_RANGE[1] ? "A little fast" : "On target");
const pitchLabel = (st: number) => (st < PITCH_FLAT ? "Leaning monotone" : st < PITCH_VARIED ? "Moderate variation" : "Varied");

function verdict(dir: Dir, from: number, to: number) {
  const dist = (v: number) => dir === "range" ? Math.max(PACE_RANGE[0] - v, v - PACE_RANGE[1], 0) : dir === "down" ? v : -v;
  const diff = dist(to) - dist(from);
  return Math.abs(diff) < 0.02 * (Math.abs(from) || 1) ? "No change" : diff < 0 ? "Better" : "Worse";
}

const iconProps = { viewBox: "0 0 24 24", width: 18, height: 18, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
const Sun = () => <svg {...iconProps}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
const Moon = () => <svg {...iconProps}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>;
const Lock = () => <svg {...iconProps} width={14} height={14}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;
const Trash = () => <svg {...iconProps} width={17} height={17}><path d="M3 6h18M8 6V4h8v2m3 0-.8 14H5.8L5 6m4 4v6m6-6v6" /></svg>;
const Mic = () => <svg {...iconProps} width={20} height={20}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4m-4 0h8" /></svg>;
const PrepMeMark = () => <svg className="app-mark" viewBox="0 0 64 64" fill="none" aria-hidden="true">
  <rect x="2" y="2" width="60" height="60" rx="18" fill="color-mix(in srgb, var(--accent) 10%, var(--card))" />
  <g stroke="var(--accent)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4">
    <rect x="16" y="12" width="16" height="29" rx="8" fill="none" />
    <path d="M10 29v2a14 14 0 0 0 28 0v-2M24 45v7m-8 0h16M46 24v13m6-18v23" />
  </g>
</svg>;

export default function App() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("");
  const [modelState, setModelState] = useState<ModelState>("loading");
  const [modelProgress, setModelProgress] = useState<number | null>(null);
  const [modelError, setModelError] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [open, setOpen] = useState<Session | null>(null);
  const [view, setView] = useState<View>("sessions");
  const [secs, setSecs] = useState(0);
  const [about, setAbout] = useState(false);
  const [aboutFocus, setAboutFocus] = useState<"top" | "privacy">("top");
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try { const t = localStorage.getItem("theme"); if (t === "light" || t === "dark") return t; } catch { /* storage unavailable */ }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => { document.title = "PrepMe — Practice speaking with purpose"; }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("theme", theme); } catch { /* storage unavailable */ }
  }, [theme]);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<number>();
  const worker = useRef<Worker>();
  const pendingTranscription = useRef<{ resolve: (value: { text: string; words: Word[]; fillerText?: string }) => void; reject: (reason: Error) => void } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const meter = useRef<{ ctx: AudioContext; raf: number } | null>(null);
  const [speaking, setSpeaking] = useState(false);

  const refresh = async () => setSessions(await listSessions());
  useEffect(() => { refresh(); }, []);

  // Prepare the speech model after the page appears so loading problems are visible before recording.
  useEffect(() => {
    const w = new Worker(new URL("./workers/whisper.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    w.onmessage = e => {
      const m = e.data;
      if (m.type === "progress" && m.p.status === "progress") {
        setModelProgress(Math.round(m.p.progress));
      } else if (m.type === "model-ready") {
        setModelState("ready"); setModelProgress(100); setModelError("");
      } else if (m.type === "model-error") {
        setModelState("error"); setModelError(m.message); setModelProgress(null);
      } else if (m.type === "status") setStatus(m.status);
      else if (m.type === "done") {
        pendingTranscription.current?.resolve(m);
        pendingTranscription.current = null;
      } else if (m.type === "error") {
        const error = new Error(m.message);
        pendingTranscription.current?.reject(error);
        pendingTranscription.current = null;
      }
    };
    w.onerror = e => {
      console.error("Worker error:", e);
      const error = new Error("The speech model worker failed to load.");
      setModelState("error"); setModelError(error.message);
      pendingTranscription.current?.reject(error); pendingTranscription.current = null;
    };
    w.postMessage({ type: "preload" });
    return () => { w.terminate(); worker.current = undefined; };
  }, []);

  function retryModel() {
    setModelState("loading"); setModelProgress(null); setModelError("");
    worker.current?.postMessage({ type: "retry" });
  }

  // Scrolling live waveform: one new bar every STEP_MS slides in from the right and moves left.
  // Drawn straight to a canvas, so the page does not re-render on every frame.
  function startMeter(stream: MediaStream) {
    try {
      const ctx = new AudioContext(); ctx.resume();
      const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const BARS = 40, STEP_MS = 90;
      const levels: number[] = new Array(BARS + 1).fill(0);
      let level = 0, peak = 0, on = false, last = performance.now();
      meter.current = { ctx, raf: 0 };
      const tick = (now: number) => {
        analyser.getFloatTimeDomainData(buf);
        let e = 0; for (let i = 0; i < buf.length; i++) e += buf[i] * buf[i];
        const db = 20 * Math.log10(Math.sqrt(e / buf.length) + 1e-6);
        const target = Math.min(1, Math.max(0, (db + 60) / 50)); // -60 dB .. -10 dB
        level = target > level ? target : level * 0.85 + target * 0.15; // fast attack, slow release
        peak = Math.max(peak, level);
        if (now - last > 1000) last = now; // tab was in the background
        while (now - last >= STEP_MS) { levels.push(peak); levels.shift(); peak = level; last += STEP_MS; }
        const frac = (now - last) / STEP_MS;

        const cv = canvasRef.current;
        if (cv) {
          const dpr = window.devicePixelRatio || 1;
          const w = cv.clientWidth, h = cv.clientHeight;
          if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
          const g = cv.getContext("2d")!;
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          g.clearRect(0, 0, w, h);
          g.fillStyle = getComputedStyle(cv).getPropertyValue("--meter").trim() || "#16a34a";
          const sp = w / BARS, bw = Math.max(3, sp * 0.5);
          levels.forEach((lv, i) => {
            const x = i * sp - frac * sp + (sp - bw) / 2;
            const bh = Math.max(bw, lv * h); // silence shows as small dots, speech as tall bars
            g.beginPath();
            if (typeof g.roundRect === "function") g.roundRect(x, (h - bh) / 2, bw, bh, bw / 2); else g.rect(x, (h - bh) / 2, bw, bh);
            g.fill();
          });
        }

        const now30 = level > 0.3;
        if (now30 !== on) { on = now30; setSpeaking(now30); }
        if (meter.current) meter.current.raf = requestAnimationFrame(tick);
      };
      meter.current.raf = requestAnimationFrame(tick);
    } catch { /* the meter is optional; recording still works */ }
  }
  function stopMeter() {
    if (meter.current) { cancelAnimationFrame(meter.current.raf); meter.current.ctx.close(); meter.current = null; }
    setSpeaking(false);
  }

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks.current = [];
      startMeter(stream);
      const r = new MediaRecorder(stream);
      r.ondataavailable = e => e.data.size && chunks.current.push(e.data);
      r.onstop = () => { stopMeter(); stream.getTracks().forEach(t => t.stop()); process(new Blob(chunks.current, { type: r.mimeType })); };
      r.start(1000); rec.current = r; setPhase("recording"); setSecs(0);
      timer.current = window.setInterval(() => setSecs(s => s + 1), 1000);
    } catch { setStatus("Microphone access was blocked. Allow it in your browser's site settings and try again."); }
  }

  function stop() { clearInterval(timer.current); rec.current?.stop(); setPhase("processing"); }

  async function process(blob: Blob) {
    try {
      setStatus("Preparing audio…");
      const audio = await decodeTo16kMono(blob);
      const duration = audio.length / 16000;
      const w = worker.current;
      if (!w) throw new Error("Speech model worker is unavailable. Refresh the page and try again.");
      const result = await new Promise<{ text: string; words: Word[]; fillerText?: string }>((resolve, reject) => {
        pendingTranscription.current = { resolve, reject };
        w.postMessage({ type: "transcribe", audio, thorough: true });
      });
      setStatus("Analyzing voice…");
      const metrics: Metrics = { ...analyze(result.text, result.words, duration, undefined, result.fillerText), pitch: pitchStats(audio) };
      const s: Session = { id: crypto.randomUUID(), title: new Date().toLocaleString(), createdAt: Date.now(), audio: blob, text: result.text, words: result.words, metrics };
      await saveSession(s); await refresh(); setOpen(s); setStatus("");
    } catch (err) {
      console.error("Processing error:", err);
      setStatus(`Processing failed: ${String(err)}. Your recording was not saved.`);
    }
    setPhase("idle");
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  const busy = phase !== "idle";
  return (
    <main className={view === "sessions" && !about && !open ? "home-layout" : undefined}>
      <div className="home-fixed">
      <p className="privacy"><Lock /> Recordings stay on this device</p>
      <header>
        <div className="brand">
          <div className="brand-title"><PrepMeMark /><h1>PrepMe</h1></div>
          <p className="tagline">Practice speaking with purpose.</p>
        </div>
        <button className="theme" role="switch" aria-checked={theme === "dark"} aria-label="Dark mode"
          onClick={() => setTheme(t => (t === "dark" ? "light" : "dark"))}>
          <span className={theme === "light" ? "on" : ""}><Sun /></span>
          <span className={theme === "dark" ? "on" : ""}><Moon /></span>
        </button>
      </header>
      {status && <p className="status" role="status">{status}</p>}
      </div>

      {about ? <About onClose={() => setAbout(false)} onDeleted={() => setSessions([])} focus={aboutFocus} /> : open ? <Report s={open} onClose={() => setOpen(null)} /> : (
        <>
          <nav className="tabs">
            <button className="tab" disabled={busy} aria-current={view === "sessions" ? "page" : undefined} onClick={() => setView("sessions")}>Home</button>
            <button className="tab" disabled={busy} aria-current={view === "progress" ? "page" : undefined} onClick={() => setView("progress")}>Progress</button>
          </nav>

          {view === "progress" ? <Progress sessions={sessions} /> : (
            <>
              <div className="home-fixed">
              <section className="recorder">
                <div className={`model-status ${modelState}`} role="status" aria-live="polite">
                  {modelState === "loading" && <span>Preparing speech model{modelProgress !== null ? `… ${modelProgress}%` : "…"} <span className="muted">(first visit may take a few minutes)</span></span>}
                  {modelState === "ready" && <span>Speech model ready</span>}
                  {modelState === "error" && <span>Couldn’t prepare the speech model. Check your connection and retry. <button className="link model-retry" onClick={retryModel} disabled={busy}>Retry</button>{modelError && <small className="model-error-detail">{modelError}</small>}</span>}
                </div>
                {phase === "recording" ? (
                  <button className="recbtn live" onClick={stop} aria-label="Stop recording"><span className="sq" />Stop <span className="time">{fmt(secs)}</span></button>
                ) : (
                  <button className="recbtn" onClick={start} disabled={busy || modelState !== "ready"}><Mic />Start Speaking</button>
                )}
                {phase === "recording" && (
                  <div className="meter">
                    <canvas ref={canvasRef} className="meter-wave" role="img" aria-label="Live microphone level" />
                    <p className={speaking ? "meter-label on" : "meter-label"} role="status">{speaking ? "Speaking" : "Listening…"}</p>
                  </div>
                )}
                {phase === "processing" && <p className="muted">Working…</p>}
              </section>
              </div>

              <section className="sessions-scroll">
                <h2>Past sessions</h2>
                {sessions.length === 0 && <p className="muted">No sessions yet. Record a minute of speaking to see your first report.</p>}
                <ul className="list">
                  {sessions.map(s => (
                    <li key={s.id} className="item">
                      <button className="link title" disabled={busy} onClick={() => setOpen(s)}>{s.title}</button>
                      <button className="link danger delete-button" aria-label={`Delete session from ${s.title}`} title="Delete session" disabled={busy} onClick={async () => { if (window.confirm("Delete this session and its recording?")) { await deleteSession(s.id); refresh(); } }}><Trash /></button>
                      <dl className="mini">
                        <div><dt>Duration</dt><dd>{fmtDuration(s.metrics.speakingSec)}</dd></div>
                        <div><dt>Pace (wpm)</dt><dd>{s.metrics.wpmOverall}</dd></div>
                        <div><dt>Fillers/min</dt><dd>{s.metrics.fillerPerMin}</dd></div>
                        <div><dt>Pitch var (st)</dt><dd>{s.metrics.pitch ? s.metrics.pitch.stdSemitones : "–"}</dd></div>
                      </dl>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </>
      )}
      <footer>
        <button className="link" disabled={busy} onClick={() => { setAboutFocus("top"); setAbout(true); }}>About</button>
        <button className="link" disabled={busy} onClick={() => { setAboutFocus("privacy"); setAbout(true); }}>Privacy</button>
        <a href="https://github.com/jaysahu-ai/prepme" target="_blank" rel="noopener noreferrer">GitHub</a>
      </footer>
    </main>
  );
}

function About({ onClose, onDeleted, focus }: { onClose: () => void; onDeleted: () => void; focus: "top" | "privacy" }) {
  const [deleted, setDeleted] = useState(false);
  const privacyRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus === "privacy") privacyRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focus]);
  return (
    <section className="about">
      <button className="link" onClick={onClose}>Back</button>
      <h2>About PrepMe</h2>
      <p>PrepMe helps you practice speaking out loud. Record yourself, get a report on pace, pitch, filler words, and repetitive language, and track how you improve from one session to the next.</p>
      <h3>How it works</h3>
      <p>A speech model runs in your browser to turn your voice into text, and the analysis happens on your device. PrepMe prepares the model in the background when you open the app; your browser may keep it cached for later visits.</p>
      <h3 ref={privacyRef} id="privacy-data">Privacy &amp; Data</h3>
      <ul>
        <li><strong>Recording and analysis:</strong> Your microphone audio is processed in this browser. PrepMe does not upload your recording for transcription or analysis.</li>
        <li><strong>Local storage:</strong> Saved recordings, transcripts, word timings, and session metrics are kept in this browser's IndexedDB. Your light or dark theme preference is stored in local storage. There is no PrepMe account, cloud database, backup, or device sync.</li>
        <li><strong>Speech model download:</strong> On your first visit, the app fetches public speech model files from Hugging Face through its Cloudflare Worker. The model may be cached by your browser. The Worker only handles model files; your recording and transcript stay in the browser and are not sent to it.</li>
        <li><strong>Microphone permission:</strong> Your browser asks for microphone access when you start speaking. You can revoke that permission in the browser's site settings.</li>
        <li><strong>Optional Copilot feedback:</strong> If you choose “Get feedback in Copilot,” PrepMe copies a prompt containing your transcript and session metrics to the clipboard and opens Microsoft Copilot. For short prompts, the prompt is included in the Copilot URL; opening that page sends it to Microsoft. Longer prompts are copied for you to paste into Copilot yourself.</li>
        <li><strong>Deleting data:</strong> “Delete all data” removes all saved sessions and their recordings, transcripts, and results from this browser. Clearing the browser's site data also removes PrepMe's local saved data.</li>
      </ul>
      <button className="ghost danger" onClick={async () => {
        if (!window.confirm("Delete all saved recordings, transcripts, and session results from this browser? This cannot be undone.")) return;
        await deleteAllSessions();
        onDeleted();
        setDeleted(true);
      }}>Delete all data</button>
      {deleted && <p className="muted" role="status">All saved sessions and their recordings, transcripts, and results have been deleted.</p>}
      <h3>Good to know</h3>
      <ul>
        <li>English only for now.</li>
        <li>Filler counts are best effort and can undercount, because speech models often leave "um" and "uh" out.</li>
        <li>Pitch and pace labels are rough guides, not a verdict on how you sound.</li>
        <li>Very short recordings give unreliable per-minute numbers.</li>
      </ul>
      <p><a href="https://github.com/jaysahu-ai" target="_blank" rel="noopener noreferrer">View the project on GitHub</a></p>
    </section>
  );
}

function Line({ values, band, label }: { values: number[]; band?: [number, number]; label: string }) {
  if (values.length < 2) return <p className="muted">Not enough data for a chart yet.</p>;
  const W = 300, H = 50, P = 6;
  const all = [...values, ...(band ?? [])];
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
  const x = (i: number) => P + (i * (W - 2 * P)) / (values.length - 1);
  const y = (v: number) => H - P - ((v - lo) / span) * (H - 2 * P);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={label}>
      {band && <rect x="0" y={y(band[1])} width={W} height={y(band[0]) - y(band[1])} className="band" />}
      <polyline fill="none" className="line" points={values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
      {values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r="3" className="dot" />)}
    </svg>
  );
}

function TrendCard({ title, dir, values, band, definition, guide, source }: { title: string; dir: Dir; values: number[]; band?: [number, number]; definition: string; guide: string; source?: { label: string; href: string } }) {
  const cur = values[values.length - 1], prev = values[values.length - 2], first = values[0];
  const sign = (d: number) => (d > 0 ? "+" : "") + r2(d);
  return (
    <div className="block">
      <MetricTitle title={title} definition={definition} guide={guide} source={source} />
      {values.length < 2 ? <p className="muted">Needs at least two sessions with this data.</p> : (<>
        <p className="big">{cur}</p>
        <p><strong>{verdict(dir, prev, cur)}</strong> vs last session ({sign(cur - prev)}) · <strong>{verdict(dir, first, cur)}</strong> vs your first ({sign(cur - first)})</p>
        <Line values={values} band={band} label={`${title} across sessions, oldest to newest`} />
      </>)}
    </div>
  );
}

function Progress({ sessions }: { sessions: Session[] }) {
  const old = [...sessions].reverse(); // oldest first
  if (sessions.length < 2) return <section><p className="muted">Record at least two sessions to see how you're improving.</p></section>;
  const cards: { title: string; dir: Dir; values: number[]; band?: [number, number]; definition: string; guide: string; source?: { label: string; href: string } }[] = [
    { title: "Pace (words per minute)", dir: "range", values: old.map(s => s.metrics.wpmOverall), band: PACE_RANGE,
      definition: "The average number of recognized words spoken per minute across the recording.",
      guide: `PrepMe uses ${PACE_RANGE[0]}–${PACE_RANGE[1]} words per minute as a rough practice range. A good pace depends on your audience and material.`,
      source: { label: "Stanford Oral Communication Program", href: "https://oralcommprogram.stanford.edu/presentation-and-delivery/delivery" } },
    { title: "Filler words per minute", dir: "down", values: old.map(s => s.metrics.fillerPerMin),
      definition: "Words and phrases such as “um,” “uh,” or “you know” detected in the transcript, divided by the recording length in minutes.",
      guide: "There is no universal ideal and fillers can be useful in conversation. For presentations, notice repeated habits rather than aiming for zero.",
      source: { label: "James Madison University speech guide", href: "https://pressbooks.lib.jmu.edu/communicationintherealworldjmu/chapter/delivering-a-speech/" } },
    { title: "Pitch variation (semitones)", dir: "up", values: old.filter(s => s.metrics.pitch).map(s => s.metrics.pitch!.stdSemitones),
      definition: "How much your voice's pitch changes during voiced speech, shown as standard deviation in semitones.",
      guide: "There is no universal ideal. PrepMe's rough labels are under 2 st: low variation, 2–3.5 st: moderate, and 3.5 st or more: higher variation. Natural variation depends on your voice and speaking style.",
      source: { label: "University of Tennessee Vocal Delivery guide", href: "https://cci.utk.edu/tops/resources-for-students/delivery-skills/vocal-delivery/" } },
    { title: "Repetitive language per minute", dir: "down", values: old.map(s => repeatsPerMin(s.metrics)),
      definition: "The rate of immediately repeated words and repeated three-word phrases detected in the transcript.",
      guide: "There is no standard target. Some repetition is natural; use the examples to spot patterns that distract from your message." },
  ];
  return <section className="grid2">{cards.map(c => <TrendCard key={c.title} {...c} />)}</section>;
}

// Copilot has no official "attach data" link. Its ?q= link can prefill the chat box but is undocumented and
// length-limited, so we always copy the full prompt to the clipboard too and add ?q= only when it is short.
function buildCopilotPrompt(s: Session) {
  const m = s.metrics;
  return `You are a speaking coach. Below is the transcript of my practice speaking session (about ${Math.max(1, Math.round(m.durationSec / 60))} min, ${m.wpmOverall} words per minute, ${m.fillerCount} filler words). Give me feedback on clarity, structure, conciseness, and professional tone. List 3 strengths and 3 areas to improve with examples from the transcript, suggest better wording for weak sentences, and recommend one practice exercise.\n\nTranscript:\n${s.text}`;
}
async function askCopilot(s: Session, setNote: (t: string) => void) {
  const prompt = buildCopilotPrompt(s);
  const copying = navigator.clipboard?.writeText(prompt); // start the copy inside the click, before anything async
  const q = encodeURIComponent(prompt);
  window.open("https://copilot.microsoft.com/" + (q.length <= 1800 ? `?q=${q}` : ""), "_blank", "noopener,noreferrer");
  const ok = await Promise.resolve(copying).then(() => true, () => false);
  setNote(ok ? "Copied to your clipboard. If the Copilot box is empty, paste it with Cmd+V (Ctrl+V on Windows)." : "Couldn't copy automatically. Open the transcript below, copy it, and paste it into Copilot.");
}

function downloadTranscript(s: Session) {
  const blob = new Blob([s.text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `speech-coach-transcript-${new Date(s.createdAt).toISOString().slice(0, 10)}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function MetricTitle({ title, definition, guide, source }: { title: string; definition: string; guide: string; source?: { label: string; href: string } }) {
  const helpRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!helpRef.current?.contains(event.target as Node)) helpRef.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, []);

  return (
    <h3 className="metric-heading">
      <span>{title}</span>
      <details ref={helpRef} className="metric-help">
        <summary aria-label={`About ${title}`} title={`About ${title}`}>?</summary>
        <div className="metric-popover" role="note">
          <p>{definition}</p>
          <p><strong>Guide:</strong> {guide}</p>
          {source && <a href={source.href} target="_blank" rel="noopener noreferrer">Learn more at {source.label} ↗</a>}
        </div>
      </details>
    </h3>
  );
}

function Report({ s, onClose }: { s: Session; onClose: () => void }) {
  const m: Metrics = s.metrics;
  const [note, setNote] = useState("");
  const url = useRef(URL.createObjectURL(s.audio)).current;
  const WIN = 15, pace: number[] = [];
  for (let t = 0; t < m.durationSec; t += WIN) {
    const len = Math.min(WIN, m.durationSec - t);
    if (len >= 5) pace.push(Math.round((s.words.filter(w => w.start >= t && w.start < t + WIN).length * 60) / len));
  }
  const fillers = Object.entries(m.fillerBreakdown).sort((a, b) => b[1] - a[1]);
  const p = m.pitch && m.pitch.avgHz > 0 ? m.pitch : null;
  const mins = Math.floor(m.durationSec / 60), secs = Math.round(m.durationSec % 60);
  return (
    <section>
      <button className="link" onClick={onClose}>Back to sessions</button>
      <h2>Rehearsal report</h2>
      <audio controls src={url} />

      <div className="grid2">
      <div className="block"><MetricTitle title="Duration" definition="The total length of this recording, including pauses." guide="Choose a length that fits your practice goal; there is no single ideal duration." /><p className="big">{mins}:{String(secs).padStart(2, "0")}</p><p className="muted">Elapsed time · {s.title}</p></div>

      <div className="block"><MetricTitle title="Pace" definition="The average number of recognized words spoken per minute across the recording." guide={`PrepMe uses ${PACE_RANGE[0]}–${PACE_RANGE[1]} words per minute as a rough practice range. A good pace depends on your audience and material.`} source={{ label: "Stanford Oral Communication Program", href: "https://oralcommprogram.stanford.edu/presentation-and-delivery/delivery" }} />
        <p className="big">{m.wpmOverall} <span className="unit">words per minute</span></p>
        <p>{paceLabel(m.wpmOverall)}. A comfortable range is {PACE_RANGE[0]}–{PACE_RANGE[1]}.</p>
        <Line values={pace} band={PACE_RANGE} label="Pace over time in 15 second windows; shaded band is the target range" />
      </div>

      <div className="block"><MetricTitle title="Pitch variation" definition="How much your voice's pitch changes during voiced speech, shown as standard deviation in semitones." guide="There is no universal ideal. This app's rough labels are under 2 st: low variation, 2–3.5 st: moderate, and 3.5 st or more: higher variation. Natural variation depends on your voice and speaking style." source={{ label: "University of Tennessee Vocal Delivery guide", href: "https://cci.utk.edu/tops/resources-for-students/delivery-skills/vocal-delivery/" }} />
        {p ? (<><p className="big">{p.stdSemitones} <span className="unit">semitones of variation</span></p>
          <p>{pitchLabel(p.stdSemitones)}. Average pitch {p.avgHz} Hz. This is a rough acoustic guide, not a verdict on how engaging you sound.</p></>)
          : <p className="muted">Not enough clear voiced speech to measure pitch in this session.</p>}
      </div>

      <div className="block"><MetricTitle title="Filler words" definition="Words and phrases such as “um,” “uh,” or “you know” detected in the transcript. The rate is counted per minute." guide="There is no universal ideal and fillers can be useful in conversation. For presentations, notice repeated habits rather than aiming for zero." source={{ label: "James Madison University speech guide", href: "https://pressbooks.lib.jmu.edu/communicationintherealworldjmu/chapter/delivering-a-speech/" }} />
        <p className="big">{m.fillerCount} <span className="unit">({m.fillerPerMin} per minute)</span></p>
        <p>{fillers.length ? fillers.map(([k, v]) => `${k} ×${v}`).join(", ") : "None detected."}</p>
      </div>

      <div className="block"><MetricTitle title="Repetitive language" definition="The rate of immediately repeated words and repeated three-word phrases detected in the transcript." guide="There is no standard target. Some repetition is natural; use the examples to spot patterns that distract from your message." />
        <p className="big">{repeatsPerMin(m)} <span className="unit">per minute</span></p>
        <p>{m.repeatedWords} immediately repeated words{m.repeatedPhrases.length ? ". Repeated phrases: " + m.repeatedPhrases.map(x => `"${x.phrase}" ×${x.count}`).join(", ") : ". No repeated phrases."}</p>
      </div>

      <div className="block">
          <details><summary>Transcript</summary><p className="transcript">{s.text}</p></details>
          <div className="actions">
            <button className="ghost" onClick={() => askCopilot(s, setNote)}>Get feedback in Copilot</button>
            <button className="ghost" onClick={async () => { try { await navigator.clipboard.writeText(s.text); setNote("Transcript copied."); } catch { setNote("Couldn't copy automatically. Open the transcript above and copy it by hand."); } }}>Copy transcript</button>
            <button className="ghost" onClick={() => downloadTranscript(s)}>Download as .txt</button>
          </div>
          {note && <p className="muted" role="status">{note}</p>}
          <p className="muted hint">Opens Microsoft Copilot in a new tab. Only your transcript text is sent, and only if you paste or submit it there. Your audio never leaves this device.</p>
        </div>
      </div>
    </section>
  );
}
