#!/usr/bin/env python3
"""skillbody.py <stream.jsonl> <repo_claude_plugin> <install_root>: compare skill text injected into the
child transcript with SKILL.md bytes on disk (frontmatter stripped)."""
import hashlib, json, re, sys

stream, repo_cp, inst = sys.argv[1:4]
H = lambda s: hashlib.sha256(s.encode()).hexdigest()


def body(p):
    t = open(p, encoding="utf-8").read()
    m = re.match(r"^---\n.*?\n---\n", t, re.S)
    return t[m.end():] if m else t


for line in open(stream):
    e = json.loads(line)
    if e.get("type") != "user" or not e.get("isSynthetic"):
        continue
    for c in e["message"]["content"]:
        t = c.get("text", "")
        m = re.match(r"Base directory for this skill: (\S+)\n\n", t)
        if not m:
            continue
        base = m.group(1); loaded = t[m.end():]
        name = base.rstrip("/").split("/")[-1]
        res = {"skill": name, "baseDirectory": base, "loadedSha256": H(loaded), "loadedChars": len(loaded)}
        for label, root in (("repoClaudePlugin", repo_cp), ("installRoot", inst)):
            b = body(f"{root}/skills/{name}/SKILL.md")
            res[label] = {"bodySha256": H(b), "equal": b == loaded, "equalStripped": b.strip() == loaded.strip()}
        print(json.dumps(res))
