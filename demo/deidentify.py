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
        # cv2.imwrite silently fails on Windows paths with non-ASCII characters;
        # use imencode + write_bytes as a portable workaround.
        ok2, buf = cv2.imencode(".jpg", grid)
        if ok2:
            (CLIPS / f"{clip_id}.contact.jpg").write_bytes(buf.tobytes())
    print(f"deid {clip_id}: {frames} frames -> {out.name}")

if __name__ == "__main__":
    ids = sys.argv[1:]
    if not ids:
        ids = sorted({p.stem.replace('.raw','') for p in CLIPS.glob('*.raw.mp4')})
    for cid in ids:
        process(cid)
