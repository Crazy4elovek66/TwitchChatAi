import sys, json, base64, traceback
from vosk import Model, KaldiRecognizer, SetLogLevel

SetLogLevel(-1)

model = None
rec = None
sample_rate = 16000


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def init_worker(model_path: str, sr: int):
    global model, rec, sample_rate
    sample_rate = int(sr)
    model = Model(model_path)
    rec = KaldiRecognizer(model, sample_rate)


def reset_recognizer():
    global rec
    if model is None:
        return
    rec = KaldiRecognizer(model, sample_rate)


def handle(msg):
    global rec
    t = msg.get("type")
    req_id = msg.get("id")

    if t == "init":
        init_worker(msg["model_path"], msg.get("sample_rate", 16000))
        return {"type": "inited", "id": req_id, "ok": True, "sample_rate": sample_rate}

    if model is None or rec is None:
        return {
            "type": "error",
            "id": req_id,
            "error": "Worker not initialized. Send {type:init} first.",
        }

    if t == "reset":
        reset_recognizer()
        return {"type": "reset_ok", "id": req_id, "ok": True}

    if t == "transcribe":
        audio_b64 = msg.get("audio_b64", "")
        is_final = bool(msg.get("final", False))
        if not audio_b64:
            return {
                "type": "result",
                "id": req_id,
                "text": "",
                "final": is_final,
                "empty": True,
            }

        pcm = base64.b64decode(audio_b64)

        if rec.AcceptWaveform(pcm):
            res = json.loads(rec.Result())
            text = (res.get("text") or "").strip()
            return {
                "type": "result",
                "id": req_id,
                "text": text,
                "final": True,
                "raw": res,
            }
        else:
            pres = json.loads(rec.PartialResult())
            ptext = (pres.get("partial") or "").strip()
            if is_final:
                fres = json.loads(rec.FinalResult())
                ftext = (fres.get("text") or "").strip()
                return {
                    "type": "result",
                    "id": req_id,
                    "text": ftext,
                    "final": True,
                    "raw": fres,
                }
            return {
                "type": "partial",
                "id": req_id,
                "text": ptext,
                "final": False,
                "raw": pres,
            }

    return {"type": "error", "id": req_id, "error": f"Unknown type: {t}"}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            send(handle(msg))
        except Exception as e:
            send(
                {
                    "type": "error",
                    "id": None,
                    "error": str(e),
                    "trace": traceback.format_exc(),
                }
            )


if __name__ == "__main__":
    main()
