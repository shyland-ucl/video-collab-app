import sys, subprocess, urllib.request, shutil, tempfile
from pathlib import Path
import cv2, numpy as np

DEMO = Path(__file__).resolve().parent
CLIPS = DEMO / "out" / "clips"
MODELS = DEMO / "models"; MODELS.mkdir(exist_ok=True)
YUNET = MODELS / "face_detection_yunet_2023mar.onnx"
YUNET_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
HAAR = [cv2.CascadeClassifier(cv2.data.haarcascades + n) for n in
        ("haarcascade_frontalface_default.xml", "haarcascade_profileface.xml")]

# cv2.dnn (C++ backend) cannot handle non-ASCII paths on Windows.
# Copy the model to a guaranteed ASCII-safe temp location once per run.
_YUNET_ASCII = Path(tempfile.gettempdir()) / "yunet_2023mar.onnx"

# --- Blur tuning (v2: small, FACE-ONLY region) --------------------------------
# The user wants ONLY the face area obscured (a small blur is fine) and the
# device/phone screen left sharp — so there is no clip-wide "seat region" union
# any more. We blur a tight box around each *detected* face, and carry a face
# forward for a few frames so a momentary detection dropout doesn't flash it.
PAD_X = 0.16          # horizontal padding as a fraction of the face box width
PAD_Y_TOP = 0.30      # extra above the box (hair/forehead/cap)
PAD_Y_BOTTOM = 0.12   # a little below (chin)
MEMORY_FRAMES = 8     # keep a face blurred this many frames after it's lost
MOSAIC_DIV = 12       # block size = region / this  (smaller div = chunkier)

def ensure_model():
    if not YUNET.exists():
        print("downloading YuNet model ...")
        urllib.request.urlretrieve(YUNET_URL, str(YUNET))
    # Always refresh the ASCII-path copy so it stays in sync.
    shutil.copy2(str(YUNET), str(_YUNET_ASCII))

def make_yunet(W, H):
    return cv2.FaceDetectorYN.create(str(_YUNET_ASCII), "", (W, H),
                                     score_threshold=0.4, nms_threshold=0.3, top_k=50)

def detect_frame(frame, yunet):
    out = []
    _, faces = yunet.detect(frame)
    if faces is not None:
        for f in faces:
            x, y, w, h = [int(v) for v in f[:4]]
            out.append((x, y, w, h))
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    for det in HAAR:
        for (x, y, w, h) in det.detectMultiScale(gray, 1.2, 4, minSize=(40, 40)):
            out.append((int(x), int(y), int(w), int(h)))
    return out

def face_to_region(box, W, H):
    """A tight blur rectangle around a single detected face box."""
    x, y, w, h = box
    px = int(PAD_X * w)
    pty = int(PAD_Y_TOP * h)
    pby = int(PAD_Y_BOTTOM * h)
    x0 = max(0, x - px); y0 = max(0, y - pty)
    x1 = min(W, x + w + px); y1 = min(H, y + h + pby)
    return (x0, y0, x1, y1)

def blur_region(frame, r, W, H):
    x0, y0, x1, y1 = r
    x0, y0 = max(0, x0), max(0, y0); x1, y1 = min(W, x1), min(H, y1)
    if x1 <= x0 or y1 <= y0: return
    roi = frame[y0:y1, x0:x1]
    if roi.size == 0: return
    # Pixelate to ~ (region / MOSAIC_DIV) blocks, nearest-upscale, then a light
    # Gaussian to smooth block edges. Enough to de-identify; kept modest in size.
    small = cv2.resize(roi, (max(1, (x1 - x0) // MOSAIC_DIV), max(1, (y1 - y0) // MOSAIC_DIV)))
    pix = cv2.resize(small, (x1 - x0, y1 - y0), interpolation=cv2.INTER_NEAREST)
    sigma = max(6, (x1 - x0) // 40)
    frame[y0:y1, x0:x1] = cv2.GaussianBlur(pix, (0, 0), sigma)

def process(clip_id):
    src = CLIPS / f"{clip_id}.raw.mp4"
    cap = cv2.VideoCapture(str(src))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    yunet = make_yunet(W, H)
    tmp = CLIPS / f"{clip_id}.deid.tmp.mp4"
    vw = cv2.VideoWriter(str(tmp), cv2.VideoWriter_fourcc(*"mp4v"), fps, (W, H))
    # Short-memory carry-forward: list of [region, frames_left].
    recent = []
    frames, samples, det_total = 0, [], 0
    while True:
        ok, frame = cap.read()
        if not ok: break
        boxes = detect_frame(frame, yunet)
        det_total += len(boxes)
        # Age existing memories; refresh / add current detections.
        recent = [[r, n - 1] for (r, n) in recent if n - 1 > 0]
        for b in boxes:
            recent.append([face_to_region(b, W, H), MEMORY_FRAMES])
        for (r, _n) in recent:
            blur_region(frame, r, W, H)
        vw.write(frame)
        if frames % 15 == 0: samples.append(cv2.resize(frame, (320, 180)))
        frames += 1
    cap.release(); vw.release()
    out = CLIPS / f"{clip_id}.deid.mp4"
    subprocess.run(["ffmpeg","-y","-v","error","-i",str(tmp),"-c:v","libx264",
                    "-crf","18","-pix_fmt","yuv420p",str(out)], check=True)
    tmp.unlink(missing_ok=True)
    if samples:
        cols = 6; rows = (len(samples) + cols - 1) // cols
        grid = np.zeros((rows * 180, cols * 320, 3), np.uint8)
        for i, s in enumerate(samples):
            r, c = divmod(i, cols); grid[r*180:(r+1)*180, c*320:(c+1)*320] = s
        ok, buf = cv2.imencode(".jpg", grid)
        (CLIPS / f"{clip_id}.contact.jpg").write_bytes(buf.tobytes())
    print(f"deid {clip_id}: {frames} frames, {det_total} face dets -> {out.name}")

if __name__ == "__main__":
    ensure_model()
    ids = sys.argv[1:] or sorted({p.name[:-8] for p in CLIPS.glob('*.raw.mp4')})
    for cid in ids:
        process(cid)
