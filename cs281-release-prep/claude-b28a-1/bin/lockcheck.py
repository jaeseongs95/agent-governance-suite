#!/usr/bin/env python3
"""lockcheck.py <lock.json> <base_dir>: verify each declared file digest against bytes on disk."""
import hashlib, json, os, sys

lock, base = sys.argv[1], sys.argv[2]
d = json.load(open(lock))
files = d["files"]
match = mismatch = missing = 0
for f in files:
    p = os.path.join(base, f["path"])
    if not os.path.isfile(p):
        missing += 1
        print("MISSING", f["path"])
        continue
    h = "sha256:" + hashlib.sha256(open(p, "rb").read()).hexdigest()
    if h == f["digest"]:
        match += 1
    else:
        mismatch += 1
        print("MISMATCH", f["path"], f["digest"], h)
print(json.dumps({"lock": lock, "base": base, "declared": len(files), "match": match, "mismatch": mismatch, "missing": missing, "topKeys": sorted(d.keys())}))
