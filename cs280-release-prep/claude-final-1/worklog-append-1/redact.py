#!/usr/bin/env python3
"""Redact a copy tree in place. usage: redact.py <dir> <literals-file> <report.json>
Literal list lives outside the repo and is deleted by the caller right after use."""
import sys, os, re, json, ipaddress, hashlib
root, litf, report = sys.argv[1:4]
lits = [l.rstrip("\n") for l in open(litf, encoding="utf-8") if len(l.strip()) >= 8]
ACCT = ["jae" + "seongs95", "sjs" + "9505", "sjs" + "95"]  # split so this source does not match itself
PATS = [
 ("email", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), lambda m: "[REDACTED]" if not m.group(0).startswith(("noreply@anthropic.com",)) else m.group(0)),
 ("github-token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"), None),
 ("sk-token", re.compile(r"(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}"), None),
 ("slack-xox", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"), None),
 ("aws-AKIA", re.compile(r"\bAKIA[0-9A-Z]{16}\b"), None),
 ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), None),
 ("bearer", re.compile(r"(?i)(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}"), lambda m: m.group(1) + "[REDACTED]"),
 ("secret-assignment", re.compile(r"\b([A-Z0-9_]*(?:_TOKEN|_SECRET|_KEY))=([^\s\"',;]+)"), lambda m: m.group(1) + "=[REDACTED]"),
 ("url-query", re.compile(r"(https?://[^\s\"'?<>]+)\?[^\s\"'<>)]+"), lambda m: m.group(1) + "?[REDACTED]"),
 ("windows-home", re.compile(r"(?i)((?:[A-Z]:[\\/]{1,2}|/[a-z]/)Users[\\/]{1,2})[^\\/\s\"']+"), lambda m: m.group(1) + "[REDACTED]"),
]
B64 = re.compile(r"[A-Za-z0-9+/_-]{200,}={0,2}")
IPV4 = re.compile(r"(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])")
KEEP_IP = {"127.0.0.1", "0.0.0.0"}
out = {}
for dp, _, fs in os.walk(root):
    for f in fs:
        p = os.path.join(dp, f); rel = os.path.relpath(p, root)
        raw = open(p, "rb").read()
        try: s = raw.decode("utf-8")
        except UnicodeDecodeError: out[rel] = {"binary": True}; continue
        c = {}
        for lit in lits:
            n = s.count(lit)
            if n: s = s.replace(lit, "[REDACTED]"); c["runtime-literal"] = c.get("runtime-literal", 0) + n
        for a in ACCT:
            n = len(re.findall(re.escape(a), s, re.I))
            if n: s = re.sub(re.escape(a), "[REDACTED]", s, flags=re.I); c["account-name"] = c.get("account-name", 0) + n
        for name, rx, fn in PATS:
            hits = [0]
            def rep(m, fn=fn):
                r = fn(m) if fn else "[REDACTED]"
                if r != m.group(0): hits[0] += 1
                return r
            s = rx.sub(rep, s)
            if hits[0]: c[name] = hits[0]
        def b64(m):
            v = m.group(0)
            if re.fullmatch(r"[0-9a-f]+", v): return v  # hex digest runs are not encoded blocks
            c["encoded-block-200"] = c.get("encoded-block-200", 0) + 1
            return f"[REDACTED_ENCODED_ARTIFACT: base64/{len(v)}/{hashlib.sha256(v.encode()).hexdigest()}]"
        s = B64.sub(b64, s)
        def ip(m):
            v = m.group(1)
            try: a = ipaddress.ip_address(v)
            except ValueError: return v
            if v in KEEP_IP: return v
            c["ipv4"] = c.get("ipv4", 0) + 1; return "[REDACTED]"
        s = IPV4.sub(ip, s)
        if c: open(p, "w", encoding="utf-8", newline="").write(s)
        out[rel] = c
json.dump(out, open(report, "w"), indent=1, sort_keys=True)
print(sum(1 for v in out.values() if v and not v.get("binary")), "files changed of", len(out))
