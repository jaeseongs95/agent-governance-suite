#!/usr/bin/env python3
"""redact.py <src_dir> <dst_dir> <literals_file> <manifest_json>
Copies every file from src to dst with: structural removal of thinking/redacted_thinking blocks and
`signature` keys in JSON/JSONL, then pattern + literal redaction. Records counts per file.
Literal values are never printed."""
import hashlib, json, os, re, sys

src, dst, lit_file, man_out = sys.argv[1:5]
literals = sorted({l.rstrip("\n") for l in open(lit_file) if len(l.strip()) >= 8}, key=len, reverse=True)
TH = {"thinking", "redacted_thinking"}

REPO_KEEP = "jaeseongs95/agent-governance-suite"
PATTERNS = [
    ("email", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "<EMAIL>"),
    ("github_token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"), "<GITHUB_TOKEN>"),
    ("sk_token", re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"), "<SK_TOKEN>"),
    ("slack_token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"), "<SLACK_TOKEN>"),
    ("aws_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "<AWS_KEY>"),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), "<JWT>"),
    ("bearer", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}"), "Bearer <REDACTED>"),
    ("secret_assign", re.compile(r"\b([A-Z0-9_]*(?:_TOKEN|_SECRET|_KEY))=(?!<)([^\s\"'\\]+)"), r"\1=<REDACTED>"),
    ("integrity_token", re.compile(r"(integrityToken\\*\"\s*:\s*\\*\")([^\"\\]+)"), r"\1<REDACTED>"),
    ("url_query", re.compile(r"(https?://[^\s\"'?<>\\]+)\?[^\s\"'<>\\]+"), r"\1?<QUERY_REDACTED>"),
    ("ipv4", re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])"), "<IP>"),
    ("base64_long", re.compile(r"[A-Za-z0-9+/_=-]{201,}"), "<BASE64_REDACTED>"),
    ("home_root", re.compile(r"(?<![A-Za-z0-9_])/root(?=[/\"'\s:\\]|$)"), "<HOME>"),
    ("home_user", re.compile(r"(?<![A-Za-z0-9_])/home/(?:user|claude)(?=[/\"'\s:\\]|$)"), "<HOME_USER>"),
]
ACCOUNT = re.compile(r"<ACCOUNT>|<ACCOUNT>")


def strip_struct(o, c):
    if isinstance(o, dict):
        out = {}
        for k, v in o.items():
            if k == <PATTERN_TEXT_REDACTED>
                c["signature_fields"] += 1
                continue
            out[k] = strip_struct(v, c)
        return out
    if isinstance(o, list):
        out = []
        for v in o:
            if isinstance(v, dict) and v.get("type") in TH:
                c["thinking_blocks"] += 1
                continue
            out.append(strip_struct(v, c))
        return out
    return o


def residual(o):
    n = {"thinking_blocks": 0, "signature_fields": 0}
    def w(x):
        if isinstance(x, dict):
            if x.get("type") in TH: n["thinking_blocks"] += 1
            if "signature" in x: n["signature_fields"] += 1
            for v in x.values(): w(v)
        elif isinstance(x, list):
            for v in x: w(v)
    w(o)
    return n


def text_redact(t, c):
    for v in literals:
        k = t.count(v)
        if k:
            c["literal"] = c.get("literal", 0) + k
            t = t.replace(v, "<SECRET_LITERAL>")
    for name, rx, rep in PATTERNS:
        t, k = rx.subn(rep, t)
        if k: c[name] = c.get(name, 0) + k
    keep = "\x00REPOKEEP\x00"
    t = t.replace(REPO_KEEP, keep)
    t, k = ACCOUNT.subn("<ACCOUNT>", t)
    if k: c["account"] = c.get("account", 0) + k
    return t.replace(keep, REPO_KEEP)


manifest = []
for d, _, fs in os.walk(src):
    for f in sorted(fs):
        sp = os.path.join(d, f); rel = os.path.relpath(sp, src)
        raw = open(sp, "rb").read()
        c = {"thinking_blocks": 0, "signature_fields": 0}
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            manifest.append({"path": rel, "pre": hashlib.sha256(raw).hexdigest(), "public": None, "counts": c, "status": "WITHHELD_BINARY"})
            continue
        res = {"thinking_blocks": 0, "signature_fields": 0}
        parsed_ok = True
        stripped = text.rstrip("\n")
        if rel.endswith((".jsonl", ".stdout")) or f.endswith(".jsonl"):
            lines_out = []
            for line in text.split("\n"):
                if not line.strip():
                    lines_out.append(line); continue
                try:
                    o = json.loads(line)
                except Exception:
                    lines_out.append(line); continue
                o = strip_struct(o, c)
                lines_out.append(json.dumps(o, ensure_ascii=False, separators=(",", ":")))
            text = "\n".join(lines_out)
        elif rel.endswith(".json"):
            try:
                o = json.loads(text)
                o = strip_struct(o, c)
                text = json.dumps(o, ensure_ascii=False, indent=2) + "\n"
            except Exception:
                parsed_ok = False
        text = text_redact(text, c)
        # residual structural check on the redacted output
        for line in (text.split("\n") if rel.endswith((".jsonl", ".stdout")) else [text]):
            try:
                r = residual(json.loads(line))
                res["thinking_blocks"] += r["thinking_blocks"]; res["signature_fields"] += r["signature_fields"]
            except Exception:
                pass
        dp = os.path.join(dst, rel); os.makedirs(os.path.dirname(dp), exist_ok=True)
        ok = res["thinking_blocks"] == 0 and res["signature_fields"] == 0
        if ok:
            open(dp, "w", encoding="utf-8", newline="").write(text)
        manifest.append({"path": rel, "pre": hashlib.sha256(raw).hexdigest(),
                         "public": hashlib.sha256(text.encode()).hexdigest() if ok else None,
                         "counts": {k: v for k, v in c.items() if v}, "residual": res,
                         "status": "PUBLIC" if ok else "WITHHELD_RESIDUAL"})
json.dump(manifest, open(man_out, "w"), indent=1)
print("files", len(manifest), "withheld", sum(1 for m in manifest if m["status"] != "PUBLIC"),
      "thinking_removed", sum(m["counts"].get("thinking_blocks", 0) for m in manifest),
      "signature_removed", sum(m["counts"].get("signature_fields", 0) for m in manifest))
