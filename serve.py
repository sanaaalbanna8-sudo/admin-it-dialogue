"""خادم المواجهة الرقمية: الشاشة الكبيرة + تصويت الطلاب بأسلوب كاهوت."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import json
import socket
import time
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
VOTES = {}
ACTIVE = None
SHOW = {"slide": 0, "widgets": {}}
PIN = "4826"
SECONDS = 12


def now_ms():
    return int(time.time() * 1000)


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def box_of(qid):
    return VOTES.setdefault(qid, {"counts": {}, "voters": set()})


def refresh_active():
    global ACTIVE
    if not ACTIVE:
        return
    if ACTIVE.get("armed") and not ACTIVE.get("open"):
        return
    if now_ms() >= int(ACTIVE.get("until") or 0):
        ACTIVE["open"] = False
        ACTIVE["armed"] = False


def is_armed(box=None):
    target = box if box is not None else ACTIVE
    return bool(target and target.get("armed") and not target.get("open"))


def snapshot():
    refresh_active()
    counts = {}
    total = 0
    remaining = 0
    if ACTIVE:
        box = box_of(ACTIVE["id"])
        counts = box["counts"]
        total = sum(counts.values())
        if ACTIVE.get("open"):
            remaining = max(0, int((ACTIVE.get("until") or 0) - now_ms()) // 1000)
    return {
        "ok": True,
        "pin": PIN,
        "active": ACTIVE,
        "counts": counts,
        "total": total,
        "remaining": remaining,
        "open": bool(ACTIVE and ACTIVE.get("open")),
        "armed": is_armed(),
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _json(self, code, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        if parsed.path == "/api/state":
            self._json(200, snapshot())
            return
        if parsed.path == "/api/show":
            self._json(200, {"ok": True, **SHOW})
            return
        if parsed.path == "/api/results":
            refresh_active()
            qid = (qs.get("q") or [""])[0]
            box = VOTES.get(qid, {"counts": {}})
            remaining = 0
            opened = False
            armed = False
            if ACTIVE and ACTIVE.get("id") == qid:
                opened = bool(ACTIVE.get("open"))
                armed = is_armed()
                if opened:
                    remaining = max(0, int((ACTIVE.get("until") or 0) - now_ms()) // 1000)
            self._json(200, {
                "ok": True,
                "counts": box["counts"],
                "total": sum(box["counts"].values()),
                "remaining": remaining,
                "open": opened,
                "armed": armed,
            })
            return
        super().do_GET()

    def do_POST(self):
        global ACTIVE, PIN, SECONDS
        parsed = urlparse(self.path)
        body = self._read_json()
        if parsed.path == "/api/goto":
            SHOW["slide"] = int(body.get("slide") or 0)
            if isinstance(body.get("widgets"), dict):
                SHOW["widgets"] = body["widgets"]
            elif body.get("widgets"):
                try:
                    SHOW["widgets"] = json.loads(body["widgets"])
                except json.JSONDecodeError:
                    pass
            self._json(200, {"ok": True, **SHOW})
            return
        if parsed.path == "/api/arm":
            poll = body.get("poll") or body
            if not poll.get("id") or not poll.get("options"):
                self._json(400, {"ok": False})
                return
            VOTES.pop(str(poll["id"]), None)
            ACTIVE = {
                "id": str(poll["id"]),
                "q": str(poll.get("q") or ""),
                "options": [str(x) for x in poll["options"]],
                "open": False,
                "armed": True,
                "until": 0,
            }
            if body.get("pin"):
                PIN = str(body["pin"])
            self._json(200, snapshot())
            return
        if parsed.path == "/api/open":
            poll = body.get("poll") or body
            if not poll.get("id") or not poll.get("options"):
                self._json(400, {"ok": False})
                return
            seconds = int(body.get("seconds") or SECONDS)
            SECONDS = seconds
            VOTES.pop(str(poll["id"]), None)
            ACTIVE = {
                "id": str(poll["id"]),
                "q": str(poll.get("q") or ""),
                "options": [str(x) for x in poll["options"]],
                "open": True,
                "armed": False,
                "until": now_ms() + seconds * 1000,
            }
            if body.get("pin"):
                PIN = str(body["pin"])
            self._json(200, snapshot())
            return
        if parsed.path == "/api/clear":
            ACTIVE = None
            self._json(200, snapshot())
            return
        if parsed.path == "/api/close":
            if ACTIVE:
                ACTIVE["open"] = False
                ACTIVE["armed"] = False
                ACTIVE["until"] = now_ms()
            self._json(200, snapshot())
            return
        if parsed.path == "/api/reset":
            qid = str(body.get("q") or "")
            if qid:
                VOTES.pop(qid, None)
            else:
                VOTES.clear()
            self._json(200, snapshot())
            return
        if parsed.path != "/api/vote":
            self.send_error(404)
            return
        refresh_active()
        qid = str(body.get("q") or "")
        choice = str(body.get("choice") or "")
        voter = str(body.get("voter") or "")
        if not qid or not choice or not voter:
            self._json(400, {"ok": False})
            return
        if not ACTIVE or ACTIVE["id"] != qid or not ACTIVE.get("open") or choice not in ACTIVE["options"]:
            self._json(400, {"ok": False, "err": "closed"})
            return
        box = box_of(qid)
        if voter in box["voters"]:
            self._json(200, {"ok": True, "dup": True, "counts": box["counts"], "total": sum(box["counts"].values())})
            return
        box["voters"].add(voter)
        box["counts"][choice] = box["counts"].get(choice, 0) + 1
        self._json(200, {"ok": True, "counts": box["counts"], "total": sum(box["counts"].values())})


if __name__ == "__main__":
    port = 8780
    ip = lan_ip()
    print("مواجهة رقمية: بين لغة الإدارة.. ولغة الأكواد")
    print(f"الشاشة الكبيرة:  http://{ip}:{port}/")
    print(f"قيادة الجلسة:    http://{ip}:{port}/?host=1")
    print(f"تصويت الطلاب:   http://{ip}:{port}/vote.html")
    print("QR at start only. Each question stays open 12 seconds.")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
