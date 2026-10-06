# usage: python3 -I build_manifest.py <R> <E> <P>  -> writes R/MANIFEST.tsv then R/SHA256SUMS
import hashlib, json, os, re, sys

R, E, P = sys.argv[1:4]
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()

def hashes_from(stdout_file):
    out = {}
    for line in open(stdout_file, encoding="utf-8"):
        m = re.match(r"^([0-9a-f]{64})  (\S+)$", line.strip())
        if m:
            out[m.group(2)] = m.group(1)
    return out

def report(stdout_file, prefix):
    d = json.load(open(stdout_file, encoding="utf-8"))
    return {prefix + k: ",".join("%s=%d" % (t, n) for t, n in sorted(v.items())) for k, v in d.items()}

pre = {}
for name in os.listdir(E):
    pre["SHA256SUMS.original" if name == "SHA256SUMS" else name] = ("original-E", sha(os.path.join(E, name)))
for k, v in hashes_from(os.path.join(P, "03-stage-scratchpad.stdout")).items():
    pre["scratchpad/" + k] = ("raw-new", v)
pre["scratchpad/residual.sh"] = ("raw-new", "974d42a415ff114133b5da6fdafe10895ff833905d7a77c0d69d1af1226b62fe")
for k, v in hashes_from(os.path.join(P, "07-copy-postprocess-raw.stdout")).items():
    pre["postprocess-raw/" + k] = ("raw-new", v)

red = {}
red.update(report(os.path.join(P, "05-redact-top.stdout"), ""))
red.update(report(os.path.join(P, "06-redact-scratchpad.stdout"), "scratchpad/"))
red.update(report(os.path.join(P, "08-redact-postprocess-raw.stdout"), "postprocess-raw/"))
red["scratchpad/residual.sh"] = "account-name=3,windows-home=2"  # unwrapped staging step, see NOT_VERIFIABLE.md

rows, missing = [], []
for dp, _, fs in os.walk(R):
    for f in fs:
        rel = os.path.relpath(os.path.join(dp, f), R)
        if rel in ("MANIFEST.tsv", "SHA256SUMS"):
            continue
        cls, p = pre.get(rel, ("generated", "new"))
        if cls == "generated" and rel not in ("REDACTION.md", "NOT_VERIFIABLE.md", "postprocess-summary.md"):
            missing.append(rel)
        rows.append((rel, cls, p, sha(os.path.join(R, rel)), red.get(rel, "none") if cls != "generated" else "n/a"))
if missing:
    sys.exit("unclassified payload: %s" % missing)
unmatched = [k for k in pre if not os.path.exists(os.path.join(R, k))]
if unmatched:
    sys.exit("pre-hash entries without payload: %s" % unmatched)
rows.sort()
with open(os.path.join(R, "MANIFEST.tsv"), "w", encoding="utf-8", newline="\n") as f:
    f.write("path\tclass\tpre_redaction_sha256\tpublic_sha256\tredactions\n")
    for r in rows:
        f.write("\t".join(r) + "\n")
with open(os.path.join(R, "SHA256SUMS"), "w", encoding="utf-8", newline="\n") as f:
    for rel in sorted([r[0] for r in rows] + ["MANIFEST.tsv"]):
        f.write("%s  %s\n" % (sha(os.path.join(R, rel)), rel))
counts = {}
for r in rows:
    counts[r[1]] = counts.get(r[1], 0) + 1
print("payload=%d %s" % (len(rows), counts))
print("changed_by_redaction=%s" % [r[0] for r in rows if r[1] != "generated" and r[2] != r[3]])
print("unchanged_but_marked=%s" % [r[0] for r in rows if r[2] == r[3] and r[4] != "none"])
