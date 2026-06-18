# demo — video-collab-app demo video

Builds a ~60s de-identified demo from real study footage + app UI b-roll.

## Prerequisites
- External drive **F:\Lan's Project** mounted (session video).
- Transcripts at **C:\Users\shyla\Downloads\Video_Editing_Platform\Study Scripts**.
- `ffmpeg` + `ffprobe` on PATH; **`py -3`** (Microsoft-Store Python; the bare `python` is broken) with `numpy` + `opencv-python` (`py -3 -m pip install numpy opencv-python`).
- For app b-roll: filled `server/.env` + `web/.env.local`, and `npm run dev:web` + `npm run dev:server` running. Install the Playwright browser once: `npx playwright install chromium`. Note: the b-roll step hits **live Supabase + Gemini** — the globalSetup polls up to ~4 min while a clip is processed before the tests can run.

## One-time
1. `npx playwright test -c demo/app/demo-broll.config.mjs`   # app UI b-roll
2. `node demo/cards/capture.mjs`                              # intro/outro cards

## Build
`node demo/run.mjs`  (calibrate → cut → de-identify → captions → build)

## Safety gate
Review every `demo/out/clips/*.contact.jpg` — confirm faces are blurred — BEFORE sharing `out/demo.mp4`.

## Output
`demo/out/demo.mp4` (voices + captions) and `demo/out/demo-silent.mp4`.
