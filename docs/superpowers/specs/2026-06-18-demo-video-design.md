# Demo Video — design spec

**Date:** 2026-06-18
**Topic:** ~60-second documentary-style demo video for `video-collab-app`
**Audience:** Computer Science demo-day attendees (watching at a stand, often without headphones)

## Goal

A ~60s video that tells the real story of the product through the **actual study participants'
words and footage**, intercut with **clean app-interface footage**. It must show: the problem
BLV creators face with visual-first editing tools → how a BLV creator and a sighted helper
collaborate → how AI assistance (scene descriptions, suggestions, verification) helps →
the emotional payoff of creative independence.

Constraints (decided with the user):
- **De-identify:** participants' **voices are used**, but **faces are blurred or framed out**
  wherever a participant appears on screen. No un-obscured identifiable faces in the render.
- **~60 seconds.**
- **Audio:** participants' **real voices** as narration, with **burned-in captions** (legible
  on a noisy demo floor).
- **Footage:** **intercut** real session clips with clean app-interface footage.
- **Reproducible:** scripted pipeline (calibrate → cut → record app → assemble), re-runnable.

## Source material (verified 2026-06-18)

- **Session video** (external drive `F:/Lan's Project/`): full multi-hour camera recordings.
  Footage exists for **May 4, 6, 7, 8**. **May 9 has no video** (audio only). **May 7 has two
  camera angles** per session (pick the better). These are the only on-camera assets.
- **Transcripts** (`C:\Users\shyla\Downloads\Video_Editing_Platform\Study Scripts`): per-session
  **`.srt` (timecoded)**, `.txt`, word-level `.json`, a combined `all_sessions_transcript.txt`,
  a **Thematic Analysis** docx, and the study protocol. The `.srt` was generated from the
  session **`.wav`** (same folder), so **SRT time == WAV time** (offset 0).
- **Session audio** (`.wav`, same Study Scripts folder): high-quality audio the captions are
  timed to. **Narration audio is taken from these WAVs**, not from the video's own track.
- **App content clips** (`video-collab-probe/footage_workspace/<project>/original/source.mp4`):
  17 short creator clips used as the in-app video for the app-interface footage. Prefer a clip
  the user clears; emphasise the UI over the video preview to avoid showing identifiable content.

## Key technical approach

### A/V sync (the crux)
SRT/WAV share one timeline; the **camera video has a small per-session offset** vs that
timeline (durations differ by seconds to a few minutes). So:
- **Narration audio** for a moment = `WAV[srtStart … srtEnd]` (exact, no offset).
- **Video** for a moment = `VIDEO[srtStart + offset … srtEnd + offset]` for that session's
  calibrated `offset`. Cutting audio from the WAV and video from the camera, then muxing, keeps
  lip-sync (both captured the same event) while guaranteeing caption/audio alignment.

**Offset calibration (`demo/calibrate.py`):** the session **WAV** (what the SRT is timed to) and
the camera **video** captured the same room audio, so the offset is found by **audio
cross-correlation** — no transcription needed. For each session: extract a few-minute mono
16 kHz audio window from both the WAV and the video (via ffmpeg), cross-correlate (numpy FFT) to
find the lag that maximises alignment, and record `offset = videoTime − wavTime`. Persist
`{ sessionKey: offsetSeconds }` to `demo/offsets.json`. Manual override allowed. (Deps: `numpy`
only; WAV read via Python stdlib `wave`. This replaces the heavier Whisper approach since this
machine has no GPU/Whisper.)

### De-identification (faces)
Wherever a participant's face is visible, blur it. Approach: per extracted video clip, run
**OpenCV face detection** (Python, Haar/DNN) to get per-frame face boxes and apply a strong
blur/mosaic to those regions (`demo/deidentify.py`). Mitigations that reduce reliance on
detection: prefer camera angles / framings showing hands, phones, or over-the-shoulder; when in
doubt apply a generous blur region. The render is reviewed before delivery to confirm no clear
faces remain. (Voices are retained by decision.)

### App-interface footage
Reuse the Playwright approach from the original plan as a **B-roll generator** for crisp UI
close-ups (not a full standalone demo): drive the real app against the live stack and record
short clips of — AI scene descriptions (3 levels), the **Edit by Myself / Ask AI to Edit / Ask
Helper to Edit** routing, an AI suggestion, the helper Activity Feed, live color-grade sync, and
export. Emphasise the UI; keep any in-player content neutral/cleared. Files under `demo/app/`.

## Video structure (~60s arc)

Sourced from the verified moment shortlist (`demo/moments.json`). Each participant beat = real
voice (from WAV) + burned caption + de-identified session video; app close-ups are intercut at
the matching beat.

1. **Intro card (~4s)** — title "Editing with a Sighted Peer and AI"; poster visual style.
2. **Problem (~14s)** — David: "The tool does not tell you what you're doing." → Mandela: "To
   record is very easy… but to edit is the biggest problem for a blind person." → Mandela/Jessica:
   "Are they not accessible?" / "They're not at all." (intercut: a visual-first editor / the app's
   description panel appearing).
3. **AI solution (~9s)** — the app's scene description playing ("A man with short dark hair and a
   beard… Africa Media Festival 2024"); David reacts: "I never knew… It's wonderful." (intercut:
   app description UI close-up).
4. **Collaboration (~14s)** — Lily: "Before, I didn't know where the problem is… now I can tell
   her, edit scene two." → Mandela: "Now the app itself will confirm it has been done. That's
   incredible." (intercut: routing buttons + helper Activity Feed + live sync).
5. **Payoff (~13s)** — Lily: "Knowing that I'm now independent really makes me feel extremely
   good." → Mandela: "Independence is coming… road to freedom… this is the beginning of it."
6. **Outro card (~6s)** — three pillars (Screen-reader-first · Real-time collaboration · AI
   assistance) + QR (from poster) + affiliations (UCL Interaction Centre · Global Disability
   Innovation Hub).

(Exact clip in/out points and swap-ins per the shortlist; total ≈ 58–60s.)

## Components (all under `video-collab-app/demo/`)

- **`moments.json`** — the curated edit list: `{ id, session, wavPath, videoPath, cameraAngle,
  srtStart, srtEnd, speaker, caption, theme, appBRoll? }` for the arc above.
- **`calibrate.py`** — computes per-session video offsets → `offsets.json` (audio cross-correlation, numpy).
- **`cut.mjs`** — for each moment: audio = `ffmpeg` cut from WAV (loudnorm); video = `ffmpeg`
  cut from camera at offset-corrected times, scaled/cropped to a common frame (e.g. 1080×1920 or
  1920×1080 — chosen at build time), piped through de-identify.
- **`deidentify.py`** — OpenCV face-blur over the cut video clips.
- **`app/` (Playwright config + spec)** — records UI B-roll clips → `demo/app/out/*.webm`.
- **`cards/intro.html`, `cards/outro.html`** — poster-styled cards; captured to clips.
- **`build.mjs`** — `ffmpeg` assembly: order clips per the arc, mux WAV-narration to each, burn
  captions (from `moments.json`), intercut app B-roll, add cards, light crossfades, optional
  low music bed → **`demo/out/demo.mp4`** and **`demo/out/demo-silent.mp4`** (captions, no voice).
- **`run.mjs`** / npm script — orchestrates calibrate → cut → deidentify → (app record) → build.
- **`README.md`** — prerequisites (F:/ mounted, dev servers, ffmpeg, Python + numpy + opencv-python)
  and the one-command run.

## Data flow

```
SRT/WAV (Study Scripts)  ── timecodes ──►  moments.json
F:/ session videos + WAVs ──► calibrate.py (xcorr) ──► offsets.json
moments.json + offsets.json
   ├─ audio: WAV[srtStart..srtEnd]  ──────────────┐
   └─ video: VIDEO[srtStart+off..srtEnd+off] ─► deidentify.py ─┐
app (Playwright) ──► app B-roll webm ─────────────────────────┤
cards ──► intro/outro clips ──────────────────────────────────┤
                                                              ▼
                                            build.mjs (ffmpeg) ──► demo.mp4 + demo-silent.mp4
```

## Error handling

- **F:/ not mounted** — `cut.mjs` fails fast with "mount F: (Lan's Project) and retry"; calibrate
  and build of app/cards/audio can still proceed for a partial preview.
- **numpy/OpenCV unavailable** — calibrate falls back to a manual offset in `offsets.json`;
  de-identify falls back to a fixed blur region or flags clips for manual review (never ships an
  un-blurred face silently — it errors instead).
- **Offset wrong (lip-sync off)** — offsets are per-session and overridable; a QA still frame at
  each clip's start is emitted for spot-checking before the final mux.
- **Missing video for a quote (May 9)** — such moments are audio-only over app B-roll/cards.

## Testing / verification

- Calibrate on one session; verify a known quote lands on the right video moment (QA still).
- Cut + de-identify one clip; confirm face is obscured and audio/caption match.
- Build a rough cut of 2–3 beats before the full arc.
- Final review: ≤60s, captions synced, no clear faces, QR scannable, audio levels even.

## Out of scope (YAGNI)

- No external/cloud TTS or voice cloning (real participant audio is used).
- No frame-accurate manual NLE editing; the pipeline targets clip-level accuracy with QA stills.
- No changes to `web/`, `server/`, or the `e2e/` tests (app B-roll uses a separate config).
- May 9 footage (none exists); no multi-language captions.

## Deliverables

- `video-collab-app/demo/` (moments, scripts, cards, app B-roll config).
- `video-collab-app/demo/out/demo.mp4` (~60s, de-identified, real voices + captions) and
  `demo-silent.mp4`.
- `demo/README.md` with prerequisites + one-command run.

## Appendix — verified moment shortlist (anchors; trim to punchy core)

Speaker key: David = blind musician (May 4 AM); Mary = his helper; Lily = blind advocacy creator
(May 4 PM); Naomi = Lily's helper; Mandela = blind creator/interpreter (May 7 AM); Jessica =
Mandela's helper. All timecodes are real `.srt` block times.

| ID | Session | Timecode | Speaker | Quote (core) | Theme |
|----|---------|----------|---------|--------------|-------|
| M1 | May 4 AM | 00:14:03→00:14:08 | David | "The tool there does not tell you what you're doing at that moment." | problem |
| M3 | May 7 AM | 00:08:23→00:08:29 | Mandela | "To record is very easy… but to edit is the biggest problem for a blind person." | problem |
| M4 | May 7 AM | 00:13:18→00:13:21 | Mandela/Jessica | "Are they not accessible?" / "They're not at all." | problem |
| M6 | May 4 AM | 00:34:24→00:34:36 | App voice | "A man with short dark hair and a beard… Africa Media Festival 2024." | AI |
| M7 | May 4 AM | 00:27:31→00:27:36 | David | "I never knew there was a decorative… It's wonderful." | AI/payoff |
| M11 | May 4 PM | 00:58:04→00:58:22 | Lily | "Before… I don't even know where the problem is… now I can tell her, edit scene two." | collaboration |
| M10 | May 7 AM | 01:36:18→01:36:25 | Mandela | "Now the app itself will confirm it has been done. That's incredible." | collaboration/AI |
| M12 | May 4 PM | 01:16:44→01:16:53 | Lily | "Knowing that I'm now independent really makes me feel extremely good." | payoff |
| M16 | May 7 AM | 00:56:31→00:56:41 | Mandela | "All of us blind people… the dream to be independent… This is the beginning of it." | payoff |
| M15 | May 7 AM | 02:10:30→02:10:50 | Mandela | "Independence is coming… road to freedom in editing videos for the blind." | payoff |

Swap-ins: M17 (Lily, "the AI makes us more independent"), M14 (Naomi, helper's perspective),
M8 (David, "Oh my God, he is wonderful"), M13 (Lily, "segments… makes work easier").
