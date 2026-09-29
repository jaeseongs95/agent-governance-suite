#!/usr/bin/env python3
"""Redact secret-shaped values and personal data in every text file under a directory; print per-rule counts."""
import json, re, sys, pathlib
root = pathlib.Path(sys.argv[1])
# Patterns are split so this file does not match itself.
rules = [
    ("github-token", re.compile(r"\b(?:gh" + r"p_|gh" + r"o_|github" + r"_pat_)[A-Za-z0-9_]{10,}")),
    ("anthropic-key", re.compile(r"sk-" + r"ant-[A-Za-z0-9_\-]{10,}")),
    ("aws-access-key", re.compile(r"\bAK" + r"IA[0-9A-Z]{16}\b")),
    ("private-key-line", re.compile(r"^.*BEGIN [A-Z ]*PRIVATE " + r"KEY.*$", re.M)),
    ("bearer-header", re.compile(r"(?i)authorization:\s*bearer\s+\S+")),
    ("email", re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")),
    ("home-path", re.compile(r"/home/(?!\[REDACTED\])[A-Za-z0-9._\-]+")),
    ("root-home", re.compile(r"(?<![A-Za-z0-9_\-])/[REDACTED-HOME](?=/|\b)")),
    ("ipv4", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
    ("github-url-account", re.compile(r"github\.com/(?!\[REDACTED\])[A-Za-z0-9\-]+")),
    ("account-name", re.compile(r"jaeseong" + r"s95")),
    ("windows-user-path", re.compile(r"(?i)[A-Z]:\\+Users\\+(?!\[REDACTED\])[^\\\s\"]+")),
]
allow_email = {"noreply@anthropic.com"}
counts = {name: 0 for name, _ in rules}
for path in sorted(root.rglob("*")):
    if not path.is_file() or path.name == "SHA256SUMS":
        continue
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        continue
    new = text
    for name, pattern in rules:
        def sub(m, name=name):
            if name == "email" and m.group(0) in allow_email:
                return m.group(0)
            if name == "ipv4" and not all(0 <= int(p) <= 255 for p in m.group(0).split(".")):
                return m.group(0)
            counts[name] += 1
            if name == "home-path":
                return "/home/[REDACTED]"
            if name == "github-url-account":
                return "github.com/[REDACTED]"
            if name == "windows-user-path":
                return m.group(0)[:m.group(0).lower().index("users")] + "Users\\[REDACTED]"
            if name == "root-home":
                return "/[REDACTED-HOME]"
            return "[REDACTED]"
        new = pattern.sub(sub, new)
    if new != text:
        path.write_text(new, encoding="utf-8")
print(json.dumps(counts))
