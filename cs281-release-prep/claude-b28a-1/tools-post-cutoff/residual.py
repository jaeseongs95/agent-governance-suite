#!/usr/bin/env python3
"""residual.py <public_dir> <literals_file> <out_tsv>: count residual sensitive patterns per category."""
import json, os, re, sys

pub, lit, out = sys.argv[1:4]
vals = [l.rstrip("\n") for l in open(lit) if len(l.strip()) >= 8]
TH = {"thinking", "redacted_thinking"}
q = '"'
cats = {
    "literal_secret": None,
    "email": re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    "account_name": re.compile(r"<ACCOUNT>|<ACCOUNT>"),
    "home_path": re.compile(r"(?<![A-Za-z0-9_])(?:/root|/home/[A-Za-z0-9_.-]+)(?=[/\"'\s:\\]|$)"),
    "github_token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"),
    "sk_token": re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"),
    "slack_token": re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
    "aws_key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "jwt": re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),
    "bearer": re.compile(r"(?i)\bbearer\s+(?!<REDACTED>)[A-Za-z0-9._~+/=-]{8,}"),
    "secret_assign": re.compile(r"\b[A-Z0-9_]*(?:_TOKEN|_SECRET|_KEY)=(?!<)[^\s\"'\\]+"),
    "cookie": re.compile(r"(?i)\b(?:set-)?cookie\s*[:=][ \t]*(?![ \t]|<REDACTED>)[^\n\"\\]+"),
    "auth_header": re.compile(r"(?i)\b(?:authorization|proxy-authorization|x-api-key)\s*[:=][ \t]*(?![ \t]|<REDACTED>)[^\n\"\\]+"),
    "integrity_token": re.compile(r"integrityToken\\*\"\s*:\s*\\*\"(?!<REDACTED>)[^\"\\]+"),
    "url_query": re.compile(r"https?://[^\s\"'?<>\\]+\?(?!<QUERY_REDACTED>)[^\s\"'<>\\]+"),
    "ipv4": re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])"),
    "base64_over_200": re.compile(r"[A-Za-z0-9+/_=-]{201,}"),
    "embedded_thinking_text": re.compile(r"\\*" + q + r"type\\*" + q + r"\s*:\s*\\*" + q + r"(?:redacted_)?thinking\\*" + q),
    "embedded_signature_text": re.compile(r"\\*" + q + r"signature\\*" + q + r"\s*:"),
}
tot = {k: 0 for k in cats}
tot["thinking_block_struct"] = 0
tot["signature_key_struct"] = 0


def walk(o):
    if isinstance(o, dict):
        if o.get("type") in TH: tot["thinking_block_struct"] += 1
        if "signature" in o: tot["signature_key_struct"] += 1
        for v in o.values(): walk(v)
    elif isinstance(o, list):
        for v in o: walk(v)


files = 0
for d, _, fs in os.walk(pub):
    for f in fs:
        p = os.path.join(d, f); t = open(p, encoding="utf-8").read(); files += 1
        tot["literal_secret"] += sum(t.count(v) for v in vals)
        for k, rx in cats.items():
            if rx is None: continue
            s = t.replace("jaeseongs95/agent-governance-suite", "") if k == "account_name" else t
            tot[k] += len(rx.findall(s))
        for chunk in t.split("\n") if f.endswith((".jsonl", ".stdout")) else [t]:
            try: walk(json.loads(chunk))
            except Exception: pass
with open(out, "w", newline="\n") as o:
    o.write("category\tresidual\n")
    for k, v in tot.items(): o.write(f"{k}\t{v}\n")
print(files, json.dumps(tot))
