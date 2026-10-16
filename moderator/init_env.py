"""init_env.py - give this install real secrets (N1 fix). Safe to run on every launch.

The repo's .env.example files ship the SAME public placeholder for every token,
so any install that kept it authenticates with a credential printed in a public
repo. This script replaces only WEAK values (empty, under 16 chars, or a
`changeme...` placeholder - the same rule as server._weak_token) with
secrets.token_hex(32):

  moderator/.env  API_TOKEN, MOD_TOKEN   (MOD_TOKEN gets its own secret)
  upstream/.env   API_TOKEN, TTLIVE_API_TOKEN
                  (kept equal to the moderator's API_TOKEN: the bridge is
                  fail-closed on a mismatch; TTLIVE_API_TOKEN is only touched
                  when the line exists, since the bridge falls back to API_TOKEN)

Strong values are never changed. If the bridge side already holds a strong
API_TOKEN and the moderator side does not, the moderator adopts it. Prints key
names only, never values. Exit 0 = ok (including "nothing to do"), 1 = error.
"""
import os
import secrets
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MOD_ENV = os.path.join(HERE, ".env")
UP_ENV = os.path.normpath(os.path.join(HERE, os.pardir, "upstream", ".env"))


def weak(tok):
    """Same rule as server._weak_token (quotes stripped like the loaders do)."""
    t = (tok or "").strip().strip('"').strip("'")
    return (not t) or t.lower().startswith("changeme") or len(t) < 16


def _active_key(line):
    s = line.strip()
    if not s or s.startswith("#") or "=" not in s:
        return None
    return s.partition("=")[0].strip()


def read_env(path):
    """-> (lines with endings, {key: value}). First occurrence wins, like the loaders."""
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        lines = f.read().splitlines(keepends=True)
    vals = {}
    for ln in lines:
        key = _active_key(ln)
        if key and key not in vals:
            vals[key] = ln.strip().partition("=")[2].strip().strip('"').strip("'")
    return lines, vals


def set_key(lines, key, value):
    """Replace the first active KEY= line (the one the loaders read); append if absent."""
    for i, ln in enumerate(lines):
        if _active_key(ln) == key:
            ending = ln[len(ln.rstrip("\r\n")):] or "\n"
            lines[i] = f"{key}={value}{ending}"
            return lines
    if lines and not lines[-1].endswith(("\n", "\r")):
        lines[-1] += "\n"
    lines.append(f"{key}={value}\n")
    return lines


def write_env(path, lines):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write("".join(lines))
    os.replace(tmp, path)  # atomic on the same volume
    if os.name == "nt":
        # 1A-3: secrets files are owner-only on Windows. Non-fatal if the
        # hardening tool itself is missing (logged, secrets still fixed).
        import subprocess
        try:
            r = subprocess.run(
                ["icacls", path, "/inheritance:r", "/grant:r",
                 f"{os.environ.get('USERNAME', '')}:F"],
                capture_output=True, text=True, timeout=30)
            if r.returncode != 0:
                print(f"[init_env] WARNING: icacls refused {path} "
                      f"({(r.stderr or r.stdout).strip()[:120]})")
        except Exception as e:
            print(f"[init_env] WARNING: icacls unavailable for {path} ({e})")


def main():
    if not os.path.exists(MOD_ENV):
        print("[init_env] moderator/.env not found - copy moderator/.env.example "
              "to moderator/.env first", file=sys.stderr)
        return 1
    mod_lines, mod = read_env(MOD_ENV)
    have_up = os.path.exists(UP_ENV)
    up_lines, up = read_env(UP_ENV) if have_up else ([], {})
    changed_mod = changed_up = False
    done, warnings, conflict = [], [], False

    api = mod.get("API_TOKEN", "")
    if weak(api):
        bridge_api = up.get("API_TOKEN", "")
        api = bridge_api if not weak(bridge_api) else secrets.token_hex(32)
        mod_lines = set_key(mod_lines, "API_TOKEN", api)
        changed_mod = True
        done.append("moderator/.env API_TOKEN"
                    + (" (adopted from upstream/.env)" if api == bridge_api else ""))
    if weak(mod.get("MOD_TOKEN", "")):
        mod_tok = secrets.token_hex(32)
        while mod_tok == api:  # never reuse the ingest secret
            mod_tok = secrets.token_hex(32)
        mod_lines = set_key(mod_lines, "MOD_TOKEN", mod_tok)
        changed_mod = True
        done.append("moderator/.env MOD_TOKEN")
    # 1A-1: a manually configured equal pair is rejected by regeneration —
    # one secret must never authorize both planes.
    if not weak(api) and not weak(mod.get("MOD_TOKEN", "")) \
            and mod.get("MOD_TOKEN", "").strip().strip('"').strip("'") == api.strip().strip('"').strip("'"):
        mod_tok = secrets.token_hex(32)
        while mod_tok == api:
            mod_tok = secrets.token_hex(32)
        mod_lines = set_key(mod_lines, "MOD_TOKEN", mod_tok)
        changed_mod = True
        done.append("moderator/.env MOD_TOKEN (regenerated: equal to API_TOKEN is rejected)")

    if have_up:
        for key in ("API_TOKEN", "TTLIVE_API_TOKEN"):
            if key == "TTLIVE_API_TOKEN" and key not in up:
                continue  # absent: the bridge falls back to API_TOKEN
            cur = up.get(key, "")
            if weak(cur):
                up_lines = set_key(up_lines, key, api)
                changed_up = True
                done.append(f"upstream/.env {key} (= moderator API_TOKEN)")
            elif cur != api:
                # 1A-2: two strong values that disagree need an operator call —
                # exit non-zero so launchers (run.bat preflight) stop instead
                # of serving a split-brain bridge.
                warnings.append(f"upstream/.env {key} differs from moderator/.env "
                                "API_TOKEN - the bridge gets 401 until they match "
                                "(left unchanged: it is a real value you set)")
                conflict = True
    else:
        warnings.append("upstream/.env not found - when you create it, run this "
                        "script again so the bridge gets the same API_TOKEN")

    if changed_mod:
        write_env(MOD_ENV, mod_lines)
    if changed_up:
        write_env(UP_ENV, up_lines)
    for d in done:
        print(f"[init_env] generated {d}")
    for w in warnings:
        print(f"[init_env] WARNING: {w}")
    if conflict:
        print("[init_env] token conflict needs an operator decision - refusing "
              "to paper over it (1A-2)")
        return 2
    if not done:
        print("[init_env] tokens OK - nothing to do")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # never leave a launcher guessing
        print(f"[init_env] ERROR: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
