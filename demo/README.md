# demo — video-collab-app demo video

Builds a ~60s de-identified demo from real study footage + app UI b-roll.

## Prerequisites
- External drive **F:\Lan's Project** mounted (session video).
- Transcripts at **C:\Users\shyla\Downloads\Video_Editing_Platform\Study Scripts**.
- `ffmpeg` + `ffprobe` on PATH; **`py -3`** (Microsoft-Store Python; the bare `python` is broken) with `numpy` + `opencv-python` (`py -3 -m pip install numpy opencv-python`).
- For app b-roll: filled `server/.env` + `web/.env.local`, and `npm run dev:web` + `npm run dev:server` running. Install the Playwright browser once: `npx playwright install chromium`. Note: the b-roll step hits **live Supabase + Gemini** — `demo-setup.mjs` uploads `demo/sample.mp4` and polls up to ~4 min while it's processed before the tests run.
- App voiceover uses **Windows SAPI** (built in) — no extra install.

## One-time
1. `npx playwright test -c demo/app/demo-broll.config.mjs`   # app UI b-roll (uses demo/sample.mp4; writes app/out/markers.json)
2. `node demo/cards/capture.mjs`                              # intro/outro cards

## Build
`node demo/run.mjs`  (calibrate → cut → de-identify → tts → captions → build)

The app b-roll carries the app's own spoken voiceover: the Overview scene
description and the real-time edit confirmation are captured during recording
(`markers.json`) and synthesised by `tts.mjs`. Faces in session footage get a
small, face-only blur (the phone/app screen stays sharp); participants are not
named — captions are quote-only.

## Safety gate
Review every `demo/out/clips/*.contact.jpg` — confirm faces are blurred — BEFORE sharing `out/demo.mp4`.

## Output
`demo/out/demo.mp4` (voices + captions) and `demo/out/demo-silent.mp4`.
