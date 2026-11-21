# Speech Coach (Phase 1)
Records speech, transcribes it in the browser with Whisper, computes speaking metrics, stores sessions in IndexedDB. No backend.

    npm install
    npm run dev

Open the printed localhost URL in Chrome or Edge (microphone needs localhost or HTTPS).
The first recording downloads the speech model (~80 MB) once; later runs use the cached copy.
