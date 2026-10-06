#!/usr/bin/env python3
"""Command wrapper: w.py <name> [--cwd DIR] [--stdin FILE] -- argv...
Runs argv with isolated env, saves raw stdout/stderr, appends commands.jsonl."""
import hashlib, json, os, subprocess, sys, datetime

ST = "<REDACTED_HOME>/cs281-b28a-20261006T110419Z"
REPO = "<REDACTED_HOME>/agent-governance-suite"
RAW = "<REDACTED_HOME>/cs281-b28a-20261006T110419Z/c2-git-v2/private/raw"
LOG = "<REDACTED_HOME>/cs281-b28a-20261006T110419Z/c2-git-v2/private/commands.jsonl"


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def git(*a):
    try:
        return subprocess.run(["git", "-C", REPO, *a], capture_output=True, text=True, env=base_env_git()).stdout
    except Exception as e:
        return f"ERR {e}"


def base_env_git():
    e = dict(os.environ)
    return e


def repo_state():
    head = git("rev-parse", "HEAD").strip()
    tree = git("rev-parse", "HEAD^{tree}").strip()
    dirty = len([l for l in git("status", "--porcelain", "--untracked-files=all").splitlines() if l.strip()])
    return {"head": head, "tree": tree, "dirty": dirty}


def iso_env():
    e = dict(os.environ)
    for k in ("CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN"):
        e.pop(k, None)
    S = "<REDACTED_HOME>/cs281-b28a-20261006T110419Z/c2-git-v2/state"
    t = os.path.join(S, "tmp")
    e.update({
        "TMPDIR": t, "TEMP": t, "TMP": t,
        "XDG_CONFIG_HOME": os.path.join(S, "xdg/config"),
        "XDG_DATA_HOME": os.path.join(S, "xdg/data"),
        "XDG_CACHE_HOME": os.path.join(S, "xdg/cache"),
        "XDG_STATE_HOME": os.path.join(S, "xdg/state"),
        "AGENT_GOVERNANCE_SHARED_STATE_DIR": os.path.join(S, "shared-state"),
        "CLAUDE_PLUGIN_DATA": os.path.join(S, "plugin-data"),
        "PLUGIN_DATA": os.path.join(S, "plugin-data"),
        "CODEX_HOME": os.path.join(S, "codex-home"),
        "CLAUDE_CONFIG_DIR": "<REDACTED_HOME>/cs281-b28a-20261006T110419Z/c2-git-v2/claude-config",
    })
    e["PATH"] = "/opt/node24/bin:" + e.get("PATH", "")
    return e


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


def main():
    args = sys.argv[1:]
    name = args.pop(0)
    cwd = "<REDACTED_HOME>/cs281-b28a-20261006T110419Z/c2-git-v2/child-cwd"
    stdin_file = None
    while args and args[0] != "--":
        if args[0] == "--cwd":
            cwd = args[1]; args = args[2:]
        elif args[0] == "--stdin":
            stdin_file = args[1]; args = args[2:]
        else:
            raise SystemExit("bad opt " + args[0])
    argv = args[1:]
    seq = 1
    if os.path.exists(LOG):
        with open(LOG) as f:
            seq = sum(1 for _ in f) + 1
    base = f"{seq:03d}-{name}"
    out_p = os.path.join(RAW, base + ".stdout")
    err_p = os.path.join(RAW, base + ".stderr")
    pre = repo_state()
    start = now()
    with open(out_p, "wb") as o, open(err_p, "wb") as e:
        stdin = open(stdin_file, "rb") if stdin_file else subprocess.DEVNULL
        r = subprocess.run(argv, cwd=cwd, stdout=o, stderr=e, stdin=stdin, env=iso_env())
    end = now()
    post = repo_state()
    rec = {"seq": seq, "name": name, "argv": argv, "cwd": cwd, "startUtc": start, "endUtc": end,
           "exitCode": r.returncode, "stdout": os.path.relpath(out_p, "<REDACTED_HOME>/cs281-b28a-20261006T110419Z/c2-git-v2/private"), "stderr": os.path.relpath(err_p, "<REDACTED_HOME>/cs281-b28a-20261006T110419Z/c2-git-v2/private"),
           "stdoutSha256": sha(out_p), "stderrSha256": sha(err_p), "pre": pre, "post": post}
    with open(LOG, "a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(f"[{seq}] {name} exit={r.returncode} pre={pre['head'][:8]}/{pre['dirty']} post={post['head'][:8]}/{post['dirty']}")
    sys.stdout.write(open(out_p, encoding="utf-8", errors="replace").read()[-6000:])
    er = open(err_p, encoding="utf-8", errors="replace").read()
    if er:
        sys.stdout.write("\n--stderr--\n" + er[-3000:])


main()
