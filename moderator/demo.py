"""demo.py - inject scripted events so you can see the overlays without going live.

Usage (moderator already running on :3002):
  py demo.py [base_url] [api_token]
  py demo.py http://localhost:3002 changeme-use-same-value-in-bridge-env
"""
import json
import os
import sys
import time
import urllib.request


def _load_dotenv(path: str) -> None:
    """Minimal stdlib .env loader (same contract as server.py)."""
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key, val = key.strip(), val.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = val
    except FileNotFoundError:
        pass


_load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3002"
# Windows + urllib: "localhost" costs ~2 s per call (IPv6/DNS fallback). Force IPv4.
if "//localhost" in BASE:
    BASE = BASE.replace("//localhost", "//127.0.0.1")
TOKEN = sys.argv[2] if len(sys.argv) > 2 else os.getenv("API_TOKEN", "")
T = lambda: int(time.time() * 1000)

SCRIPT = [
    ("mia", "hellooo everyone!! first time here", "comment", {}),
    ("leo", "this stream is awesome, love the energy", "comment", {}),
    ("mia", "HOW DO I TURN UP THE VOLUME???", "comment", {}),
    ("spammy", "CHECK MY PROFILE http://bit.ly/freegifts NOW!!!!", "comment", {}),
    ("troll99", "you are so 5tup1d lol", "comment", {}),   # leetspeak evasion test
    ("troll99", "everyone shut up, this sucks", "comment", {}),
    ("rose_fan", "[GIFT] @rose_fan sent Rose x5 (25)", "gift",
     {"eventType": "gift", "giftName": "Rose", "giftRepeatCount": 5, "giftValue": 25}),
    ("newbie", "[FOLLOW] @newbie followed", "follow", {"eventType": "follow"}),
    ("curious", "[QUESTION] @curious asks: what time do you go live?", "question", {"eventType": "question"}),
    ("bigal", "[GIFT] @bigal sent Galaxy x1 (1000)", "gift",
     {"eventType": "gift", "giftName": "Galaxy", "giftRepeatCount": 1,
      "giftValue": 1000, "topGifterRank": 1}),
    ("mod_sam", "welcome in guys, keep it friendly please", "comment", {"isModerator": True}),
    ("flooder", "hi", "comment", {}),
    ("flooder", "hi", "comment", {}),
    ("flooder", "hi", "comment", {}),
    ("flooder", "hi", "comment", {}),
    ("flooder", "hi", "comment", {}),
    ("flooder", "hi", "comment", {}),
    ("flooder", "hi", "comment", {}),   # 7th in <10 s -> flood verdict
]


def post(path, payload):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        BASE + path, data=body,
        headers={"Content-Type": "application/json",
                 **({"x-api-token": TOKEN} if TOKEN else {})},
        method="POST")
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read().decode())


for i, (user, text, kind, meta) in enumerate(SCRIPT):
    comment = {"id": f"demo-{int(time.time()*1000)}-{i}", "userId": user, "username": user,
               "text": text, "timestamp": T(), "meta": meta or {"eventType": "comment"}}
    try:
        res = post("/api/comment", comment)
        v = res.get("verdict", {})
        mark = "ALLOW " if v.get("allowed") else "BLOCK "
        print(f"{mark} [{v.get('severity','?'):6}] {user}: {text[:60]} -> {v.get('verdict')}")
    except Exception as e:
        print(f"ERROR posting {user}: {e}")
    time.sleep(0.7)

print("\nDone. Open the overlay + mod console to see the result.")
