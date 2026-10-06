#!/usr/bin/env python3
"""cmp_install.py <generated.tsv> <installed.tsv>: compare claude-plugin/* rows with install-root rows."""
import json, sys


def load(p, prefix=None):
    out = {}
    for line in open(p):
        path, size, h = line.rstrip("\n").split("\t")
        if prefix is not None:
            if not path.startswith(prefix):
                continue
            path = path[len(prefix):]
        out[path] = (size, h)
    return out


gen = load(sys.argv[1], "claude-plugin/")
ins = load(sys.argv[2])
match = [p for p in gen if p in ins and gen[p] == ins[p]]
mismatch = [p for p in gen if p in ins and gen[p] != ins[p]]
missing = [p for p in gen if p not in ins]
extra = [p for p in ins if p not in gen]
print(json.dumps({"repoClaudePlugin": len(gen), "installed": len(ins), "match": len(match), "mismatch": mismatch,
                  "missing": missing, "extra": extra}, indent=1))
