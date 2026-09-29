#!/usr/bin/env python3
"""Apply one clock mutant to session-message-service.ts at 906a023a, run the presence tests, restore. Usage: mutants2.py <log-dir>."""
import pathlib, subprocess, sys
SRC = pathlib.Path("mcp-server/src/session-message-service.ts")
DEADLINE = "const deadline = performance.now() + SESSION_MESSAGE_REQUEST_TIMEOUT_MS;"
REMAINING = "const remaining = deadline - performance.now();"
MUTANTS = {
    "BASELINE": [],
    "C1-both-Date.now (93a7e4bc behaviour)": [(DEADLINE, "const deadline = Date.now() + SESSION_MESSAGE_REQUEST_TIMEOUT_MS;"), (REMAINING, "const remaining = deadline - Date.now();")],
    "C2-deadline-Date.now-only": [(DEADLINE, "const deadline = Date.now() + SESSION_MESSAGE_REQUEST_TIMEOUT_MS;")],
    "C3-remaining-Date.now-only": [(REMAINING, "const remaining = deadline - Date.now();")],
    "C4-perf_hooks-import (equivalent)": [(DEADLINE, "const deadline = (await import(\"node:perf_hooks\")).performance.now() + SESSION_MESSAGE_REQUEST_TIMEOUT_MS;")],
}
TESTS = ["tests/session-messaging/presence-deadline.test.ts", "tests/session-messaging/presence-batches.test.ts",
         "tests/session-messaging/presence-retention.test.ts", "tests/session-board/session-board.test.ts"]
logs = pathlib.Path(sys.argv[1]); logs.mkdir(parents=True, exist_ok=True)
original = SRC.read_text(encoding="utf-8")
try:
    for name, edits in MUTANTS.items():
        text = original
        for old, new in edits:
            assert text.count(old) == 1, (name, old[:60])
            text = text.replace(old, new)
        SRC.write_text(text, encoding="utf-8")
        run = subprocess.run(["pnpm", "exec", "vitest", "run", *TESTS], capture_output=True, text=True)
        out = run.stdout + run.stderr
        slug = name.split(" ")[0]
        (logs / f"mutant-{slug}.log").write_text(out, encoding="utf-8")
        failed = sorted({line.split(" > ", 1)[1].strip() for line in out.splitlines() if line.strip().startswith(("FAIL", "×")) and " > " in line} |
                        {line.strip()[2:].strip() for line in out.splitlines() if line.strip().startswith("× ")})
        verdict = ("PASS" if run.returncode == 0 else "FAIL") if name == "BASELINE" else ("KILLED" if run.returncode != 0 else "SURVIVED")
        print(f"{name}\t{verdict}\trc={run.returncode}\t" + " | ".join(failed[:6]), flush=True)
finally:
    SRC.write_text(original, encoding="utf-8")
