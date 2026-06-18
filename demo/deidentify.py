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

def cluster_regions(boxes, W, H):
    groups = {"L": [], "R": []}
    for (x, y, w, h) in boxes:
        groups["L" if (x + w / 2) < W / 2 else "R"].append((x, y, w, h))
    regions = []
    for g in groups.values():
        if len(g) < 2:   # need a few detections to trust a seat region
            continue
        x0 = min(b[0] for b in g); y0 = min(b[1] for b in g)
        x1 = max(b[0] + b[2] for b in g); y1 = max(b[1] + b[3] for b in g)
        bw, bh = x1 - x0, y1 - y0
        px, py = int(0.5 * bw), int(0.6 * bh)
        regions.append((max(0, x0 - px), max(0, y0 - py), min(W, x1 + px), min(H, y1 + py)))
    return regions

def blur_region(frame, r, W, H):
    x0, y0, x1, y1 = r
    x0, y0 = max(0, x0), max(0, y0); x1, y1 = min(W, x1), min(H, y1)
    if x1 <= x0 or y1 <= y0: return
    roi = frame[y0:y1, x0:x1]
    if roi.size == 0: return
    # Heavy mosaic: collapse to ~ (region/28) blocks, then nearest-upscale.
    small = cv2.resize(roi, (max(1, (x1 - x0) // 28), max(1, (y1 - y0) // 28)))
    pix = cv2.resize(small, (x1 - x0, y1 - y0), interpolation=cv2.INTER_NEAREST)
    # Strong Gaussian scaled to region width so close-ups get heavier smoothing.
    sigma = max(12, (x1 - x0) // 25)
    frame[y0:y1, x0:x1] = cv2.GaussianBlur(pix, (0, 0), sigma)

def process(clip_id):
    src = CLIPS / f"{clip_id}.raw.mp4"
    cap = cv2.VideoCapture(str(src))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    # Pass 1: collect all detections.
    yunet = make_yunet(W, H); all_boxes = []
    while True:
        ok, frame = cap.read()
        if not ok: break
        all_boxes += detect_frame(frame, yunet)
    cap.release()
    regions = cluster_regions(all_boxes, W, H)
    # Pass 2: blur seat regions + live detections.
    yunet = make_yunet(W, H)
    cap = cv2.VideoCapture(str(src))
    tmp = CLIPS / f"{clip_id}.deid.tmp.mp4"
    vw = cv2.VideoWriter(str(tmp), cv2.VideoWriter_fourcc(*"mp4v"), fps, (W, H))
    frames, samples = 0, []
    while True:
        ok, frame = cap.read()
        if not ok: break
        for r in regions: blur_region(frame, r, W, H)
        for (x, y, w, h) in detect_frame(frame, yunet):
            px, py = int(0.45 * w), int(0.55 * h)
            blur_region(frame, (x - px, y - py, x + w + px, y + h + py), W, H)
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
    print(f"deid {clip_id}: {frames} frames, {len(all_boxes)} dets, {len(regions)} seat-regions -> {out.name}")

if __name__ == "__main__":
    ensure_model()
    ids = sys.argv[1:] or sorted({p.name[:-8] for p in CLIPS.glob('*.raw.mp4')})
    for cid in ids:
        process(cid)
