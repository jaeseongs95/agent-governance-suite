#!/usr/bin/env python3
"""tsv.py generated <repo> <out> | tsv.py tree <root> <out>"""
import hashlib, os, subprocess, sys

COMMON = [f"mcp-server/dist/{n}.mjs" for n in (
    "continuity-hook", "host-attestation-api", "host-attestation-hook", "server", "session-board-hook",
    "session-message-broker", "session-message-cli", "session-message-hook", "session-message-relay")] + [
    "runtime/THIRD_PARTY_NOTICES.md", "runtime/schema-validation.mjs"]


def row(base, rel):
    b = open(os.path.join(base, rel), "rb").read()
    return f"{rel}\t{len(b)}\t{hashlib.sha256(b).hexdigest()}\n"


mode, base, out = sys.argv[1:4]
if mode == "generated":
    ls = subprocess.run(["git", "-C", base, "ls-files", "-z", "claude-plugin"], capture_output=True).stdout.decode().split("\0")
    ls = sorted(p for p in ls if p)
    paths = ls + COMMON
    print("claude-plugin ls-files:", len(ls), "common:", len(COMMON), "total:", len(paths))
else:
    paths = []
    for d, dirs, fs in os.walk(base):
        for f in fs:
            p = os.path.join(d, f)
            if os.path.islink(p) or not os.path.isfile(p):
                print("NONREGULAR", os.path.relpath(p, base))
                continue
            paths.append(os.path.relpath(p, base))
    paths.sort()
    print("files:", len(paths))
with open(out, "w", newline="\n") as o:
    for p in paths:
        o.write(row(base, p))
