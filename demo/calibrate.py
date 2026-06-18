import json, subprocess, sys, wave, struct, tempfile
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
    vid = F_ROOT / s.get("videoAngles", [s["video"]])[0]
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
