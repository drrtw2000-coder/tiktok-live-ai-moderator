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
# Default (merge): BANNED = DEFAULT_BANNED | {env words}. Set
# BANNED_REPLACE=1 to replace defaults entirely instead of merging.
DEFAULT_BANNED = frozenset({
    "idiot", "stupid", "dumbass", "moron", "loser", "hateyou",
    "shutup", "worthless", "nobodylikesyou", "kys", "killyourself",
})

_env_words = [w.strip().lower() for w in os.getenv("BANNED_WORDS", "").split(",") if w.strip()]
_replace = (os.getenv("BANNED_REPLACE", "0") or "0").strip().lower() \
    not in ("0", "false", "no", "off", "")
if _replace and _env_words:
    BANNED = frozenset(_env_words)
else:
    BANNED = frozenset(DEFAULT_BANNED | frozenset(_env_words))

# Short tokens (<=4 chars, e.g. "kys") MUST match on word boundaries —
# substring matching false-positives ("turkeys"). Precompile boundary
# regexes once; long tokens keep substring matching on both forms.
_SHORT_RE: dict[str, "re.Pattern"] = {}
for _w in BANNED:
    if len(_w) <= 4:
        try:
            _SHORT_RE[_w] = re.compile(r"\b" + re.escape(_w) + r"\b")
        except re.error:
            pass

# --- stub AI (stands in for Perspective / omni-moderation until wired) ---
_THREAT = re.compile(r"\b(kill|murder|stab|shoot|attack|hurt|beat up|rape|dox)\b", re.I)
_INSULT = re.compile(r"\b(idiot|stupid|dumb|moron|loser|ugly|worthless|hate you|shut up)\b", re.I)
_SEXUAL = re.compile(r"\b(horny|nudes?|onlyfans|porn|dick|pussy|camgirl)\b", re.I)
_SELFHARM = re.compile(r"(kill myself|suicide|end my life|self.?harm|cut myself)", re.I)

AI_PROVIDER = os.getenv("AI_PROVIDER", "stub").lower()

def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (ValueError, TypeError):
        return default

AI_THRESHOLD = _env_float("AI_THRESHOLD", 0.7)
AI_FLAG = _env_float("AI_FLAG", 0.4)

# --- per-user flood gate: 6 msgs / 10 s (monotonic: immune to NTP jumps) ---
RATE_MAX, RATE_WINDOW = 6, 10.0
import threading as _th
_hits: dict[str, deque] = defaultdict(deque)
_hits_lock = _th.Lock()


def normalize(text: str) -> tuple[str, str]:
    t = text.lower()
    t = "".join(_LEET.get(ch, ch) for ch in t)
    t = unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode()
    t = _REPEATS.sub(r"\1", t)
    return t, _NONALNUM.sub("", t)


def _wordlist_hit(text_n: str, nospace: str) -> str | None:
    """Boundary-safe wordlist match.

    Short tokens use \\b boundaries on the normalized spaced form
    (kills 'kys'-in-'turkeys' false positives). Long tokens match as
    substrings on either form (catches 'killyourself', spacing/leet)."""
    for w in BANNED:
        if not w:
            continue
        if len(w) <= 4:
            pat = _SHORT_RE.get(w)
            if pat is not None:
                if pat.search(text_n):
                    return w
                continue
            # Fallback if regex failed to compile: padded substring.
            if w in text_n.split():
                return w
        elif w in text_n or w in nospace:
            return w
    return None


def _flooded(user_id: str) -> bool:
    now = time.monotonic()
    with _hits_lock:
        dq = _hits[user_id]
        while dq and now - dq[0] > RATE_WINDOW:
            dq.popleft()
        dq.append(now)
        crowded = len(dq) > RATE_MAX
        # Memory cap: evict idlest users (same policy as HTTP rate limiter).
        if len(_hits) > 5000:
            for k in [k for k, v in _hits.items()
                      if not v or now - v[-1] > RATE_WINDOW * 10][:1000]:
                _hits.pop(k, None)
        return crowded


def stub_ai(text: str) -> tuple[str, float]:
    """Regex stand-in for Perspective/omni. Expects NORMALIZED text.

    Callers must pass normalize(text)[0] so leet/padding/homoglyphs
    ('k1ll', 's t u p i d') are caught. Regexes stay case-insensitive
    so raw text still works in a pinch, but normalized is authoritative."""
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
    """Deterministic checks. Verdict dict, or None to defer to AI.

    Policy (explicit): moderators bypass link/flood/spam/caps heuristics
    but are still held to the wordlist + AI layers (compromised-mod
    safety). Gifts/follows/shares/etc. always passthrough (never
    classified, never flood-counted)."""
    if (meta.get("eventType") or "comment") != "comment":
        return None  # gifts/follows/shares/etc. always pass through

    text_n, nospace = normalize(text)
    hit = _wordlist_hit(text_n, nospace)
    if hit:
        return {"allowed": False, "verdict": f"wordlist",
                "score": 0.95, "source": "local", "severity": "red"}
    if meta.get("isModerator") is True:
        return None  # mods skip link/flood/spam/caps only (wordlist/AI still apply)

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

        # AI sees NORMALIZED text so leet/padding/homoglyph evasions
        # ('k1ll', 's t u p i d') still match. Check both spaced + nospace
        # forms and keep the hotter score (spaced insults hide from \b).
        # Swap for Perspective/omni later.
        text_n, nospace = normalize(text)
        label, score = stub_ai(text_n)
        if nospace and nospace != text_n:
            label2, score2 = stub_ai(nospace)
            if score2 > score:
                label, score = label2, score2
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

