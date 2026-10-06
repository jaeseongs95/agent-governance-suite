# usage: python3 -I build_append_manifest.py <S> <pre-hash-stdout>... -- <redact-report-stdout>:<prefix> ...
# Writes S/MANIFEST.tsv (path, pre_redaction_sha256, public_sha256, redactions) then S/SHA256SUMS.
import hashlib, json, os, re, sys

S = sys.argv[1]
sep = sys.argv.index("--")
pre_files, reports = sys.argv[2:sep], sys.argv[sep + 1:]
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()

pre = {}
for f in pre_files:
    for line in open(f, encoding="utf-8"):
        m = re.match(r"^([0-9a-f]{64})  (\S+)$", line.strip())
        if m:
            pre[m.group(2)] = m.group(1)
red = {}
for spec in reports:
    f, prefix = spec.rsplit(":", 1)
    for k, v in json.load(open(f, encoding="utf-8")).items():
        red[prefix + k] = ",".join("%s=%d" % (t, n) for t, n in sorted(v.items()))

rows = []
for dp, _, fs in os.walk(S):
    for f in fs:
        rel = os.path.relpath(os.path.join(dp, f), S)
        if rel in ("MANIFEST.tsv", "SHA256SUMS"):
            continue
        if rel in ("REDACTION.md", "NOTES.md"):
            rows.append((rel, "new", sha(os.path.join(S, rel)), "n/a(generated)"))
        elif rel in pre:
            rows.append((rel, pre[rel], sha(os.path.join(S, rel)), red.get(rel, "none")))
        else:
            sys.exit("no pre-redaction hash for %s" % rel)
missing = [k for k in pre if not os.path.exists(os.path.join(S, k))]
if missing:
    sys.exit("pre-hash entries without payload: %s" % missing)
rows.sort()
with open(os.path.join(S, "MANIFEST.tsv"), "w", encoding="utf-8", newline="\n") as fh:
    fh.write("path\tpre_redaction_sha256\tpublic_sha256\tredactions\n")
    for r in rows:
        fh.write("\t".join(r) + "\n")
with open(os.path.join(S, "SHA256SUMS"), "w", encoding="utf-8", newline="\n") as fh:
    for rel in sorted([r[0] for r in rows] + ["MANIFEST.tsv"]):
        fh.write("%s  %s\n" % (sha(os.path.join(S, rel)), rel))
print("payload=%d changed_by_redaction=%s" % (len(rows), [r[0] for r in rows if r[1] not in ("new", r[2])]))
