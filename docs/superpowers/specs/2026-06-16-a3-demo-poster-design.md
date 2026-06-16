# A3 Demo Poster — Design Spec

**Date:** 2026-06-16
**For:** School summer event — a self-standing poster that explains the `video-collab-app` project to a mixed, accessibility-aware audience.
**Author:** Lan (shyland-ucl)

---

## 1. Goal & audience

- **Job of the poster:** a *self-standing explainer*. It must make sense when no one is standing next to it, and be graspable in ~10 seconds from a distance, with reward for leaning in.
- **Audience:** mixed (general public, families, students, some academics). **Design for the least-technical reader.** Plain language; research credibility present but lightweight.
- **Core message (interdependence, not solo independence):** the app puts **blind and low-vision creators in the director's seat of a collaboration** between themselves, their sighted helper, and AI. Each brings something the others can't — the creator holds the story and context, the helper brings sight, the AI brings on-demand description. The win is **agency within collaboration**, not replacing the helper.

---

## 2. Format & build

- **Size:** A3 **portrait**, 297 × 420 mm.
- **Build:** HTML/CSS rendered to PDF (same approach as the existing `poster_archive/poster.html`). Reproducible, version-controlled, easy to tweak.
- **Location:** new folder `poster_archive/poster_a3/` (sibling of the A0 poster; shares the `poster_archive/Logos/` assets).
- **Output:** `poster_a3.pdf` at 300 dpi, fonts embedded, RGB.

## 3. Visual identity (reuse existing family)

- **Font:** Inter (300–900), fallback Helvetica Neue / Arial.
- **Background:** white `#ffffff`.
- **Text:** `#1a1a1a`.
- **Accent purple:** `#71619d` (deep `#5a4e80` / `#4a3d6e` for text on tint).
- **Highlight pills / tints:** `#ece9f3`, `#e6e2f0`.
- **Type scale (A3):** title ~46–56 pt; section headers ~22–26 pt; body ~13–15 pt; captions ~10–11 pt; quotes ~18–20 pt. Generous white space (~30–40%).
- Colourblind-safe; contrast ≥ 4.5:1.

## 4. Layout — "Story flow" (top → bottom)

```
┌─────────────────────────────────────────┐
│ Logo bar: UCL · UCLIC · GDI Hub          │
├─────────────────────────────────────────┤
│ KICKER: FOR BLIND & LOW-VISION CREATORS  │
│ Editing video, together.        (H1)     │
│ subhead: director's seat …               │
├─────────────────────────────────────────┤
│ HERO PHOTO  (collab_app_visible)         │
├─────────────────────────────────────────┤
│ THE PROBLEM  +  "before" quote           │
├─────────────────────────────────────────┤
│ HOW IT WORKS — 4 steps                   │
│  1 AI describes every scene              │
│  2 The creator directs:                  │
│     by myself · ask AI · ask my helper   │
│     [two-phone photo here]               │
│  3 Co-edit the same timeline, realtime   │
│  4 Export the finished video             │
├─────────────────────────────────────────┤
│ WHY IT MATTERS  +  "after" quote         │
│  impact line · research line             │
├─────────────────────────────────────────┤
│ Footer: logos · consent line · (QR opt.) │
└─────────────────────────────────────────┘
```

### Section content & copy

**Headline block**
- Kicker: `FOR CREATORS WITH VISUAL IMPAIRMENTS`
- H1: **Editing video, together.**
- Subhead: *AI-assisted, collaborative editing that puts creators with visual impairments in the director's seat — directing their helpers and AI, not handing over control.*

> Audience wording is standardized on **"creators with visual impairments"** throughout the poster.

**Hero photo** — `collab_app_visible.jpg` (creator + sighted helper, app UI visible on the phone).

**The problem** (one tight line + quote)
- Line: *Making videos is easy. Editing them isn't — editing is deeply visual, so blind and low-vision creators have had to hand control to someone else.*
- Quote (anonymized): *"I wouldn't trust myself to edit on my own — I don't have the visual sense."* — Blind creator, Nairobi

**How it works** — the interdependence engine
1. **AI describes every scene** — so the creator knows what's in their own footage. *Real example (anonymized):*
   - Level 1: "Musicians sit in a rehearsal room with microphones, instruments, and tangled cables across the floor."
   - Level 2 / 3 available on demand (progressively more detail).
2. **The creator directs** — on every scene they choose: **Edit by myself · Ask AI to edit · Ask my helper to edit.** *(This triad is the heart of the poster.)* Place the **two-phone overhead photo** (`app_in_action_two_phones.jpg`) here — it shows both devices and the real UI.
   - Real "Ask AI" examples: *"Rotate scene 2 so the musicians are upright." · "Trim the cable-heavy opening." · "Zoom in on scene 4 to emphasise the vocalists."*
3. **Co-edit the same timeline in realtime** — creator and helper each on their own device, changes synced live.
4. **Export the finished video** — a downloadable MP4.

**Why it matters**
- Quote (anonymized): *"Now you and your helper are more in control — I have the idea of what's going on and what should be edited."* — Blind creator, Nairobi
- Impact line: *Built with 10 creator–helper pairs in Nairobi (UCL × Senses Hub). Grounded in CHI 2026 research on disability collaboration.*

**Footer**
- Logos repeated small.
- Consent line: *Session photography used with participants' consent. Faces are blurred and names are not shown.*
- No QR code (decided out for this version).

## 5. Assets

**Photos** (extracted from consented session recordings on `F:\Lan's Project`, reproducible via ffmpeg):
- **Hero:** `collab_app_visible.jpg` — `May 4\Morning Session-001.mp4` @ `00:57:05`.
- **App-in-action:** `app_in_action_two_phones.jpg` — `May 4\Morning Session-001.mp4` @ `02:32:30`.
- Working copies staged in `.superpowers/brainstorm/`; final copies go in `poster_a3/assets/`. Re-extract at higher quality (`-q:v 2`), **blur the faces**, and crop for print.

**Face blurring (required):** every identifiable face in both photos must be blurred before the photo is placed in the poster. Approach: detect/locate face regions and apply a strong Gaussian blur or pixelation (e.g. ffmpeg `boxblur`/`gblur` on a masked region, or an image editor). Blur must be irreversible (flattened into the exported JPG/PNG), and strong enough that the person is not identifiable, while the collaboration scene (two people, phones, app UI) stays legible.

**Logos** (from `poster_archive/Logos/`): `University_College_London_logo.svg.png`, `uclic-logo-2434x800.png`, `gdi_hub_logo_black_300dpi.jpg`. (CHI logo optional.)

**Example text** drawn from real project data (`video-collab-probe/footage_workspace/Jacinta_Wambua_mouere5x/project.json`) — descriptions and suggestions, used anonymized.

## 6. Privacy guardrail

- **Faces are blurred** in every photo on the poster (see Section 5). This is the decided privacy posture — we do not rely on consent for identifiable faces.
- No participant **names** printed anywhere (study rule: names stay in the intake sheet; IDs used in outputs).
- All quotes attributed generically: *"— Blind creator, Nairobi."*
- Footer consent line included, noting faces are blurred.

## 7. Out of scope (YAGNI)

- The full 3-layer framework graphic (concept referenced in one line only).
- Any QR code (decided out for this version).
- Matching the A0 poster's exact section structure — this is a friendlier, photo-led explainer, not a research poster.

## 8. Open items to resolve at build

1. Re-extract the two photos at print quality, **blur the faces** (Section 5), and crop for the A3 frame.
