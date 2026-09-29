#!/usr/bin/env python3
"""Apply one mutant to session-message-service.ts, run the presence tests, restore. Usage: mutants.py <log-dir>."""
import pathlib, subprocess, sys
SRC = pathlib.Path("mcp-server/src/session-message-service.ts")
GUARD = '        if (remaining <= 0) throw new Error("The board presence lookup reached its deadline.");\n'
BUDGET = ''',
          { totalTimeoutMs: remaining });'''
MUTANTS = {
    "BASELINE": [],
    "M1-wall-clock-deadline": [("const deadline = performance.now() + SESSION_MESSAGE_REQUEST_TIMEOUT_MS;", "const deadline = Date.now() + SESSION_MESSAGE_REQUEST_TIMEOUT_MS;"),
                               ("const remaining = deadline - performance.now();", "const remaining = deadline - Date.now();")],
    "D1-deadline-removed": [(GUARD, ""), (BUDGET, ");")],
    "D2-in-flight-answer-past-deadline-kept": [(BUDGET, ");")],
    "D3-deadline-per-batch": [("const remaining = deadline - performance.now();", "const remaining = SESSION_MESSAGE_REQUEST_TIMEOUT_MS;")],
    "D4-continue-after-failure": [("if (!(error instanceof BrokerRequestRejected)) { unanswered.push(...asked.slice(index)); break; }", "")],
}
TESTS = ["tests/session-messaging/presence-deadline.test.ts", "tests/session-messaging/presence-batches.test.ts",
         "tests/session-messaging/presence-retention.test.ts", "tests/session-board/session-board.test.ts"]
logs = pathlib.Path(sys.argv[1]); logs.mkdir(parents=True, exist_ok=True)
original = SRC.read_text(encoding="utf-8")
rows = []
try:
    for name, edits in MUTANTS.items():
        text = original
        for old, new in edits:
            assert text.count(old) == 1, (name, old[:60])
            text = text.replace(old, new)
        SRC.write_text(text, encoding="utf-8")
        run = subprocess.run(["npx", "vitest", "run", *TESTS], capture_output=True, text=True)
        out = run.stdout + run.stderr
        (logs / f"mutant-{name}.log").write_text(out, encoding="utf-8")
        failed = sorted({line.split(" > ", 1)[1].strip() for line in out.splitlines() if line.startswith(" FAIL ") and " > " in line})
        verdict = ("PASS" if run.returncode == 0 else "FAIL") if name == "BASELINE" else ("KILLED" if run.returncode != 0 else "SURVIVED")
        rows.append(f"{name}\t{verdict}\t{run.returncode}\t{len(failed)}\t" + " | ".join(failed[:6]))
        print(rows[-1], flush=True)
finally:
    SRC.write_text(original, encoding="utf-8")
(logs / "mutants.tsv").write_text("mutant\tverdict\texit\tfailed_tests\tfailures\n" + "\n".join(rows) + "\n", encoding="utf-8")
