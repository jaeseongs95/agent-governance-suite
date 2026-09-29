#!/usr/bin/env python3
# Applies one tamper case to a worktree copy. Usage: tamper.py <case> <dir>
import sys, os, re, hashlib, pathlib
case, d = sys.argv[1], pathlib.Path(sys.argv[2])
def flip(rel, pos=None):
    p = d/rel; b = bytearray(p.read_bytes())
    i = len(b)//2 if pos is None else pos
    # choose an ASCII letter near middle to keep UTF-8 valid
    while not (65 <= b[i] <= 122 and chr(b[i]).isalpha()): i += 1
    old = b[i]; b[i] ^= 0x20  # toggle case: exactly one byte changes
    p.write_bytes(bytes(b)); print(f"{rel}: byte {i} {chr(old)!r}->{chr(b[i])!r}")
chk = d/"scripts/check-skill-context-optimization.mjs"
def repin(kind, value):
    s = chk.read_text(); new = re.sub(rf'({kind}: ")[0-9a-f]{{64}}(")', rf'\g<1>{value}\2', s, count=1)
    assert new != s; chk.write_text(new); print(f"repinned {kind} -> {value}")
if case == "a1-orch-skill-body":     flip("skills/orchestrator/SKILL.md", 4000 if False else 2500)
elif case == "a2-orch-frontmatter":  flip("skills/orchestrator/SKILL.md", 60)
elif case == "a3-orch-entry-details": flip("skills/orchestrator/references/entry-details.md")
elif case == "a4-orch-mcp-execution": flip("skills/orchestrator/references/mcp-execution.md")
elif case == "a5-orch-unpinned-ref": flip("skills/orchestrator/references/collaboration.md")
elif case == "b1-other-skill-md":    flip("skills/task-contract/SKILL.md")
elif case == "b2-other-entry-details": flip("skills/session-board/references/entry-details.md")
elif case == "b3-other-skill-script":
    import glob; f = sorted(p for p in (d/"skills/task-contract").rglob("*") if p.is_file() and p.suffix in (".mjs",".py",".json") )[0]
    flip(str(f.relative_to(d)))
elif case == "b4-ponytail":
    f = sorted(p for p in (d/"skills/ponytail").rglob("*.md"))[0]; flip(str(f.relative_to(d)))
elif case == "b5-other-openai-yaml": flip("skills/task-contract/agents/openai.yaml")
elif case == "b6-untracked-new-file-in-skill":
    (d/"skills/task-contract/references/extra.md").write_text("injected\n"); print("added untracked skills/task-contract/references/extra.md")
elif case == "c1-registry":          flip("skills/registry.json")
elif case == "d1-orch-over-4585":
    p = d/"skills/orchestrator/SKILL.md"; b = p.read_bytes(); pad = b"\n" + b"x"*(4586-len(b)) + b"\n"
    p.write_bytes(b+pad); print(f"SKILL.md {len(b)} -> {len(b+pad)} bytes")
elif case == "d2-orch-over-4585-repinned":
    # same size tamper, but the reconstructed/frontmatter pins are updated to match the new bytes,
    # so only the byte ceiling can reject. Uses the checker's own reconstruct function.
    p = d/"skills/orchestrator/SKILL.md"; b = p.read_bytes(); pad = b"\n" + b"x"*(4586-len(b)) + b"\n"
    p.write_bytes(b+pad); print(f"SKILL.md {len(b)} -> {len(b+pad)} bytes")
    import subprocess
    out = subprocess.check_output(["node","--input-type=module","-e",
        "import {reconstructOptimizedSkill} from './scripts/check-skill-context-optimization.mjs';import {createHash} from 'node:crypto';process.stdout.write(createHash('sha256').update(reconstructOptimizedSkill('orchestrator')).digest('hex'))"], cwd=d).decode()
    repin("reconstructed", out)
elif case == "d3-exactly-4585-repinned":
    p = d/"skills/orchestrator/SKILL.md"; b = p.read_bytes(); pad = b"\n" + b"x"*(4585-len(b)-2) + b"\n"
    p.write_bytes(b+pad); print(f"SKILL.md {len(b)} -> {len(b+pad)} bytes (boundary, expect accept on size)")
    import subprocess
    out = subprocess.check_output(["node","--input-type=module","-e",
        "import {reconstructOptimizedSkill} from './scripts/check-skill-context-optimization.mjs';import {createHash} from 'node:crypto';process.stdout.write(createHash('sha256').update(reconstructOptimizedSkill('orchestrator')).digest('hex'))"], cwd=d).decode()
    repin("reconstructed", out)
elif case == "e1-pin-reconstructed":  repin("reconstructed", "0"*64)
elif case == "e2-pin-frontmatter":    repin("frontmatter", "f"*64)
elif case == "e3-pin-mcpExecution":   repin("mcpExecution", hashlib.sha256(b"x").hexdigest())
elif case == "e4-pin-maxbytes-lowered":
    s = chk.read_text(); chk.write_text(s.replace("initialMaxBytes: 4585", "initialMaxBytes: 3000")); print("initialMaxBytes 4585->3000")
elif case == "f1-delete-mcp-execution": os.remove(d/"skills/orchestrator/references/mcp-execution.md"); print("deleted mcp-execution.md")
elif case == "f2-delete-entry-details": os.remove(d/"skills/orchestrator/references/entry-details.md"); print("deleted orchestrator entry-details.md")
elif case == "f3-delete-orch-skill-md": os.remove(d/"skills/orchestrator/SKILL.md"); print("deleted orchestrator SKILL.md")
elif case == "f4-delete-session-board-fixture": os.remove(d/"scripts/fixtures/session-board-peer-message-guidance.2.6.0.md"); print("deleted session-board fixture")
elif case == "a1b-orch-skill-body-tail":  flip("skills/orchestrator/SKILL.md", 3800)
elif case == "b7-staged-new-file-in-skill":
    import subprocess; (d/"skills/task-contract/references/extra.md").write_text("injected\n")
    subprocess.check_call(["git","-C",str(d),"add","skills/task-contract/references/extra.md"]); print("added+staged skills/task-contract/references/extra.md")
elif case == "z0-control": print("no change")
else: sys.exit("unknown case")
