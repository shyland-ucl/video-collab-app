# Demo Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a ~60s documentary-style demo video for `video-collab-app` from real, de-identified study footage + clean app-interface B-roll, driven by a reproducible pipeline.

**Architecture:** A `demo/` toolchain: author an edit list (`moments.json`) from verified SRT timecodes; calibrate each session's camera-vs-WAV offset by audio cross-correlation (`calibrate.py`, numpy); cut narration audio from the session WAV and video from the F:/ camera at the offset-corrected time (`cut.mjs`); blur faces (`deidentify.py`, OpenCV); record app UI B-roll (Playwright); then assemble cards + segments + burned captions into `demo.mp4` (`build.mjs`, ffmpeg). Audio comes from the WAV (caption-accurate); video lip-sync is preserved via the per-session offset.

**Tech Stack:** Node 22 (ESM `.mjs`), Python 3.13 (`numpy`, `opencv-python`), ffmpeg/ffprobe (system PATH), Playwright (`@playwright/test`, already a devDep), Vitest (already configured in `web/`).

## Global Constraints

- **De-identify:** no un-obscured identifiable participant face in the render. The build MUST fail/flag rather than ship an unverified face. Voices ARE used.
- **Length:** target ~60s (acceptable 55–65s).
- **Audio:** real participant voices (from session WAVs) + burned-in captions (verbatim quotes).
- **Footage sessions with video:** May 4, 6, 7, 8 only (May 9 audio-only). May 7 has two camera angles.
- **No changes** to `web/`, `server/`, or `e2e/` tests. All new code lives under `video-collab-app/demo/`.
- **Final video format:** 1920×1080, 30 fps, H.264 (`yuv420p`, `-crf 18`), AAC 48 kHz stereo.
- **Source roots (verbatim):**
  - F_ROOT = `F:\Lan's Project`
  - SCRIPTS = `C:\Users\shyla\Downloads\Video_Editing_Platform\Study Scripts`
- **SRT time == WAV time** (offset 0). Camera video time = SRT time + per-session `offset`.
- Run all commands from `video-collab-app/` unless stated.
- **Python interpreter: use `py -3`** (the working Microsoft-Store Python 3.13). The bare `python`/`C:\Python313` is BROKEN (UCRT DLL load failure) — do NOT use it. `numpy` + `opencv-python` are already installed under `py -3`.

---

## File Structure

```
video-collab-app/demo/
  README.md                 # prerequisites + one-command run
  sessions.json             # sessionKey -> { video, videoAngles[], wav, srt }
  moments.json              # the edit list (arc), verbatim quotes + SRT in/out
  lib/timecode.mjs          # SRT "HH:MM:SS,mmm" <-> seconds; clip duration
  lib/timecode.test.mjs     # vitest unit tests
  lib/paths.mjs             # resolved F_ROOT/SCRIPTS/ffmpeg/out paths
  calibrate.py              # audio cross-correlation -> offsets.json
  offsets.json              # { sessionKey: offsetSeconds }  (generated)
  cut.mjs                   # per-moment: WAV audio clip + camera video clip
  deidentify.py             # OpenCV face-blur + QA contact sheet
  captions.mjs              # moments.json -> demo.ass (timed to final timeline)
  cards/intro.html          # poster-styled title card
  cards/outro.html          # pillars + QR + affiliations
  cards/capture.mjs         # render cards -> mp4 clips
  app/demo-broll.config.mjs # Playwright config (video on), reuse e2e seeding
  app/demo-broll.spec.mjs   # guided UI tour; emits app/out/markers.json
  build.mjs                 # assemble everything -> out/demo.mp4 + demo-silent.mp4
  run.mjs                   # orchestrate calibrate->cut->deidentify->build
  out/                      # all generated artifacts (gitignored)
```

---

### Task 0: Branch, scaffold, dependencies

**Files:**
- Create: `demo/.gitignore`, `demo/lib/paths.mjs`
- Modify: none

**Interfaces:**
- Produces: `paths.mjs` exporting `{ F_ROOT, SCRIPTS, FFMPEG, FFPROBE, DEMO_DIR, OUT_DIR }`.

- [ ] **Step 1: Create the feature branch**

Run (from `video-collab-app/`):
```bash
git checkout -b demo-video
```
Expected: "Switched to a new branch 'demo-video'".

- [ ] **Step 2: Verify ffmpeg + ffprobe + python deps**

Run (PowerShell):
```powershell
ffmpeg -version | Select-Object -First 1
ffprobe -version | Select-Object -First 1
python --version
python -m pip install --quiet numpy opencv-python
python -c "import numpy, cv2; print('numpy', numpy.__version__, 'cv2', cv2.__version__)"
```
Expected: ffmpeg/ffprobe versions print; final line prints numpy + cv2 versions.

- [ ] **Step 3: Create `demo/.gitignore`**

```gitignore
out/
offsets.json
app/out/
*.webm
assets/source.mp4
```

- [ ] **Step 4: Create `demo/lib/paths.mjs`**

```js
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
export const DEMO_DIR = join(__dir, '..')
export const OUT_DIR = join(DEMO_DIR, 'out')
export const F_ROOT = "F:\\Lan's Project"
export const SCRIPTS = "C:\\Users\\shyla\\Downloads\\Video_Editing_Platform\\Study Scripts"
// System ffmpeg/ffprobe are on PATH (ffprobe is required and not in ffmpeg-static).
export const FFMPEG = 'ffmpeg'
export const FFPROBE = 'ffprobe'
```

- [ ] **Step 5: Commit**

```bash
git add demo/.gitignore demo/lib/paths.mjs
git commit -m "chore(demo): scaffold demo pipeline dirs + paths"
```

---

### Task 1: Timecode utility (TDD)

**Files:**
- Create: `demo/lib/timecode.mjs`
- Test: `demo/lib/timecode.test.mjs`

**Interfaces:**
- Produces:
  - `srtToSeconds(s: string): number` — "HH:MM:SS,mmm" or "HH:MM:SS.mmm" → seconds (float).
  - `secondsToFfmpeg(n: number): string` — seconds → "HH:MM:SS.mmm".
  - `clipDuration(start: string, end: string): number` — seconds between two SRT stamps.

- [ ] **Step 1: Write the failing test** — `demo/lib/timecode.test.mjs`

```js
import { describe, it, expect } from 'vitest'
import { srtToSeconds, secondsToFfmpeg, clipDuration } from './timecode.mjs'

describe('timecode', () => {
  it('parses comma and dot millis', () => {
    expect(srtToSeconds('00:14:03,897')).toBeCloseTo(843.897, 3)
    expect(srtToSeconds('01:16:44.850')).toBeCloseTo(4604.850, 3)
  })
  it('formats seconds for ffmpeg', () => {
    expect(secondsToFfmpeg(843.897)).toBe('00:14:03.897')
    expect(secondsToFfmpeg(5)).toBe('00:00:05.000')
  })
  it('computes clip duration', () => {
    expect(clipDuration('00:14:03,897', '00:14:08,039')).toBeCloseTo(4.142, 3)
  })
})
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npm run test -w web -- --run demo/lib/timecode.test.mjs`
(Vitest in `web/` resolves repo-relative paths; if it does not pick the file up, run `npx vitest run demo/lib/timecode.test.mjs` from `video-collab-app/`.)
Expected: FAIL — `srtToSeconds is not a function` / module not found.

- [ ] **Step 3: Implement** — `demo/lib/timecode.mjs`

```js
export function srtToSeconds(s) {
  const m = String(s).trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/)
  if (!m) throw new Error(`bad SRT timecode: ${s}`)
  const [, h, mm, ss, ms] = m
  return (+h) * 3600 + (+mm) * 60 + (+ss) + (+ms.padEnd(3, '0')) / 1000
}

export function secondsToFfmpeg(n) {
  if (n < 0) n = 0
  const h = Math.floor(n / 3600)
  const mm = Math.floor((n % 3600) / 60)
  const ss = Math.floor(n % 60)
  const ms = Math.round((n - Math.floor(n)) * 1000)
  const p2 = (x) => String(x).padStart(2, '0')
  return `${p2(h)}:${p2(mm)}:${p2(ss)}.${String(ms).padStart(3, '0')}`
}

export function clipDuration(start, end) {
  return srtToSeconds(end) - srtToSeconds(start)
}
```

- [ ] **Step 4: Run tests; verify pass**

Run: `npx vitest run demo/lib/timecode.test.mjs` (from `video-collab-app/`)
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add demo/lib/timecode.mjs demo/lib/timecode.test.mjs
git commit -m "feat(demo): SRT timecode utilities with tests"
```

---

### Task 2: Session map + edit list (`sessions.json`, `moments.json`)

**Files:**
- Create: `demo/sessions.json`, `demo/moments.json`

**Interfaces:**
- Produces: `sessions.json` (sessionKey → file paths, relative to F_ROOT/SCRIPTS) and `moments.json` (ordered edit list consumed by `cut.mjs`, `captions.mjs`, `build.mjs`).
- Each moment: `{ id, type:"clip"|"broll"|"card", session?, srtStart?, srtEnd?, speaker?, caption?, brollId?, card? }`.

- [ ] **Step 1: Create `demo/sessions.json`** (only the 3 sessions the arc needs; angles list lets `cut.mjs` pick)

```json
{
  "may4am": {
    "video": "May 4\\Morning Session-001.mp4",
    "wav": "May 4\\Audio\\2026-05-04_morning.wav",
    "srt": "May 4\\Audio\\2026-05-04_morning.srt"
  },
  "may4pm": {
    "video": "May 4\\Aternoon-002.mp4",
    "wav": "May 4\\Audio\\2026-05-04_afternoon.wav",
    "srt": "May 4\\Audio\\2026-05-04_afternoon.srt"
  },
  "may7am": {
    "video": "May 7\\Morning Session-001.mp4",
    "videoAngles": ["May 7\\Morning Session-001.mp4", "May 7\\Morning Session-001 (1).mp4"],
    "wav": "May 7\\Audio\\2026-05-07_morning.wav",
    "srt": "May 7\\Audio\\2026-05-07_morning.srt"
  }
}
```

- [ ] **Step 2: Create `demo/moments.json`** (the ~60s arc; `caption` is the verbatim core; `srtStart/End` are anchors — trim during QA)

```json
{
  "fps": 30,
  "size": "1920x1080",
  "timeline": [
    { "id": "intro", "type": "card", "card": "intro", "dur": 4 },

    { "id": "M1", "type": "clip", "session": "may4am", "srtStart": "00:14:03,897", "srtEnd": "00:14:08,039",
      "speaker": "David", "caption": "The tool doesn't tell you what you're doing." },
    { "id": "M3", "type": "clip", "session": "may7am", "srtStart": "00:08:23,194", "srtEnd": "00:08:29,057",
      "speaker": "Mandela", "caption": "To record is easy — but to edit is the biggest problem for a blind person." },
    { "id": "M4", "type": "clip", "session": "may7am", "srtStart": "00:13:18,326", "srtEnd": "00:13:21,268",
      "speaker": "Mandela & helper", "caption": "“Are they accessible?” — “Not at all.”" },

    { "id": "BR_desc", "type": "broll", "brollId": "descriptions", "dur": 5,
      "caption": "The app describes every scene aloud." },
    { "id": "M7", "type": "clip", "session": "may4am", "srtStart": "00:27:31,626", "srtEnd": "00:27:35,503",
      "speaker": "David", "caption": "I never knew there was a decorative… It's wonderful." },

    { "id": "M11", "type": "clip", "session": "may4pm", "srtStart": "00:58:04,103", "srtEnd": "00:58:22,009",
      "speaker": "Lily", "caption": "Before, I didn't know where the problem was. Now I can say: edit scene two." },
    { "id": "BR_route", "type": "broll", "brollId": "routing", "dur": 4,
      "caption": "Edit it yourself, ask AI, or ask your helper." },
    { "id": "M10", "type": "clip", "session": "may7am", "srtStart": "01:36:18,292", "srtEnd": "01:36:25,095",
      "speaker": "Mandela", "caption": "Now the app confirms it has been done. That's incredible." },

    { "id": "M12", "type": "clip", "session": "may4pm", "srtStart": "01:16:44,850", "srtEnd": "01:16:52,636",
      "speaker": "Lily", "caption": "Knowing that I'm now independent makes me feel extremely good." },
    { "id": "M16", "type": "clip", "session": "may7am", "srtStart": "00:56:31,304", "srtEnd": "00:56:40,594",
      "speaker": "Mandela", "caption": "All of us blind people dream of independence. This is the beginning." },

    { "id": "outro", "type": "card", "card": "outro", "dur": 6 }
  ]
}
```

- [ ] **Step 3: Validate JSON parses and durations sum near 60s**

Run (from `video-collab-app/`):
```bash
node -e "import('./demo/lib/timecode.mjs').then(({clipDuration})=>{const t=require('./demo/moments.json').timeline;let s=0;for(const m of t){const d=m.dur??clipDuration(m.srtStart,m.srtEnd);s+=d;console.log(m.id,d.toFixed(2))}console.log('TOTAL',s.toFixed(1))})"
```
Expected: each line prints a duration; `TOTAL` is ~60 (±10). If >65, shorten the longest clips' `srtEnd` and re-run.

- [ ] **Step 4: Commit**

```bash
git add demo/sessions.json demo/moments.json
git commit -m "feat(demo): session map + ~60s edit list"
```

---

### Task 3: Offset calibration by audio cross-correlation (`calibrate.py`)

**Files:**
- Create: `demo/calibrate.py`
- Produces (generated): `demo/offsets.json` = `{ sessionKey: offsetSeconds }`

**Interfaces:**
- Consumes: `sessions.json`, F_ROOT/SCRIPTS files.
- Produces: `offsets.json`. `offset` means: `videoTime = wavTime + offset`.

- [ ] **Step 1: Write `calibrate.py`**

```python
import json, subprocess, sys, wave, struct, tempfile, os
from pathlib import Path
import numpy as np

F_ROOT = Path(r"F:\Lan's Project")
SCRIPTS = Path(r"C:\Users\shyla\Downloads\Video_Editing_Platform\Study Scripts")
DEMO = Path(__file__).resolve().parent
SR = 16000          # analysis sample rate
WIN = 180.0         # seconds of WAV used as the template
MARGIN = 240.0      # +/- search window in the video
ANCHOR = 600.0      # start template this many seconds into the session

def extract(src: Path, start: float, dur: float) -> np.ndarray:
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "a.wav"
        subprocess.run(["ffmpeg","-y","-v","error","-ss",f"{start:.3f}","-t",f"{dur:.3f}",
                        "-i",str(src),"-vn","-ac","1","-ar",str(SR),"-f","wav",str(out)],
                       check=True)
        with wave.open(str(out),"rb") as w:
            n = w.getnframes(); raw = w.readframes(n)
        a = np.array(struct.unpack("<%dh" % (len(raw)//2), raw), dtype=np.float32)
    a -= a.mean()
    return a

def best_lag(template: np.ndarray, haystack: np.ndarray) -> int:
    # full cross-correlation via FFT; returns index in haystack where template starts
    n = len(template) + len(haystack)
    nfft = 1 << (n-1).bit_length()
    T = np.fft.rfft(template[::-1], nfft)
    H = np.fft.rfft(haystack, nfft)
    corr = np.fft.irfft(T*H, nfft)
    peak = int(np.argmax(corr[:len(haystack)]))
    return peak - (len(template) - 1)

def calibrate(key, s):
    wav = SCRIPTS / s["wav"]
    vid = F_ROOT / s["video"]
    if not wav.exists(): raise FileNotFoundError(wav)
    if not vid.exists(): raise FileNotFoundError(f"{vid} (mount F:?)")
    template = extract(wav, ANCHOR, WIN)
    hay_start = max(0.0, ANCHOR - MARGIN)
    haystack = extract(vid, hay_start, WIN + 2*MARGIN)
    lag_samples = best_lag(template, haystack)
    video_match_time = hay_start + lag_samples / SR
    offset = video_match_time - ANCHOR
    print(f"  {key}: offset = {offset:+.3f}s")
    return round(offset, 3)

def main():
    sessions = json.loads((DEMO/"sessions.json").read_text())
    keys = sys.argv[1:] or list(sessions)
    out = {}
    op = DEMO/"offsets.json"
    if op.exists(): out = json.loads(op.read_text())
    for k in keys:
        print(f"calibrating {k} ...")
        out[k] = calibrate(k, sessions[k])
        op.write_text(json.dumps(out, indent=2))
    print("wrote", op)

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Sanity-check the cross-correlation core on a synthetic signal**

Run (PowerShell):
```powershell
py -3 -c "import numpy as np; import importlib.util as u; spec=u.spec_from_file_location('c','demo/calibrate.py'); m=u.module_from_spec(spec); spec.loader.exec_module(m); rng=np.random.default_rng(0); h=rng.standard_normal(20000).astype('float32'); t=h[5000:7000].copy(); print('lag', m.best_lag(t,h))"
```
Expected: `lag 5000` (the template is found at index 5000).

- [ ] **Step 3: Calibrate the three arc sessions (requires F:/ mounted)**

Run:
```powershell
py -3 demo/calibrate.py may4am may4pm may7am
```
Expected: three `offset = ...s` lines (each within a few minutes of 0) and `wrote demo/offsets.json`.
If a session has little speech at ANCHOR=600s, re-run after editing `ANCHOR` to a talky time, or set the offset manually in `offsets.json`.

- [ ] **Step 4: Commit (script only; offsets.json is gitignored)**

```bash
git add demo/calibrate.py
git commit -m "feat(demo): per-session A/V offset via audio cross-correlation"
```

---

### Task 4: Cut narration audio + camera video per moment (`cut.mjs`)

**Files:**
- Create: `demo/cut.mjs`
- Produces: `out/clips/<id>.audio.wav`, `out/clips/<id>.raw.mp4`, `out/clips/<id>.start.png` (QA still)

**Interfaces:**
- Consumes: `moments.json`, `sessions.json`, `offsets.json`, `lib/timecode.mjs`, `lib/paths.mjs`.
- Produces: per-clip audio (48k stereo, loudnorm) and de-id-pending video (1920×1080, 30fps, no audio) + a QA still at the clip start.

- [ ] **Step 1: Write `cut.mjs`**

```js
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { FFMPEG, F_ROOT, SCRIPTS, DEMO_DIR, OUT_DIR } from './lib/paths.mjs'
import { srtToSeconds, secondsToFfmpeg, clipDuration } from './lib/timecode.mjs'

const sessions = JSON.parse(readFileSync(join(DEMO_DIR, 'sessions.json')))
const moments = JSON.parse(readFileSync(join(DEMO_DIR, 'moments.json')))
const offsets = existsSync(join(DEMO_DIR, 'offsets.json'))
  ? JSON.parse(readFileSync(join(DEMO_DIR, 'offsets.json'))) : {}
const CLIPS = join(OUT_DIR, 'clips')
mkdirSync(CLIPS, { recursive: true })

const ff = (args) => execFileSync(FFMPEG, ['-y', '-v', 'error', ...args], { stdio: 'inherit' })

for (const m of moments.timeline) {
  if (m.type !== 'clip') continue
  const s = sessions[m.session]
  if (!s) throw new Error(`unknown session ${m.session}`)
  if (!(m.session in offsets)) throw new Error(`no offset for ${m.session}; run calibrate.py`)
  const off = offsets[m.session]
  const start = srtToSeconds(m.srtStart)
  const dur = clipDuration(m.srtStart, m.srtEnd)
  const wav = join(SCRIPTS, s.wav)
  const vid = join(F_ROOT, s.videoAngles?.[0] ?? s.video)

  // Narration: cut from WAV (PCM seek is accurate even before -i).
  ff(['-ss', secondsToFfmpeg(start), '-t', dur.toFixed(3), '-i', wav,
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', '-ac', '2',
      join(CLIPS, `${m.id}.audio.wav`)])

  // Video: fast-seek to (t-5) then accurate output-seek 5s; pad to 1920x1080@30.
  const vstart = Math.max(0, start + off - 5)
  ff(['-ss', secondsToFfmpeg(vstart), '-i', vid, '-ss', '5', '-t', dur.toFixed(3),
      '-an', '-vf',
      'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30,setsar=1',
      '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
      join(CLIPS, `${m.id}.raw.mp4`)])

  // QA still at the clip start (to eyeball A/V sync before de-id).
  ff(['-i', join(CLIPS, `${m.id}.raw.mp4`), '-frames:v', '1', join(CLIPS, `${m.id}.start.png`)])
  console.log('cut', m.id, `dur=${dur.toFixed(2)}s`)
}
console.log('clips ->', CLIPS)
```

- [ ] **Step 2: Run it (F:/ mounted, offsets present)**

Run: `node demo/cut.mjs`
Expected: one `cut <id> dur=...` line per clip; files appear in `out/clips/`.

- [ ] **Step 3: Verify artifacts (duration + still)**

Run (PowerShell):
```powershell
Get-ChildItem demo/out/clips/*.raw.mp4 | ForEach-Object { "{0}  {1}s" -f $_.Name, (ffprobe -v error -show_entries format=duration -of csv=p=0 $_.FullName) }
```
Expected: each `.raw.mp4` duration ≈ its moment duration. Open a couple of `*.start.png` to confirm the frame shows the right scene (people talking, app on table) — i.e. the offset is right. If a clip is clearly off, fix that session's offset in `offsets.json` and re-run.

- [ ] **Step 4: Commit**

```bash
git add demo/cut.mjs
git commit -m "feat(demo): cut per-moment narration audio + camera video"
```

---

### Task 5: Face de-identification + QA contact sheet (`deidentify.py`)

**Files:**
- Create: `demo/deidentify.py`
- Produces: `out/clips/<id>.deid.mp4`, `out/clips/<id>.contact.jpg` (QA grid)

**Interfaces:**
- Consumes: `out/clips/<id>.raw.mp4`.
- Produces: face-blurred video (same dims/fps, no audio) + a contact sheet for the human QA gate.

- [ ] **Step 1: Write `deidentify.py`**

```python
import sys, subprocess, tempfile
from pathlib import Path
import cv2, numpy as np

CLIPS = Path(__file__).resolve().parent / "out" / "clips"
CASCADES = [
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml",
    cv2.data.haarcascades + "haarcascade_profileface.xml",
]
DETS = [cv2.CascadeClassifier(c) for c in CASCADES]

def blur_faces(frame, prev_boxes):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    boxes = []
    for det in DETS:
        for (x, y, w, h) in det.detectMultiScale(gray, 1.2, 5, minSize=(40, 40)):
            boxes.append((x, y, w, h))
    # Carry forward last-seen boxes for a few frames to cover detection dropouts.
    use = boxes if boxes else prev_boxes
    for (x, y, w, h) in use:
        pad = int(0.35 * w)
        x0, y0 = max(0, x - pad), max(0, y - pad)
        x1, y1 = min(frame.shape[1], x + w + pad), min(frame.shape[0], y + h + pad)
        roi = frame[y0:y1, x0:x1]
        if roi.size:
            k = max(31, (((x1 - x0) // 2) | 1))
            frame[y0:y1, x0:x1] = cv2.GaussianBlur(roi, (k, k), 0)
    return frame, (boxes if boxes else [])

def process(clip_id):
    src = CLIPS / f"{clip_id}.raw.mp4"
    cap = cv2.VideoCapture(str(src))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    tmp = CLIPS / f"{clip_id}.deid.tmp.mp4"
    vw = cv2.VideoWriter(str(tmp), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    prev, frames, samples = [], 0, []
    while True:
        ok, frame = cap.read()
        if not ok: break
        frame, prev = blur_faces(frame, prev)
        vw.write(frame)
        if frames % 15 == 0: samples.append(cv2.resize(frame, (320, 180)))
        frames += 1
    cap.release(); vw.release()
    # Re-encode to H.264 yuv420p (mp4v from OpenCV isn't broadly compatible).
    out = CLIPS / f"{clip_id}.deid.mp4"
    subprocess.run(["ffmpeg","-y","-v","error","-i",str(tmp),
                    "-c:v","libx264","-crf","18","-pix_fmt","yuv420p",str(out)], check=True)
    tmp.unlink(missing_ok=True)
    # Contact sheet for the QA gate.
    if samples:
        cols = 6
        rows = (len(samples) + cols - 1) // cols
        grid = np.zeros((rows*180, cols*320, 3), np.uint8)
        for i, s in enumerate(samples):
            r, c = divmod(i, cols)
            grid[r*180:(r+1)*180, c*320:(c+1)*320] = s
        cv2.imwrite(str(CLIPS / f"{clip_id}.contact.jpg"), grid)
    print(f"deid {clip_id}: {frames} frames -> {out.name}")

if __name__ == "__main__":
    ids = sys.argv[1:]
    if not ids:
        ids = sorted({p.stem.replace('.raw','') for p in CLIPS.glob('*.raw.mp4')})
    for cid in ids:
        process(cid)
```

- [ ] **Step 2: Run it**

Run: `py -3 demo/deidentify.py`
Expected: `deid <id>: N frames -> <id>.deid.mp4` per clip.

- [ ] **Step 3: QA GATE — review every contact sheet (de-identification is safety-critical)**

Open each `demo/out/clips/*.contact.jpg`. Confirm faces are blurred in every sampled frame. If any clip shows a clear face:
- prefer the other camera angle (set `videoAngles[1]` as `video` for that session and re-cut), or
- widen blur: raise the `pad` factor / lower `detectMultiScale` `minSize`, re-run, or
- mark the clip for a hard manual region blur (add a follow-up step) — do NOT proceed to build with a clear face.

- [ ] **Step 4: Commit**

```bash
git add demo/deidentify.py
git commit -m "feat(demo): OpenCV face de-identification + QA contact sheets"
```

---

### Task 6: App-interface B-roll (Playwright)

**Files:**
- Create: `demo/app/demo-broll.config.mjs`, `demo/app/demo-broll.spec.mjs`
- Produces: `demo/app/out/<brollId>.webm` for `descriptions`, `routing` (markers for trimming in build)

**Interfaces:**
- Consumes: the e2e seeding (`../../e2e/setup/globalSetup.mjs`) + live dev servers.
- Produces: short UI clips referenced by `moments.json` `brollId`.

- [ ] **Step 1: Write `demo/app/demo-broll.config.mjs`**

```js
import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  workers: 1,
  globalSetup: '../../e2e/setup/globalSetup.mjs',
  globalTeardown: '../../e2e/setup/globalTeardown.mjs',
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1280, height: 720 },
    video: { mode: 'on', size: { width: 1280, height: 720 } },
  },
  webServer: [
    { command: 'npm run dev:web', port: 5173, reuseExistingServer: true, timeout: 60_000 },
    { command: 'npm run dev:server', port: 3001, reuseExistingServer: true, timeout: 60_000 },
  ],
})
```

- [ ] **Step 2: Write `demo/app/demo-broll.spec.mjs`** (one clip per UI beat; each test → its own video)

```js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const state = JSON.parse(fs.readFileSync(new URL('../../e2e/.state.json', import.meta.url), 'utf-8'))
const OUT = fileURLToPath(new URL('./out/', import.meta.url))
fs.mkdirSync(OUT, { recursive: true })

async function signIn(page) {
  await page.goto('/signin')
  await page.getByLabel(/email address/i).fill(state.creatorEmail)
  await page.getByLabel(/password/i).fill(state.password)
  await page.getByRole('button', { name: /^sign in$/i }).click()
  await expect(page.getByRole('heading', { name: /your projects/i })).toBeVisible()
  await page.goto(`/projects/${state.projectId}/edit`)
  await expect(page.getByRole('button', { name: /^scene 1 of/i })).toBeVisible({ timeout: 30_000 })
}

test.afterEach(async ({}, testInfo) => {
  // Move the recorded video to a stable brollId.webm (test title == brollId).
  const v = testInfo.attachments.find(a => a.name === 'video')
  if (v?.path) fs.copyFileSync(v.path, OUT + testInfo.title + '.webm')
})

test('descriptions', async ({ page }) => {
  await signIn(page)
  await page.getByRole('button', { name: /^scene 1 of/i }).first().click()
  // Let the description panel + detail-level controls sit on screen for a few seconds.
  await page.waitForTimeout(5000)
})

test('routing', async ({ page }) => {
  await signIn(page)
  const header = page.getByRole('button', { name: /^scene 1 of/i }).first()
  await header.click()
  // The three routing actions: "Edit by Myself", "Ask AI to Edit", "Ask Helper to Edit".
  await expect(page.getByRole('button', { name: /edit by myself/i })).toBeVisible()
  await page.waitForTimeout(4000)
})
```

- [ ] **Step 3: Ensure dev servers + env, then record**

Run (PowerShell, separate terminals or background):
```powershell
npm run dev:web ; # in one shell
npm run dev:server ; # in another
npx playwright test -c demo/app/demo-broll.config.mjs
```
Expected: 2 passed; `demo/app/out/descriptions.webm` and `routing.webm` exist.

- [ ] **Step 4: Verify artifacts**

Run: `Get-ChildItem demo/app/out/*.webm | Select-Object Name,Length`
Expected: both webm files non-empty.

- [ ] **Step 5: Commit**

```bash
git add demo/app/demo-broll.config.mjs demo/app/demo-broll.spec.mjs
git commit -m "feat(demo): app UI b-roll capture via Playwright"
```

---

### Task 7: Title + outro cards (`cards/*.html`, `cards/capture.mjs`)

**Files:**
- Create: `demo/cards/intro.html`, `demo/cards/outro.html`, `demo/cards/capture.mjs`
- Produces: `out/cards/intro.mp4`, `out/cards/outro.mp4`

**Interfaces:**
- Consumes: optional QR image from the poster (`poster_archive/poster_a3/assets/`).
- Produces: 1920×1080 still-image cards turned into timed mp4 clips (durations from `moments.json`).

- [ ] **Step 1: Create `demo/cards/intro.html`** (poster palette; self-contained)

```html
<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;width:1920px;height:1080px;background:#1b1033;color:#fff;
    font-family:Georgia,serif;display:flex;flex-direction:column;justify-content:center;
    align-items:center;text-align:center}
  h1{font-size:84px;max-width:1500px;line-height:1.1;margin:0 0 24px}
  p{font-size:40px;color:#d9c7ff;margin:0;max-width:1300px}
</style>
<h1>Editing with a Sighted Peer and AI</h1>
<p>Collaborative video editing for blind &amp; low-vision creators</p>
```

- [ ] **Step 2: Create `demo/cards/outro.html`**

```html
<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;width:1920px;height:1080px;background:#1b1033;color:#fff;
    font-family:Georgia,serif;display:flex;flex-direction:column;justify-content:center;
    align-items:center;text-align:center}
  .pillars{font-size:46px;color:#fff;margin:0 0 40px;line-height:1.5}
  .pillars b{color:#c9a6ff}
  .aff{font-size:30px;color:#d9c7ff;margin-top:30px}
</style>
<div class="pillars">
  <div><b>Screen-reader-first</b></div>
  <div><b>Real-time collaboration</b></div>
  <div><b>AI assistance</b></div>
</div>
<div class="aff">UCL Interaction Centre &middot; Global Disability Innovation Hub</div>
```

- [ ] **Step 3: Write `demo/cards/capture.mjs`** (Playwright screenshot → ffmpeg still-to-clip)

```js
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FFMPEG, DEMO_DIR, OUT_DIR } from '../lib/paths.mjs'

const moments = JSON.parse(readFileSync(join(DEMO_DIR, 'moments.json')))
const CARDS = join(OUT_DIR, 'cards')
mkdirSync(CARDS, { recursive: true })
const dur = (name) => moments.timeline.find(m => m.card === name)?.dur ?? 5

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
for (const name of ['intro', 'outro']) {
  await page.goto(pathToFileURL(join(DEMO_DIR, 'cards', `${name}.html`)).href)
  const png = join(CARDS, `${name}.png`)
  await page.screenshot({ path: png })
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-loop', '1', '-i', png, '-t', String(dur(name)),
    '-vf', 'fps=30,format=yuv420p,scale=1920:1080', '-c:v', 'libx264', '-crf', '18',
    join(CARDS, `${name}.mp4`)], { stdio: 'inherit' })
  console.log('card', name, `${dur(name)}s`)
}
await browser.close()
```

- [ ] **Step 4: Run + verify**

Run: `node demo/cards/capture.mjs`
Expected: `out/cards/intro.mp4` (~4s) and `outro.mp4` (~6s) exist (`ffprobe` duration check).

- [ ] **Step 5: Commit**

```bash
git add demo/cards/intro.html demo/cards/outro.html demo/cards/capture.mjs
git commit -m "feat(demo): intro + outro cards"
```

---

### Task 8: Captions (`captions.mjs`) + assembly (`build.mjs`)

**Files:**
- Create: `demo/captions.mjs`, `demo/build.mjs`
- Produces: `out/demo.ass`, `out/demo.mp4`, `out/demo-silent.mp4`

**Interfaces:**
- Consumes: `moments.json`, `out/clips/<id>.deid.mp4` + `.audio.wav`, `app/out/<brollId>.webm`, `out/cards/*.mp4`.
- Produces: the final videos. Captions are timed to cumulative timeline position.

- [ ] **Step 1: Write `demo/captions.mjs`** (emit an ASS subtitle file from the EDL)

```js
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEMO_DIR, OUT_DIR } from './lib/paths.mjs'
import { clipDuration } from './lib/timecode.mjs'

const moments = JSON.parse(readFileSync(join(DEMO_DIR, 'moments.json')))
const dur = (m) => m.dur ?? clipDuration(m.srtStart, m.srtEnd)
const t = (sec) => {
  const h = Math.floor(sec/3600), mm = Math.floor((sec%3600)/60)
  const ss = (sec%60).toFixed(2).padStart(5,'0')
  return `${h}:${String(mm).padStart(2,'0')}:${ss}`
}
const head = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap, Arial, 52, &H00FFFFFF, &H00000000, &H64000000, 1, 3, 0, 2, 120, 120, 90, 1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`
let cur = 0, lines = ''
for (const m of moments.timeline) {
  const d = dur(m)
  if (m.caption) {
    const text = m.caption.replace(/\n/g, '\\N')
    const sp = m.speaker ? `{\\i1}${m.speaker}:{\\i0} ` : ''
    lines += `Dialogue: 0,${t(cur)},${t(cur+d)},Cap,,0,0,0,,${sp}${text}\n`
  }
  cur += d
}
writeFileSync(join(OUT_DIR, 'demo.ass'), head + lines)
console.log('captions -> out/demo.ass; total', cur.toFixed(1), 's')
```

- [ ] **Step 2: Write `demo/build.mjs`** (normalize every segment, concat, mux narration, burn captions)

```js
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { FFMPEG, DEMO_DIR, OUT_DIR } from './lib/paths.mjs'
import { clipDuration } from './lib/timecode.mjs'

const moments = JSON.parse(readFileSync(join(DEMO_DIR, 'moments.json')))
const CLIPS = join(OUT_DIR, 'clips')
const CARDS = join(OUT_DIR, 'cards')
const BROLL = join(DEMO_DIR, 'app', 'out')
const SEG = join(OUT_DIR, 'segments')
mkdirSync(SEG, { recursive: true })
const ff = (a) => execFileSync(FFMPEG, ['-y', '-v', 'error', ...a], { stdio: 'inherit' })
const dur = (m) => m.dur ?? clipDuration(m.srtStart, m.srtEnd)

// Common normalize: 1920x1080@30, yuv420p, 48k stereo AAC, exactly `d` seconds.
const VF = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30,setsar=1,format=yuv420p'
function norm(srcVideo, srcAudio, d, outPath) {
  const args = ['-i', srcVideo]
  if (srcAudio) args.push('-i', srcAudio)
  args.push('-t', d.toFixed(3), '-vf', VF, '-r', '30')
  if (srcAudio) args.push('-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest')
  else args.push('-f', 'lavfi', '-t', d.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
                 '-map', '0:v:0', '-map', '2:a:0', '-c:a', 'aac', '-shortest')
  args.push('-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', outPath)
  ff(args)
}

const list = []
for (const m of moments.timeline) {
  const out = join(SEG, `${m.id}.mp4`)
  if (m.type === 'card') norm(join(CARDS, `${m.card}.mp4`), null, dur(m), out)
  else if (m.type === 'clip') {
    const v = join(CLIPS, `${m.id}.deid.mp4`)
    if (!existsSync(v)) throw new Error(`missing de-identified clip ${v} — run deidentify.py + pass QA`)
    norm(v, join(CLIPS, `${m.id}.audio.wav`), dur(m), out)
  } else if (m.type === 'broll') {
    const v = join(BROLL, `${m.brollId}.webm`)
    norm(v, null, dur(m), out)   // b-roll is silent under its caption
  }
  list.push(`file '${out.replace(/\\/g, '/')}'`)
}
const listPath = join(OUT_DIR, 'concat.txt')
writeFileSync(listPath, list.join('\n'))

// Concat (all segments share codec params) then burn captions.
const concat = join(OUT_DIR, 'concat.mp4')
ff(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', concat])
const ass = join(OUT_DIR, 'demo.ass').replace(/\\/g, '/').replace(':', '\\:')
ff(['-i', concat, '-vf', `ass='${ass}'`, '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', join(OUT_DIR, 'demo.mp4')])
// Silent captioned variant.
ff(['-i', join(OUT_DIR, 'demo.mp4'), '-an', '-c:v', 'copy', join(OUT_DIR, 'demo-silent.mp4')])
console.log('built -> out/demo.mp4 + out/demo-silent.mp4')
```

- [ ] **Step 3: Generate captions, then build**

Run:
```bash
node demo/captions.mjs
node demo/build.mjs
```
Expected: `built -> out/demo.mp4 + out/demo-silent.mp4`. If concat errors on mismatched params, confirm every segment came through `norm` (same codec/rate).

- [ ] **Step 4: Verify the final video**

Run (PowerShell):
```powershell
ffprobe -v error -show_entries format=duration:stream=width,height,codec_name -of default=noprint_wrappers=1 demo/out/demo.mp4
```
Expected: duration ~55–65s, 1920×1080, h264 + aac. Play it: captions synced, audio audible, **no clear faces**, cards top and tail.

- [ ] **Step 5: Commit**

```bash
git add demo/captions.mjs demo/build.mjs
git commit -m "feat(demo): captions + final assembly pipeline"
```

---

### Task 9: Orchestrator + README

**Files:**
- Create: `demo/run.mjs`, `demo/README.md`

**Interfaces:**
- Consumes: all prior scripts. Produces: a single entry point + docs.

- [ ] **Step 1: Write `demo/run.mjs`**

```js
import { execFileSync } from 'node:child_process'
import { DEMO_DIR } from './lib/paths.mjs'
const run = (cmd, args) => execFileSync(cmd, args, { cwd: DEMO_DIR + '/..', stdio: 'inherit' })
console.log('1/5 calibrate'); run('py', ['-3', 'demo/calibrate.py'])
console.log('2/5 cut');       run('node', ['demo/cut.mjs'])
console.log('3/5 deidentify');run('py', ['-3', 'demo/deidentify.py'])
console.log('4/5 captions');  run('node', ['demo/captions.mjs'])
console.log('5/5 build');     run('node', ['demo/build.mjs'])
console.log('done. Review demo/out/*.contact.jpg before sharing.')
// NOTE: run the app b-roll (Task 6) and cards (Task 7) once up-front; they are not
// re-run here because they need live dev servers / are stable between runs.
```

- [ ] **Step 2: Write `demo/README.md`**

```markdown
# demo — video-collab-app demo video

Builds a ~60s de-identified demo from real study footage + app UI b-roll.

## Prerequisites
- External drive **F:\Lan's Project** mounted (session video).
- Transcripts at **C:\Users\shyla\Downloads\Video_Editing_Platform\Study Scripts**.
- `ffmpeg` + `ffprobe` on PATH; **`py -3`** (Microsoft-Store Python; the bare `python` is broken) with `numpy` + `opencv-python` (`py -3 -m pip install numpy opencv-python`).
- For app b-roll: filled `server/.env` + `web/.env.local`, and `npm run dev:web` + `npm run dev:server` running.

## One-time
1. `npx playwright test -c demo/app/demo-broll.config.mjs`   # app UI b-roll
2. `node demo/cards/capture.mjs`                              # intro/outro cards

## Build
`node demo/run.mjs`  (calibrate → cut → de-identify → captions → build)

## Safety gate
Review every `demo/out/clips/*.contact.jpg` — confirm faces are blurred — BEFORE sharing `out/demo.mp4`.

## Output
`demo/out/demo.mp4` (voices + captions) and `demo/out/demo-silent.mp4`.
```

- [ ] **Step 3: Commit**

```bash
git add demo/run.mjs demo/README.md
git commit -m "feat(demo): orchestrator + README"
```

---

## Milestone: rough cut (do after Tasks 0–5 + minimal cards)

Before recording app b-roll and building the full arc, produce a 3-beat rough cut (M1 → M7 → M12) to confirm sync, blur, and captions end-to-end. Temporarily reduce `moments.json.timeline` to `[intro, M1, M7, M12, outro]`, run cards + captions + build, and review. Restore the full timeline once verified. This de-risks the offset/lip-sync/blur chain before the full render.

---

## Self-Review (completed)

- **Spec coverage:** source material (T2), A/V sync via xcorr (T3), audio-from-WAV + video-at-offset (T4), de-identification + safety gate (T5, milestone), app b-roll (T6), cards/QR/affiliations (T7), captions + real voices + assembly + silent variant (T8), error handling (fail-fast checks in T3/T4/T8), README/prereqs (T9). QR image: drop `poster_archive/poster_a3/assets/<qr>.png` onto `outro.html` if a scannable QR is wanted (optional; affiliations already present).
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type consistency:** `srtToSeconds/secondsToFfmpeg/clipDuration` used consistently; `offset` defined once (videoTime = wavTime + offset) and used identically in T3/T4; segment `norm()` output feeds concat in T8.
- **Known tuning (not placeholders):** `ANCHOR` time per session (T3 step 3), blur `pad`/`minSize` (T5 step 3), and `srtEnd` trims to hit ~60s (T2 step 3) are verification-driven adjustments with explicit instructions.
```
