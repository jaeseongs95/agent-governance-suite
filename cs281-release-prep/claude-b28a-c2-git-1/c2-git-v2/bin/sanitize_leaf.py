#!/usr/bin/env python3
"""sanitize_leaf.py <private_dir> <public_dir> <report_dir>
JSON/JSONL: parse, drop thinking/redacted_thinking blocks and `signature` keys, redact string leaves
(and keys), then serialize. Never regex over serialized JSON. Parse failure -> file withheld, listed.
Other files: line-oriented text redaction. Secret literals are held in memory only."""
import glob, hashlib, json, os, re, sys

src, dst, rep = sys.argv[1:4]
ST = "<REDACTED_HOME>/cs281-b28a-20261006T110419Z"
lits = set()
for k, v in os.environ.items():
    if re.search(r"TOKEN|SECRET|KEY|PASSWORD|AUTH|CREDENTIAL|COOKIE", k) and len(v) >= 8 and "\n" not in v:
        lits.add(v)
for p in glob.glob(ST + "/**/broker.token", recursive=True):
    try:
        v = open(p).read().strip()
        if len(v) >= 8: lits.add(v)
    except Exception:
        pass
lits = sorted(lits, key=len, reverse=True)
TH = {"thinking", "redacted_thinking"}
KEEP = "jaeseongs95/agent-governance-suite"
PAT = [
    ("email", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "<EMAIL>"),
    ("github_token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"), "<REDACTED>"),
    ("sk_token", re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"), "<REDACTED>"),
    ("slack_token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"), "<REDACTED>"),
    ("aws_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "<REDACTED>"),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), "<REDACTED>"),
    ("bearer", re.compile(r"(?i)\bbearer\s+(?!<REDACTED>)[A-Za-z0-9._~+/=-]{8,}"), "Bearer <REDACTED>"),
    ("secret_assign", re.compile(r"\b([A-Z0-9_]*(?:_TOKEN|_SECRET|_KEY))=(?!<)[^\s\"']+"), r"\1=<REDACTED>"),
    ("sensitive_header", re.compile(r"(?im)^(\s*(?:set-cookie|cookie|authorization|proxy-authorization|x-api-key)\s*:)[ \t]*(?!<REDACTED>)\S.*$"), r"\1 <REDACTED>"),
    ("url_query", re.compile(r"(https?://[^\s\"'?<>]+)\?(?!<QUERY_REDACTED>)[^\s\"'<>]+"), r"\1?<QUERY_REDACTED>"),
    ("ipv4", re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])"), "<IP>"),
    ("base64_over_200", re.compile(r"[A-Za-z0-9+/_=-]{201,}"), "<REDACTED_BASE64>"),
    ("home_path", re.compile(r"(?<![A-Za-z0-9_])(?:/root|/home/[A-Za-z0-9_.-]+)(?=[/\"'\s:]|$)"), "<REDACTED_HOME>"),
]
ACCT = re.compile(r"<ACCOUNT>|<ACCOUNT>")


def red(s, c):
    for v in lits:
        n = s.count(v)
        if n: c["literal_secret"] = c.get("literal_secret", 0) + n; s = s.replace(v, "<REDACTED>")
    for name, rx, r in PAT:
        s, n = rx.subn(r, s)
        if n: c[name] = c.get(name, 0) + n
    s = s.replace(KEEP, "\x00K\x00")
    s, n = ACCT.subn("<ACCOUNT>", s)
    if n: c["account_name"] = c.get("account_name", 0) + n
    return s.replace("\x00K\x00", KEEP)


def walk(o, c):
    if isinstance(o, dict):
        out = {}
        for k, v in o.items():
            if k == "signature": c["signature_key"] = c.get("signature_key", 0) + 1; continue
            out[red(k, c)] = walk(v, c)
        return out
    if isinstance(o, list):
        out = []
        for v in o:
            if isinstance(v, dict) and v.get("type") in TH: c["thinking_block"] = c.get("thinking_block", 0) + 1; continue
            out.append(walk(v, c))
        return out
    if isinstance(o, str): return red(o, c)
    return o


def residual(o, r):
    if isinstance(o, dict):
        if o.get("type") in TH: r["thinking_block_struct"] += 1
        if "signature" in o: r["signature_key_struct"] += 1
        for k, v in o.items(): residual(k, r); residual(v, r)
    elif isinstance(o, list):
        for v in o: residual(v, r)
    elif isinstance(o, str): scan(o, r)


def scan(s, r):
    r["literal_secret"] += sum(s.count(v) for v in lits)
    for name, rx, _ in PAT:
        r[name] += len(rx.findall(s))
    r["account_name"] += len(ACCT.findall(s.replace(KEEP, "")))


def mode_of(rel, text):
    if rel.endswith(".json"): return "json"
    if rel.endswith(".jsonl"): return "jsonl"
    if rel.endswith((".stdout", ".stderr")) and text.strip():
        try: json.loads(text); return "json"
        except Exception: pass
    return "text"


mapping, withheld = [], []
R = {k: 0 for k in ["literal_secret", "account_name", "thinking_block_struct", "signature_key_struct"] + [p[0] for p in PAT]}
for d, _, fs in os.walk(src):
    for f in sorted(fs):
        sp = os.path.join(d, f); rel = os.path.relpath(sp, src); raw = open(sp, "rb").read()
        c = {}
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            withheld.append((rel, "not UTF-8")); continue
        m = mode_of(rel, text)
        if m == "json":
            try: o = json.loads(text)
            except Exception as e: withheld.append((rel, f"JSON parse failure: {type(e).__name__} at pos {getattr(e, 'pos', '?')}")); continue
            o = walk(o, c); out = json.dumps(o, ensure_ascii=False, indent=2) + "\n"
            json.loads(out); residual(o, R)
        elif m == "jsonl":
            lines, bad = [], []
            for i, line in enumerate(text.split("\n"), 1):
                if not line.strip(): lines.append(line); continue
                try: o = json.loads(line)
                except Exception: bad.append(i); continue
                o = walk(o, c); s = json.dumps(o, ensure_ascii=False, separators=(",", ":")); json.loads(s); residual(o, R); lines.append(s)
            if bad: withheld.append((rel, f"JSONL parse failure at lines {bad}")); continue
            out = "\n".join(lines)
        else:
            out = "\n".join(red(line, c) for line in text.split("\n")); scan(out, R)
        dp = os.path.join(dst, rel); os.makedirs(os.path.dirname(dp), exist_ok=True)
        ob = out.encode("utf-8"); open(dp, "wb").write(ob)
        mapping.append((rel, hashlib.sha256(raw).hexdigest(), len(raw), rel, hashlib.sha256(ob).hexdigest(), len(ob), m, c))
os.makedirs(rep, exist_ok=True)
with open(rep + "/MAPPING.tsv", "w", newline="\n") as o:
    o.write("raw_path\traw_sha256\traw_bytes\tpublic_path\tpublic_sha256\tpublic_bytes\tmode\tredactions\n")
    for r in mapping: o.write("\t".join(map(str, r[:7])) + "\t" + json.dumps(r[7], sort_keys=True, separators=(",", ":")) + "\n")
with open(rep + "/residual.tsv", "w", newline="\n") as o:
    o.write("category\tresidual\n")
    for k, v in R.items(): o.write(f"{k}\t{v}\n")
json.dump({"withheld": withheld, "literalCount": len(lits), "files": len(mapping)}, open(rep + "/sanitize-result.json", "w"), indent=1)
tot = {}
for r in mapping:
    for k, v in r[7].items(): tot[k] = tot.get(k, 0) + v
print(json.dumps({"public": len(mapping), "withheld": withheld, "residual_nonzero": {k: v for k, v in R.items() if v}, "redactions": tot}))
