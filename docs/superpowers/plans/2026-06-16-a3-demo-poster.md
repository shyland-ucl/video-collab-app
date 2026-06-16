# A3 Demo Poster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a print-ready A3 portrait poster (HTML/CSS → PDF) that explains the `video-collab-app` project for a school summer event, with an interdependence-first message and blurred participant faces.

**Architecture:** A single self-contained HTML file (`poster.html`) styled to A3 portrait with `@page`, reusing the existing poster's Inter + purple visual identity. Two blurred photos and three logos live in `assets/`. A small Playwright script renders the HTML to a 300-dpi-equivalent PDF and a PNG proof. No app code is touched.

**Tech Stack:** HTML/CSS (print media), ffmpeg (frame extraction), Python + OpenCV (face blur), Node + Playwright (HTML→PDF render + screenshot proof).

**Reference spec:** `docs/superpowers/specs/2026-06-16-a3-demo-poster-design.md`

---

## File Structure

All new files live in `poster_archive/poster_a3/` (sibling of the existing A0 `poster.html`; the repo root is `C:\Users\shyla\OneDrive\Документы\GitHub\video-collab-app`, and `poster_archive` is one level up at `..\poster_archive`).

- `..\poster_archive\poster_a3\poster.html` — the poster (structure + inline CSS).
- `..\poster_archive\poster_a3\assets\hero.jpg` — blurred hero photo.
- `..\poster_archive\poster_a3\assets\two_phones.jpg` — app-in-action photo (blur only if faces present).
- `..\poster_archive\poster_a3\assets\ucl.png`, `uclic.png`, `gdi.jpg` — logos (copied).
- `..\poster_archive\poster_a3\tools\blur_faces.py` — face-detect + blur script.
- `..\poster_archive\poster_a3\tools\render.mjs` — Playwright HTML→PDF + PNG.
- `..\poster_archive\poster_a3\package.json` — pins Playwright for the render step.
- `..\poster_archive\poster_a3\poster_a3.pdf`, `poster_a3.proof.png` — build outputs.

> **Note on "tests":** this is a static design artifact, so verification is *render + visual inspection* rather than unit tests. Each build task ends by rendering and viewing the result. Treat the render/inspect steps as the test loop.

> **Working directory:** commands below assume you start in the repo root. The poster folder is outside the repo, so commits to the poster are made in the `poster_archive` git repo if it is one; if `poster_archive` is **not** a git repo, skip the `git` steps there and instead just save files (confirm with `git -C ../poster_archive rev-parse --is-inside-work-tree` in Task 1).

---

### Task 1: Scaffold the poster folder and copy logos

**Files:**
- Create dir: `..\poster_archive\poster_a3\assets\`, `..\poster_archive\poster_a3\tools\`
- Copy: three logos into `assets/`

- [ ] **Step 1: Create the folders**

Run (Git Bash):
```bash
mkdir -p "../poster_archive/poster_a3/assets" "../poster_archive/poster_a3/tools"
```

- [ ] **Step 2: Check whether poster_archive is a git repo (affects later commit steps)**

Run:
```bash
git -C ../poster_archive rev-parse --is-inside-work-tree 2>/dev/null && echo "IS_GIT" || echo "NOT_GIT"
```
Record the result. If `NOT_GIT`, skip every `git -C ../poster_archive ...` step in later tasks (just leave the files on disk).

- [ ] **Step 3: Copy the three logos**

Run:
```bash
cp "../poster_archive/Logos/University_College_London_logo.svg.png" "../poster_archive/poster_a3/assets/ucl.png"
cp "../poster_archive/Logos/uclic-logo-2434x800.png"                 "../poster_archive/poster_a3/assets/uclic.png"
cp "../poster_archive/Logos/gdi_hub_logo_black_300dpi.jpg"           "../poster_archive/poster_a3/assets/gdi.jpg"
ls -la "../poster_archive/poster_a3/assets/"
```
Expected: three files (`ucl.png`, `uclic.png`, `gdi.jpg`) listed.

---

### Task 2: Re-extract the two photos at full quality

**Files:**
- Create: `..\poster_archive\poster_a3\assets\hero_raw.jpg`, `two_phones_raw.jpg`

Both frames come from a consented session recording on the F: drive. ffmpeg is already installed (Windows binary — use Windows-style paths).

- [ ] **Step 1: Extract the hero frame (creator + helper, app visible)**

Run:
```bash
ffmpeg -y -ss 00:57:05 -i "F:\\Lan's Project\\May 4\\Morning Session-001.mp4" \
  -frames:v 1 -q:v 2 -update 1 \
  "C:\\Users\\shyla\\OneDrive\\Документы\\GitHub\\poster_archive\\poster_a3\\assets\\hero_raw.jpg"
```

- [ ] **Step 2: Extract the two-phone overhead frame**

Run:
```bash
ffmpeg -y -ss 02:32:30 -i "F:\\Lan's Project\\May 4\\Morning Session-001.mp4" \
  -frames:v 1 -q:v 2 -update 1 \
  "C:\\Users\\shyla\\OneDrive\\Документы\\GitHub\\poster_archive\\poster_a3\\assets\\two_phones_raw.jpg"
```

- [ ] **Step 3: Verify both frames exist and are 1920×1080**

Run:
```bash
for f in hero_raw two_phones_raw; do
  ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 \
    "../poster_archive/poster_a3/assets/$f.jpg";
done
```
Expected: `1920,1080` printed twice.

- [ ] **Step 4: View both frames to confirm content and note face locations**

Use the Read tool on both `hero_raw.jpg` and `two_phones_raw.jpg`. Confirm: hero shows the helper (left, looking at phone) + creator (right) with app UI on the phone; two_phones shows two phones running the app from overhead. **Write down, for the hero, the rough pixel bounding box of each visible face** (you'll feed these to the blur script as a fallback). The overhead frame typically shows no identifiable faces — confirm whether any face is identifiable.

---

### Task 3: Blur faces (privacy guardrail)

**Files:**
- Create: `..\poster_archive\poster_a3\tools\blur_faces.py`
- Create: `..\poster_archive\poster_a3\assets\hero.jpg`, `two_phones.jpg`

The script auto-detects faces with OpenCV's Haar cascade and applies a strong, irreversible Gaussian blur. It also accepts manual boxes for any face the detector misses.

- [ ] **Step 1: Write the blur script**

Create `..\poster_archive\poster_a3\tools\blur_faces.py`:
```python
import sys, cv2

def blur_faces(src, dst, manual_boxes=None):
    img = cv2.imread(src)
    if img is None:
        raise SystemExit(f"cannot read {src}")
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    faces = list(cascade.detectMultiScale(gray, scaleFactor=1.1,
                                          minNeighbors=5, minSize=(60, 60)))
    if manual_boxes:
        faces += manual_boxes
    for (x, y, w, h) in faces:
        pad = int(0.25 * w)
        x0, y0 = max(0, x - pad), max(0, y - pad)
        x1, y1 = min(img.shape[1], x + w + pad), min(img.shape[0], y + h + pad)
        roi = img[y0:y1, x0:x1]
        k = max(31, (roi.shape[1] // 4) | 1)  # odd kernel, strong blur
        img[y0:y1, x0:x1] = cv2.GaussianBlur(roi, (k, k), 0)
    cv2.imwrite(dst, img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    print(f"{dst}: blurred {len(faces)} region(s)")

if __name__ == "__main__":
    # usage: blur_faces.py SRC DST [x,y,w,h ...]
    src, dst = sys.argv[1], sys.argv[2]
    boxes = [tuple(map(int, a.split(","))) for a in sys.argv[3:]]
    blur_faces(src, dst, boxes)
```

- [ ] **Step 2: Ensure OpenCV is available**

Run:
```bash
python -c "import cv2; print(cv2.__version__)" || pip install opencv-python
```
Expected: a version number prints (install if it errors, then re-run).

- [ ] **Step 3: Blur the hero faces**

Run (auto-detect first):
```bash
cd "../poster_archive/poster_a3"
python tools/blur_faces.py assets/hero_raw.jpg assets/hero.jpg
```
Expected: `assets/hero.jpg: blurred N region(s)` with N ≥ 1.

- [ ] **Step 4: View `assets/hero.jpg` and confirm every face is unidentifiable**

Use Read on `assets/hero.jpg`. If any face is still identifiable, re-run with the manual box(es) you noted in Task 3 Step 4, e.g.:
```bash
python tools/blur_faces.py assets/hero_raw.jpg assets/hero.jpg 980,150,260,300
```
(Repeat boxes as needed.) Re-view until no face is identifiable while the scene (two people, phone, app UI) stays legible.

- [ ] **Step 5: Handle the overhead frame**

If Task 3 Step 4 found no identifiable face in the overhead frame, just copy it:
```bash
cp assets/two_phones_raw.jpg assets/two_phones.jpg
```
Otherwise blur it the same way:
```bash
python tools/blur_faces.py assets/two_phones_raw.jpg assets/two_phones.jpg
```
View `assets/two_phones.jpg` to confirm.

- [ ] **Step 6: Commit (only if poster_archive IS_GIT — see Task 1 Step 2)**

```bash
git -C ../poster_archive add poster_a3/tools/blur_faces.py poster_a3/assets/hero.jpg poster_a3/assets/two_phones.jpg
git -C ../poster_archive commit -m "poster(a3): add blurred photos + blur tool"
```

---

### Task 4: Build the poster HTML skeleton (page, identity, logo bar, headline)

**Files:**
- Create: `..\poster_archive\poster_a3\poster.html`

- [ ] **Step 1: Write the document head, A3 page CSS, design tokens, logo bar, and headline block**

Create `..\poster_archive\poster_a3\poster.html`:
```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Editing video, together — A3 poster</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  @page { size: 297mm 420mm; margin: 0; }
  :root{
    --purple:#71619d; --purple-deep:#5a4e80; --purple-deeper:#4a3d6e;
    --tint:#ece9f3; --tint2:#e6e2f0; --ink:#1a1a1a; --muted:#777;
  }
  body{ width:297mm; height:420mm; font-family:'Inter','Helvetica Neue',Arial,sans-serif;
        background:#fff; color:var(--ink); overflow:hidden; }
  .poster{ width:297mm; height:420mm; display:flex; flex-direction:column; padding:14mm 16mm; }

  .logo-bar{ display:flex; align-items:center; gap:10mm; flex-shrink:0; }
  .logo-bar img{ display:block; }
  .logo-bar .ucl{ height:11mm; } .logo-bar .uclic{ height:7mm; } .logo-bar .gdi{ height:14mm; margin-left:auto; }

  .head{ padding:8mm 0 6mm; border-bottom:0.4mm solid #e8e8e8; flex-shrink:0; }
  .kicker{ font-size:5mm; font-weight:700; letter-spacing:.18em; color:var(--purple);
           text-transform:uppercase; margin-bottom:3mm; }
  .head h1{ font-size:20mm; font-weight:800; letter-spacing:-0.03em; line-height:1.02; color:#0a0a0a; }
  .head .sub{ margin-top:4mm; font-size:5.4mm; font-weight:400; color:#555; line-height:1.42; max-width:250mm; }
  .head .sub b{ color:var(--ink); font-weight:600; }
</style>
</head>
<body>
  <div class="poster">

    <div class="logo-bar">
      <img class="ucl"   src="assets/ucl.png"   alt="University College London">
      <img class="uclic" src="assets/uclic.png" alt="UCL Interaction Centre">
      <img class="gdi"   src="assets/gdi.jpg"   alt="Global Disability Innovation Hub">
    </div>

    <header class="head">
      <div class="kicker">For creators with visual impairments</div>
      <h1>Editing video, together.</h1>
      <p class="sub">AI-assisted, collaborative editing that puts <b>creators with visual impairments</b>
      in the director's seat &mdash; directing their helpers and AI, not handing over control.</p>
    </header>

    <!-- SECTIONS ADDED IN LATER TASKS -->

  </div>
</body>
</html>
```

- [ ] **Step 2: View it in a browser at A3 scale (render proof comes in Task 7; quick check now)**

Open the file in any browser (or skip to Task 7's render). Confirm the logo bar shows three logos and the headline block reads correctly with the purple kicker. Fix any broken `src` paths.

- [ ] **Step 3: Commit (only if IS_GIT)**

```bash
git -C ../poster_archive add poster_a3/poster.html
git -C ../poster_archive commit -m "poster(a3): page scaffold, logos, headline block"
```

---

### Task 5: Add hero photo + "the problem" section

**Files:**
- Modify: `..\poster_archive\poster_a3\poster.html`

- [ ] **Step 1: Add CSS for the hero + problem block**

Inside `<style>`, before `</style>`, append:
```css
  .hero{ margin:7mm 0 0; height:120mm; border-radius:4mm; overflow:hidden; flex-shrink:0;
         box-shadow:0 6mm 18mm rgba(40,30,80,.12); }
  .hero img{ width:100%; height:100%; object-fit:cover; object-position:center 30%; display:block; }

  .problem{ padding:7mm 0 0; flex-shrink:0; }
  .problem .line{ font-size:6.4mm; font-weight:700; line-height:1.32; max-width:250mm; }
  .problem .line .hl{ background:var(--tint); color:var(--purple-deep); padding:0.5mm 2.5mm; border-radius:6mm; }
  .quote{ margin-top:5mm; font-size:5.4mm; font-style:italic; color:#333; line-height:1.4;
          border-left:1.4mm solid var(--tint2); padding-left:5mm; }
  .quote cite{ display:block; font-style:normal; font-size:4.2mm; color:var(--muted); margin-top:2mm; }
```

- [ ] **Step 2: Replace the `<!-- SECTIONS ADDED IN LATER TASKS -->` comment with the hero + problem markup**

```html
    <div class="hero"><img src="assets/hero.jpg" alt="A creator with a visual impairment and their sighted helper editing a video together on a phone."></div>

    <section class="problem">
      <p class="line">Making videos is easy. <span class="hl">Editing them isn't</span> &mdash;
      editing is deeply visual, so creators with visual impairments have had to hand control to someone else.</p>
      <blockquote class="quote">&ldquo;I wouldn't trust myself to edit on my own &mdash; I don't have the visual sense.&rdquo;
        <cite>&mdash; Blind creator, Nairobi</cite></blockquote>
    </section>

    <!-- HOW-IT-WORKS ADDED IN TASK 6 -->
```

- [ ] **Step 3: Re-open in browser, confirm hero image fills its band (face blurred) and the problem text + quote render. Commit (if IS_GIT):**

```bash
git -C ../poster_archive add poster_a3/poster.html
git -C ../poster_archive commit -m "poster(a3): hero photo + problem section"
```

---

### Task 6: Add "How it works" (interdependence engine) + "Why it matters" + footer

**Files:**
- Modify: `..\poster_archive\poster_a3\poster.html`

- [ ] **Step 1: Append CSS for steps, the choice triad, the two-phone photo, impact, and footer**

Append before `</style>`:
```css
  .how{ padding:8mm 0 0; flex:1; display:flex; flex-direction:column; }
  .how h2, .why h2{ font-size:6.6mm; font-weight:800; color:var(--purple-deeper); margin-bottom:5mm; }
  .steps{ display:grid; grid-template-columns:1fr 1fr; gap:6mm; }
  .step{ background:var(--tint); border-radius:3mm; padding:5mm 5.5mm; }
  .step .n{ width:8mm; height:8mm; border-radius:50%; background:var(--purple); color:#fff;
            font-weight:800; font-size:4.6mm; display:flex; align-items:center; justify-content:center; margin-bottom:3mm; }
  .step h3{ font-size:5mm; font-weight:700; margin-bottom:2mm; }
  .step p{ font-size:4.2mm; color:#555; line-height:1.4; }
  .step .ex{ margin-top:3mm; font-size:3.8mm; color:var(--purple-deep); background:#fff;
             border-radius:2mm; padding:3mm; line-height:1.4; }
  .triad{ display:flex; gap:3mm; margin-top:3mm; }
  .triad span{ flex:1; text-align:center; font-size:3.9mm; font-weight:700; color:var(--purple-deep);
               background:#fff; border:0.4mm solid var(--tint2); border-radius:2mm; padding:2.5mm 1mm; }
  .step.wide{ grid-column:1 / -1; display:flex; gap:6mm; align-items:center; }
  .step.wide .body{ flex:1; } .step.wide .shot{ flex:1; border-radius:2.5mm; overflow:hidden; }
  .step.wide .shot img{ width:100%; height:46mm; object-fit:cover; display:block; }

  .why{ padding:8mm 0 0; flex-shrink:0; }
  .why .quote{ border-left-color:var(--purple); }
  .impact{ margin-top:4mm; font-size:4.4mm; color:#444; line-height:1.45; }
  .impact b{ color:var(--ink); }

  .foot{ margin-top:auto; padding-top:6mm; border-top:0.4mm solid #e8e8e8;
         display:flex; align-items:center; gap:8mm; flex-shrink:0; }
  .foot img{ height:8mm; } .foot .gdi{ height:11mm; }
  .foot .note{ margin-left:auto; font-size:3.4mm; color:#999; text-align:right; line-height:1.4; max-width:120mm; }
```

- [ ] **Step 2: Replace the `<!-- HOW-IT-WORKS ADDED IN TASK 6 -->` comment with the remaining sections**

```html
    <section class="how">
      <h2>How it works</h2>
      <div class="steps">

        <div class="step">
          <div class="n">1</div>
          <h3>AI describes every scene</h3>
          <p>So the creator knows what's in their own footage &mdash; in as much detail as they want.</p>
          <div class="ex">&ldquo;Musicians sit in a rehearsal room with microphones, instruments, and tangled cables across the floor.&rdquo;</div>
        </div>

        <div class="step">
          <div class="n">2</div>
          <h3>The creator directs</h3>
          <p>On every scene, they choose how much to lean on whom:</p>
          <div class="triad"><span>Edit by myself</span><span>Ask AI</span><span>Ask my helper</span></div>
        </div>

        <div class="step wide">
          <div class="body">
            <div class="n">3</div>
            <h3>Co-edit the same timeline, live</h3>
            <p>Creator and helper work the same video at once, each on their own device &mdash; changes sync in realtime.
            Plain-language edits like <em>&ldquo;rotate scene 2 so the musicians are upright&rdquo;</em> or
            <em>&ldquo;trim the slow opening&rdquo;</em> just work.</p>
          </div>
          <div class="shot"><img src="assets/two_phones.jpg" alt="Two phones side by side, both running the app, during a live co-editing session."></div>
        </div>

        <div class="step">
          <div class="n">4</div>
          <h3>Export the finished video</h3>
          <p>One tap renders a finished MP4, ready to post.</p>
        </div>

        <div class="step">
          <div class="n">★</div>
          <h3>Why it's different</h3>
          <p>Not solo independence &mdash; <b>interdependence</b>. The creator holds the story; AI brings description; the helper brings sight.</p>
        </div>

      </div>
    </section>

    <section class="why">
      <h2>Why it matters</h2>
      <blockquote class="quote">&ldquo;Now you and your helper are more in control &mdash; I have the idea of what's going on and what should be edited.&rdquo;
        <cite>&mdash; Blind creator, Nairobi</cite></blockquote>
      <p class="impact">Built with <b>10 creator&ndash;helper pairs</b> in Nairobi (UCL &times; Senses Hub). Grounded in <b>CHI 2026</b> research on disability collaboration.</p>
    </section>

    <footer class="foot">
      <img class="ucl" src="assets/ucl.png" alt="UCL">
      <img class="uclic" src="assets/uclic.png" alt="UCLIC">
      <img class="gdi" src="assets/gdi.jpg" alt="GDI Hub">
      <span class="note">Session photography used with participants' consent. Faces are blurred and names are not shown.</span>
    </footer>
```

- [ ] **Step 3: Re-open in browser. Confirm all four steps + the ★ panel render, the triad shows three pills, the two-phone photo sits in step 3, and the footer note + logos appear. Commit (if IS_GIT):**

```bash
git -C ../poster_archive add poster_a3/poster.html
git -C ../poster_archive commit -m "poster(a3): how-it-works, why-it-matters, footer"
```

---

### Task 7: Render to PDF + PNG proof and verify fit

**Files:**
- Create: `..\poster_archive\poster_a3\package.json`, `..\poster_archive\poster_a3\tools\render.mjs`
- Output: `poster_a3.pdf`, `poster_a3.proof.png`

- [ ] **Step 1: Write package.json**

Create `..\poster_archive\poster_a3\package.json`:
```json
{
  "name": "poster-a3",
  "private": true,
  "type": "module",
  "scripts": { "render": "node tools/render.mjs" },
  "devDependencies": { "playwright": "^1.48.0" }
}
```

- [ ] **Step 2: Write the render script**

Create `..\poster_archive\poster_a3\tools\render.mjs`:
```javascript
import { chromium } from 'playwright';
import { pathToFileURL } from 'url';
import { resolve } from 'path';

const html = pathToFileURL(resolve('poster.html')).href;
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(html, { waitUntil: 'networkidle' });
// PNG proof at ~150 dpi (A3 = 297x420mm -> 1754x2480 px @150dpi)
await page.setViewportSize({ width: 1754, height: 2480 });
await page.screenshot({ path: 'poster_a3.proof.png' });
// Print-ready PDF at true A3
await page.pdf({ path: 'poster_a3.pdf', width: '297mm', height: '420mm',
                 printBackground: true, pageRanges: '1' });
await browser.close();
console.log('wrote poster_a3.pdf and poster_a3.proof.png');
```

- [ ] **Step 3: Install Playwright + chromium and render**

Run:
```bash
cd "../poster_archive/poster_a3"
npm install
npx playwright install chromium
npm run render
```
Expected: `wrote poster_a3.pdf and poster_a3.proof.png`.

- [ ] **Step 4: Verify the PDF is a single A3 page**

Run:
```bash
ls -la poster_a3.pdf poster_a3.proof.png
```
Expected: both files exist and are non-trivial in size (PDF > 200 KB given embedded photos).

- [ ] **Step 5: View the PNG proof and check the whole poster**

Use Read on `poster_a3.proof.png`. Confirm against the spec:
- Nothing overflows or is clipped at the page edges; content is not crammed (roughly 30–40% white space).
- Reading order top→bottom: logos → headline → hero → problem → how-it-works → why → footer.
- Both photos show **blurred faces**.
- The interdependence triad (`Edit by myself · Ask AI · Ask my helper`) is clearly the centerpiece of step 2.
- No participant names anywhere; footer consent note present.

If anything overflows the single A3 page, reduce the relevant `mm` sizes (hero height, step padding, font sizes) and re-run `npm run render`. Iterate until the proof is clean.

- [ ] **Step 6: Send the proof to the user and commit (if IS_GIT)**

Send `poster_a3.proof.png` to the user with SendUserFile for sign-off. Then:
```bash
git -C ../poster_archive add poster_a3/package.json poster_a3/tools/render.mjs poster_a3/poster_a3.pdf poster_a3/poster_a3.proof.png
git -C ../poster_archive commit -m "poster(a3): render pipeline + final PDF/proof"
```

---

## Self-Review notes

- **Spec coverage:** format/identity (Task 4), narrative order incl. headline+kicker, hero, problem, how-it-works triad, why, footer (Tasks 4–6), both photos at print quality (Task 2), **face blur** (Task 3), no QR / no names / VI wording (Tasks 4–6), PDF output (Task 7). All spec sections map to a task.
- **No placeholders:** all HTML/CSS/JS/Python shown in full; face-box coordinates are obtained by an explicit view-and-measure step (Task 3 Step 4) feeding a concrete command.
- **Consistency:** asset filenames (`hero.jpg`, `two_phones.jpg`, `ucl.png`, `uclic.png`, `gdi.jpg`) and class names are identical across Tasks 4–7; render outputs named consistently.
