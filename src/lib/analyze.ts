// Deterministic analytics engine. Pure functions, no AI, no network.
import type { PitchStats } from "./pitch";

export interface Word { text: string; start: number; end: number }
export interface Metrics {
  totalWords: number; durationSec: number; speakingSec: number;
  wpmOverall: number; wpmSpeaking: number;
  fillerCount: number; fillerPerMin: number; fillerBreakdown: Record<string, number>;
  repeatedWords: number; repeatedPhrases: { phrase: string; count: number }[];
  vocabDiversity: number; avgSentenceLen: number; longSentences: number;
  pauseCount: number; avgPauseSec: number; paceVariation: number;
  pitch?: PitchStats; // absent on sessions recorded before pitch analysis was added
}
export const DEFAULT_FILLERS = ["um", "uh", "er", "ah", "hmm", "you know", "i mean", "sort of", "kind of", "basically", "literally", "actually"];
export const PAUSE_MIN_SEC = 0.6;
export const LONG_SENTENCE_WORDS = 30;

const tokenize = (s: string) => s.toLowerCase().replace(/[^a-z0-9'\s]/g, " ").split(/\s+/).filter(Boolean);
const round = (n: number, d = 2) => Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : 0;

// Collapse stretched fillers ("ummm", "uhhh", "errr", "hmmm") to their base form.
const normFiller = (t: string) =>
  /^u+m+$/.test(t) ? "um" : /^u+h+$/.test(t) ? "uh" :
  /^(e+r+m*|e+r+h+)$/.test(t) ? "er" : /^a+h+$/.test(t) ? "ah" :
  /^h+m+$/.test(t) ? "hmm" : t;

export function analyze(text: string, words: Word[], durationSec: number, fillers = DEFAULT_FILLERS, fillerText?: string): Metrics {
  const tokens = tokenize(text);
  const total = tokens.length;
  const minutes = Math.max(durationSec / 60, 1 / 60);

  // Filler words (supports multi-word phrases, longest first). The optional fillerText comes from a
  // verbatim-prompted second pass; per filler we keep the higher count, since each pass can miss some.
  const phrases = fillers.map(f => f.toLowerCase().split(" ")).sort((a, b) => b.length - a.length);
  const countFillers = (toks: string[]) => {
    const ft = toks.map(normFiller); const b: Record<string, number> = {};
    for (let i = 0; i < ft.length; i++) {
      const hit = phrases.find(p => p.every((w, k) => ft[i + k] === w));
      if (hit) { const key = hit.join(" "); b[key] = (b[key] ?? 0) + 1; i += hit.length - 1; }
    }
    return b;
  };
  const breakdown = countFillers(tokens);
  if (fillerText) for (const [k, v] of Object.entries(countFillers(tokenize(fillerText)))) breakdown[k] = Math.max(breakdown[k] ?? 0, v);
  const fillerCount = Object.values(breakdown).reduce((a, b) => a + b, 0);

  // Immediate word repeats ("the the") and repeated 3-word phrases
  let repeatedWords = 0;
  for (let i = 1; i < tokens.length; i++) if (tokens[i] === tokens[i - 1]) repeatedWords++;
  const grams = new Map<string, number>();
  for (let i = 0; i + 3 <= tokens.length; i++) { const g = tokens.slice(i, i + 3).join(" "); grams.set(g, (grams.get(g) ?? 0) + 1); }
  const repeatedPhrases = [...grams].filter(([, c]) => c >= 2).map(([phrase, count]) => ({ phrase, count })).sort((a, b) => b.count - a.count).slice(0, 10);

  // Sentences
  const sentences = text.split(/[.!?]+/).map(tokenize).filter(s => s.length > 0);
  const avgSentenceLen = sentences.length ? total / sentences.length : 0;
  const longSentences = sentences.filter(s => s.length > LONG_SENTENCE_WORDS).length;

  // Pauses and pace from word timestamps
  let pauseCount = 0, pauseTotal = 0;
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap >= PAUSE_MIN_SEC) { pauseCount++; pauseTotal += gap; }
  }
  const speakingSec = words.length ? Math.max(durationSec - pauseTotal, 1) : durationSec;

  // Pace variation: std dev of WPM across 10s windows
  const WIN = 10; const counts: number[] = [];
  for (let t = 0; t < durationSec; t += WIN) counts.push(words.filter(w => w.start >= t && w.start < t + WIN).length * (60 / WIN));
  const mean = counts.reduce((a, b) => a + b, 0) / (counts.length || 1);
  const paceVariation = Math.sqrt(counts.reduce((a, b) => a + (b - mean) ** 2, 0) / (counts.length || 1));

  return {
    totalWords: total, durationSec: round(durationSec, 1), speakingSec: round(speakingSec, 1),
    wpmOverall: round(total / minutes, 0), wpmSpeaking: round(total / (speakingSec / 60), 0),
    fillerCount, fillerPerMin: round(fillerCount / minutes), fillerBreakdown: breakdown,
    repeatedWords, repeatedPhrases,
    vocabDiversity: round(total ? new Set(tokens).size / total : 0, 3),
    avgSentenceLen: round(avgSentenceLen, 1), longSentences,
    pauseCount, avgPauseSec: round(pauseCount ? pauseTotal / pauseCount : 0),
    paceVariation: round(paceVariation, 0),
  };
}
