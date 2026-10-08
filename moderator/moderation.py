"""moderation.py - local rules + stub AI classifier (stdlib only).

Input:  TikTokComment dict {id, userId, username, text, timestamp, meta}
Output: {allowed, verdict, score, source, severity}

Severity: green = clean, yellow = allowed-but-flagged, red = blocked.
"""
import os
import re
import time
import unicodedata
from collections import defaultdict, deque

LINK_RE = re.compile(
    r"https?://|www\.|t\.me/|discord\.gg|bit\.ly|tinyurl\.com", re.IGNORECASE
)

_LEET = {
    "0": "o", "1": "i", "3": "e", "4": "a", "5": "s",
    "7": "t", "8": "b", "@": "a", "$": "s", "+": "t",
    "!": "i", "|": "i",
}
_REPEATS = re.compile(r"(.)\1{2,}")
_NONALNUM = re.compile(r"[^a-z0-9]")

# Detection patterns only (never emitted). Extend via BANNED_WORDS env.
DEFAULT_BANNED = frozenset({
    "idiot", "stupid", "dumbass", "moron", "loser", "hateyou",
    "shutup", "worthless", "nobodylikesyou", "kys", "killyourself",
})

_env_words = [w.strip().lower() for w in os.getenv("BANNED_WORDS", "").split(",") if w.strip()]
BANNED = frozenset(_env_words) if _env_words else DEFAULT_BANNED

# --- stub AI (stands in for Perspective / omni-moderation until wired) ---
_THREAT = re.compile(r"\b(kill|murder|stab|shoot|attack|hurt|beat up|rape|dox)\b", re.I)
_INSULT = re.compile(r"\b(idiot|stupid|dumb|moron|loser|ugly|worthless|hate you|shut up)\b", re.I)
_SEXUAL = re.compile(r"\b(horny|nudes?|onlyfans|porn|dick|pussy|camgirl)\b", re.I)
_SELFHARM = re.compile(r"(kill myself|suicide|end my life|self.?harm|cut myself)", re.I)

AI_PROVIDER = os.getenv("AI_PROVIDER", "stub").lower()
AI_THRESHOLD = float(os.getenv("AI_THRESHOLD", "0.7"))
AI_FLAG = float(os.getenv("AI_FLAG", "0.4"))

# --- per-user flood gate: 6 msgs / 10 s ---
RATE_MAX, RATE_WINDOW = 6, 10.0
_hits: dict[str, deque] = defaultdict(deque)


def normalize(text: str) -> tuple[str, str]:
    t = text.lower()
    t = "".join(_LEET.get(ch, ch) for ch in t)
    t = unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode()
    t = _REPEATS.sub(r"\1", t)
    return t, _NONALNUM.sub("", t)


def _wordlist_hit(text_n: str, nospace: str) -> str | None:
    for w in BANNED:
        if w and (w in text_n or w in nospace):
            return w
    return None


def _flooded(user_id: str) -> bool:
    now = time.time()
    dq = _hits[user_id]
    while dq and now - dq[0] > RATE_WINDOW:
        dq.popleft()
    dq.append(now)
    return len(dq) > RATE_MAX


def stub_ai(text: str) -> tuple[str, float]:
    if _SELFHARM.search(text):
        return ("selfharm", 0.95)
    if _THREAT.search(text):
        return ("threat", 0.9)
    if _SEXUAL.search(text):
        return ("sexual", 0.85)
    if _INSULT.search(text):
        return ("insult", 0.75)
    if len(text) > 350:
        return ("wall", 0.6)
    return ("ok", 0.05)

def local_rules(user_id: str, text: str, meta: dict) -> dict | None:
    """Deterministic checks. Verdict dict, or None to defer to AI."""
    if (meta.get("eventType") or "comment") != "comment":
        return None  # gifts/follows/shares/etc. always pass through

    text_n, nospace = normalize(text)
    hit = _wordlist_hit(text_n, nospace)
    if hit:
        return {"allowed": False, "verdict": f"wordlist",
                "score": 0.95, "source": "local", "severity": "red"}
    if meta.get("isModerator") is True:
        return None  # mods skip spam heuristics only

    if LINK_RE.search(text):
        return {"allowed": False, "verdict": "link",
                "score": 0.9, "source": "local", "severity": "red"}
    if _flooded(user_id):
        return {"allowed": False, "verdict": "flood",
                "score": 0.9, "source": "local", "severity": "red"}
    if len(text) > 200 or text.count("!") > 8:
        return {"allowed": True, "verdict": "spam", "flagged": True,
                "score": 0.8, "source": "local", "severity": "yellow"}
    letters = [c for c in text if c.isalpha()]
    if len(text) > 12 and len(letters) >= 8 and \
            sum(c.isupper() for c in letters) / len(letters) > 0.7:
        return {"allowed": True, "verdict": "caps", "flagged": True,
                "score": 0.6, "source": "local", "severity": "yellow"}
    return None


def moderate_comment(comment: dict) -> dict:
    """Full pipeline: passthrough -> local rules -> AI. Never raises."""
    try:
        meta = comment.get("meta") or {}
        user_id = comment.get("userId", "unknown")
        text = comment.get("text", "") or ""
        if (meta.get("eventType") or "comment") != "comment":
            return {"allowed": True, "verdict": "passthrough",
                    "score": 0.0, "source": "passthrough", "severity": "green"}

        verdict = local_rules(user_id, text, meta)
        if verdict is not None:
            return verdict

        if AI_PROVIDER == "off" or not text.strip():
            return {"allowed": True, "verdict": "ok",
                    "score": 0.0, "source": "local", "severity": "green"}

        label, score = stub_ai(text)  # swap for Perspective/omni later
        if score >= AI_THRESHOLD:
            return {"allowed": False, "verdict": label,
                    "score": score, "source": "ai-stub", "severity": "red"}
        if score >= AI_FLAG:
            return {"allowed": True, "verdict": label, "flagged": True,
                    "score": score, "source": "ai-stub", "severity": "yellow"}
        return {"allowed": True, "verdict": "ok",
                "score": score, "source": "ai-stub", "severity": "green"}
    except Exception as e:  # fail-open: a filter outage must never silence chat
        print(f"[moderation] ERROR (fail-open): {e}", flush=True)
        return {"allowed": True, "verdict": "error-failopen",
                "score": 0.0, "source": "local", "severity": "green"}

