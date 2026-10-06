# usage: python3 -I redact.py scan|redact <dir> [extra-literals-file]
# Prints only counts / masked classes, never raw matched values.
import ipaddress, json, os, re, sys

mode, root = sys.argv[1], sys.argv[2]
literals = []
if len(sys.argv) > 3:
    literals = [l.rstrip("\n") for l in open(sys.argv[3], encoding="utf-8") if len(l.strip()) >= 6]

SKIP = {"SHA256SUMS", "MANIFEST.tsv", "REDACTION.md"}
R = "[REDACTED]"

def ip_ok(s):
    try:
        ip = ipaddress.ip_address(s)
    except ValueError:
        return None
    if str(ip) in ("127.0.0.1", "0.0.0.0", "::1", "::"):
        return None
    return ip

PATTERNS = [
    # (kind, regex, group-to-replace or None for whole, validator)
    ("url-query", re.compile(r"https?://[^\s?#\"'<>]+\?(?P<v>[^\s\"'<>)\]]+)"), None, None),
    ("github-token", re.compile(r"(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"), None, None),
    ("sk-token", re.compile(r"(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}"), None, None),
    ("slack-token", re.compile(r"(?<![A-Za-z0-9])xox[abprse]-[A-Za-z0-9-]{10,}"), None, None),
    ("aws-key", re.compile(r"(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}"), None, None),
    ("jwt", re.compile(r"(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), None, None),
    ("bearer", re.compile(r"(?i)Bearer (?P<v>[A-Za-z0-9._~+/=-]{8,})"), None, None),
    ("secret-assignment", re.compile(r"[A-Za-z0-9](?:_TOKEN|_SECRET|_KEY)=(?P<v>[^\s\"',;]{4,})"), None, None),
    ("email", re.compile(r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9])"), None, None),
    ("windows-home", re.compile(r"(?i)(?:[Cc]:\\\\Users\\\\|[Cc]:\\Users\\|[Cc]:/Users/|/c/Users/[REDACTED]\\/\s\"']+)"), None, None),
    ("ipv4", re.compile(r"(?<![0-9.])(?:\d{1,3}\.){3}\d{1,3}(?![0-9.])"), None, ip_ok),
    ("ipv6", re.compile(r"(?<![0-9A-Za-z:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Za-z:])"), None, ip_ok),
]
USERNAMES = ["[REDACTED]", "[REDACTED]", "[REDACTED]"]

report = {}
for name in sorted(os.listdir(root)):
    path = os.path.join(root, name)
    if name in SKIP or not os.path.isfile(path):
        continue
    text = open(path, encoding="utf-8").read()
    counts = {}
    # Encoded payloads (base64 runs) cannot be inspected as text: replace with a marker.
    def enc(m):
        import hashlib
        counts["encoded-block"] = counts.get("encoded-block", 0) + 1
        b = m.group(0).encode()
        return "[REDACTED_ENCODED_ARTIFACT: base64/%d/%s]" % (len(b), hashlib.sha256(b).hexdigest())
    text = re.sub(r"(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{200,}={0,2}(?![A-Za-z0-9+/=])", enc, text)
    for kind, rx, _, val in PATTERNS:
        def sub(m, kind=kind, val=val):
            if val is not None and val(m.group(0)) is None:
                return m.group(0)
            if "v" in m.re.groupindex and m.group("v") == R:
                return m.group(0)
            counts[kind] = counts.get(kind, 0) + 1
            if mode == "scan" and kind in ("email", "ipv4", "ipv6"):
                v = m.group(0)
                cls = v.split("@", 1)[1] if kind == "email" else ("private" if val(v).is_private else "public")
                counts.setdefault(kind + "-classes", set()).add(cls)
            if "v" in m.re.groupindex:
                s, e = m.span("v")
                return m.group(0)[: s - m.start()] + R + m.group(0)[e - m.start():]
            return R
        text = rx.sub(sub, text)
    for u in USERNAMES:
        n = len(re.findall(r"(?i)(?<![A-Za-z0-9])" + re.escape(u) + r"(?![A-Za-z0-9])", text))
        if n:
            counts["account-name"] = counts.get("account-name", 0) + n
            text = re.sub(r"(?i)(?<![A-Za-z0-9])" + re.escape(u) + r"(?![A-Za-z0-9])", R, text)
    for lit in literals:
        n = text.count(lit)
        if n:
            counts["runtime-secret-literal"] = counts.get("runtime-secret-literal", 0) + n
            text = text.replace(lit, R)
    if counts:
        report[name] = {k: (sorted(v) if isinstance(v, set) else v) for k, v in counts.items()}
    if mode == "redact" and counts:
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(text)
print(json.dumps(report, ensure_ascii=False, indent=1))
