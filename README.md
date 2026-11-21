# PrepMe

**Practice speaking with purpose.**

PrepMe is a local-first speaking practice app. Record a rehearsal, review a transcript and speech metrics, and compare sessions over time. Audio transcription runs in the browser; session history is stored in the browser rather than a cloud database.

## Features

- Record speech from your microphone.
- Transcribe speech in the browser with Whisper (`Xenova/whisper-base.en`).
- Review pace, filler words, pitch variation, repetitive language, pauses, transcript, and recording.
- Track pace, filler, pitch, and repetition trends across sessions.
- Download a transcript as a `.txt` file.
- Keep sessions and recordings in browser IndexedDB; remove individual sessions or delete all saved sessions.
- Switch between light and dark themes.
- Optionally open Microsoft Copilot for feedback on a transcript.

## Run locally

You need Node.js and npm installed.

```bash
npm ci
npm run dev
```

Open the local URL printed by Vite. Microphone access requires `localhost` or an HTTPS connection. Chrome or Edge is recommended.

The first transcription downloads the speech model (about 80 MB); the browser caches it for later use. Transcription and metric calculations can take a little time, depending on your device.

## Build

```bash
npm run build
npm run preview
```

The production site is generated in `dist/`.

## Deploy to Cloudflare Pages

Connect this repository to Cloudflare Pages and use:

| Setting | Value |
| --- | --- |
| Framework preset | React (Vite) |
| Production branch | `main` |
| Root directory | Leave blank |
| Build command | `npm run build` |
| Build output directory | `dist` |

Pages serves the built front end. PrepMe does not require a running Node.js server or a backend database.

## Privacy and storage

- Microphone audio is processed in the browser. PrepMe does not upload recordings for transcription or analysis.
- Saved audio, transcripts, word timings, and session metrics are stored in this site's IndexedDB on the current browser and device. They are not synced or backed up.
- The theme preference is stored in local storage.
- The speech model is downloaded from Hugging Face on first use and then cached by the browser. That download does not contain your recording.
- **Copilot is an optional external service.** Choosing “Get feedback in Copilot” copies a prompt containing the transcript and session metrics to the clipboard and opens Microsoft Copilot. Short prompts are included in the Copilot URL and sent to Microsoft when that page opens. Longer prompts are copied for you to paste.
- Use **Delete all data** in the app's Privacy section to remove saved sessions and their recordings, transcripts, and results. Clearing this site's browser data also removes the locally saved sessions.

## How to read the metrics

Metrics are rule-based summaries and rough practice signals, not a judgment of speaking ability.

- **Pace:** recognized words per minute. PrepMe's 110–160 WPM range is a rough guide; an effective pace depends on audience and material.
- **Fillers:** detected filler words and phrases per minute. Recognition can miss fillers, and there is no universal ideal count.
- **Pitch variation:** estimated variation in voiced pitch, expressed in semitones. The app's labels are rough guides; natural pitch variation differs by speaker and context.
- **Repetitive language:** immediately repeated words and repeated three-word phrases detected in the transcript. Some repetition is natural.

Transcription accuracy and acoustic estimates depend on the microphone, background noise, browser, and device. The app currently targets English speech.

## Tech stack

- React and TypeScript
- Vite
- Transformers.js / Whisper for in-browser transcription
- Web Audio API for pitch analysis
- IndexedDB for local session storage
