#!/usr/bin/env python3
"""Apply one mutant to session-message-store.ts, run the wake tests, restore. Usage: mutants.py <log-dir>."""
import pathlib, subprocess, sys
SRC = pathlib.Path("mcp-server/src/session-message-store.ts")
LIVE = """coalesce((SELECT NOT (latest.ended_at IS NULL AND latest.lease_until > ?
              AND latest.instance_id = wake_nonces.instance_id AND latest.started_at = wake_nonces.birth_generation)
            FROM session_presence latest WHERE latest.host = wake_nonces.host AND latest.session_id = wake_nonces.session_id
            ORDER BY latest.started_at DESC, latest.rowid DESC LIMIT 1), 1)"""
MUTANTS = {
    "BASELINE": [],
    # The 2.7.4 rule: only a newer live birth is evidence.
    "N1-new-evidence-removed": [(LIVE, """coalesce((SELECT latest.ended_at IS NULL AND latest.lease_until > ? AND latest.started_at > wake_nonces.birth_generation
            FROM session_presence latest WHERE latest.host = wake_nonces.host AND latest.session_id = wake_nonces.session_id
            ORDER BY latest.started_at DESC, latest.rowid DESC LIMIT 1), 0)""")],
    "N2-grace-removed": [(".run(now, iso(nowMs - WAKE_RETIRE_GRACE_MS), now);", ".run(now, now, now);")],
    "N3-live-inverted": [("NOT (latest.ended_at IS NULL AND latest.lease_until > ?", "NOT (latest.ended_at IS NULL AND latest.lease_until <= ?")],
    "N4-session-only": [(LIVE, """NOT EXISTS (SELECT 1 FROM session_presence live WHERE live.host = wake_nonces.host
              AND live.session_id = wake_nonces.session_id AND live.ended_at IS NULL AND live.lease_until > ?)""")],
    "N5-binding-dropped": [("""
              AND latest.instance_id = wake_nonces.instance_id AND latest.started_at = wake_nonces.birth_generation)""", ")")],
    # Audit mutants that survived 3501e7c's tests.
    "A2-lease-boundary-ge": [("NOT (latest.ended_at IS NULL AND latest.lease_until > ?", "NOT (latest.ended_at IS NULL AND latest.lease_until >= ?")],
    "A4-generation-only": [("AND latest.instance_id = wake_nonces.instance_id AND latest.started_at = wake_nonces.birth_generation)", "AND latest.started_at = wake_nonces.birth_generation)")],
    "A6-oldest-row": [("ORDER BY latest.started_at DESC, latest.rowid DESC LIMIT 1), 1))", "ORDER BY latest.started_at ASC, latest.rowid ASC LIMIT 1), 1))")],
    "N6-transport-bound": [("AND latest.started_at = wake_nonces.birth_generation)", "AND latest.started_at = wake_nonces.birth_generation AND latest.transport = wake_nonces.transport)")],
}
TESTS = ["tests/session-messaging/wake-liveness.test.mjs", "tests/session-messaging/presence-retention.test.ts", "tests/session-messaging/session-message.test.ts"]
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
(logs / "mutants.tsv").write_text("mutant\tverdict\texit\tfailed_tests\tfirst_failures\n" + "\n".join(rows) + "\n", encoding="utf-8")
