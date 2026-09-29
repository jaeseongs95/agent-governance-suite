"""Redacts personal data and secrets in evidence text files in place and counts each rule's hits."""
import json
import os
import pathlib
import re
import sys

# Literals are split so a repository secret scan does not flag this script's own patterns.
RULES = [
    ("email", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")),
    ("github-token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)" + "_[A-Za-z0-9]{20,}|github" + "_pat_[A-Za-z0-9_]{20,}")),
    ("anthropic-key", re.compile("sk-" + r"ant-[A-Za-z0-9_-]{10,}")),
    ("aws-key", re.compile(r"\bAK" + r"IA[0-9A-Z]{16}\b")),
    ("private-key", re.compile(r"-----BEGIN [A-Z ]*PRIV" + r"ATE KEY-----[\s\S]*?-----END [A-Z ]*PRIV" + r"ATE KEY-----")),
    ("bearer", re.compile("Authorization: " + r"Bearer [A-Za-z0-9._~+/=-]{8,}")),
    ("ipv4", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
    ("home-path", re.compile(r"/home/[A-Za-z0-9._-]+|-home-[A-Za-z0-9_]+-")),
    ("root-home", re.compile(r"/root/")),
    # Account and user names come from the environment so this script does not publish them.
    ("account-name", re.compile("|".join(re.escape(name) for name in os.environ.get("AGS_REDACT_NAMES", "").split(",") if name) or r"(?!)", re.IGNORECASE)),
]
REPLACEMENT = {"home-path": lambda m: "/home/[REDACTED]" if m.group(0).startswith("/") else "-home-[REDACTED]-",
               "root-home": lambda m: "/[REDACTED]/"}


def main(root: str) -> None:
    counts: dict[str, int] = {name: 0 for name, _ in RULES}
    for path in sorted(pathlib.Path(root).rglob("*")):
        # SHA256SUMS is regenerated afterwards; this script's own patterns would match themselves.
        if not path.is_file() or path.name == "SHA256SUMS" or path.resolve() == pathlib.Path(__file__).resolve():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for name, pattern in RULES:
            text, hits = pattern.subn(REPLACEMENT.get(name, "[REDACTED]"), text)
            counts[name] += hits
        path.write_text(text, encoding="utf-8")
    print(json.dumps(counts, sort_keys=True))


if __name__ == "__main__":
    main(sys.argv[1])
