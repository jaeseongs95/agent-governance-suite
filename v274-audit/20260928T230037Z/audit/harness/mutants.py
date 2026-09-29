# Audit mutation run: writer's M1/M2/M5/M7/M9 (same replacements) plus auditor mutants A1-A3.
import subprocess, sys, os
W="/home/[REDACTED]/ags-v274"; L="/home/[REDACTED]/v274/logs0f"
S='mcp-server/src/session-message-store.ts'; B='mcp-server/src/session-message-broker.ts'; V='mcp-server/src/session-message-service.ts'
M=[
 ("M1-live-by-birth", S, "DELETE FROM session_presence WHERE lease_until <= ?", "DELETE FROM session_presence WHERE started_at <= ?"),
 ("M2-no-latest-protection", S, "      AND NOT (EXISTS (SELECT 1 FROM session_presence live", "      AND NOT (0 AND EXISTS (SELECT 1 FROM session_presence live"),
 ("M5-no-presence-prune", S, "DELETE FROM session_presence WHERE lease_until <= ?", "DELETE FROM session_presence WHERE 0 AND lease_until <= ?"),
 ("M7-service-unbatched", V, "index += SESSION_PRESENCE_LIST_MAX_TARGETS) {\n        const batch = targets.slice(index, index + SESSION_PRESENCE_LIST_MAX_TARGETS)", "index += targets.length) {\n        const batch = targets"),
 ("M9-no-broker-size-check", B, "\"utf8\") > SESSION_MESSAGE_MAX_RESPONSE_BYTES) {\n        throw new Error(\"The presence list", "\"utf8\") > Infinity) {\n        throw new Error(\"The presence list"),
 ("A1-protects-oldest-not-latest", S, "AND latest.session_id = session_presence.session_id ORDER BY latest.started_at DESC, latest.rowid DESC LIMIT 1))", "AND latest.session_id = session_presence.session_id ORDER BY latest.started_at ASC, latest.rowid ASC LIMIT 1))"),
 ("A2-lapsed-counts-as-live", S, "AND live.session_id = session_presence.session_id AND live.ended_at IS NULL AND live.lease_until > ?)", "AND live.session_id = session_presence.session_id AND live.ended_at IS NULL AND (live.lease_until > ? OR 1))"),
 ("A3-service-drops-last-partial-batch", V, "for (let index = 0; index < targets.length; index += SESSION_PRESENCE_LIST_MAX_TARGETS) {", "for (let index = 0; index + SESSION_PRESENCE_LIST_MAX_TARGETS <= targets.length; index += SESSION_PRESENCE_LIST_MAX_TARGETS) {"),
]
env={**os.environ,"PATH":"/opt/node24/bin:"+os.environ["PATH"]}
out=open(f"{L}/mutants.tsv","w"); out.write("mutant\tcandidate_tests(presence-retention+session-board)\tfailed\taudit_tests(v274-audit)\taudit_failed\n")
for name,f,a,b in [("BASELINE",None,None,None)]+M:
    p=os.path.join(W,f) if f else None
    orig=open(p).read() if p else None
    if p:
        assert orig.count(a)==1,(name); open(p,"w").write(orig.replace(a,b))
    try:
        r=subprocess.run(["pnpm","exec","vitest","run","tests/session-messaging/presence-retention.test.ts","tests/session-board"],cwd=W,capture_output=True,text=True,env=env)
        r2=subprocess.run(["pnpm","exec","vitest","run","tests/audit/v274-audit.test.ts","-t","^(R|S)"],cwd=W,capture_output=True,text=True,env=env)
    finally:
        if p: open(p,"w").write(orig)
    open(f"{L}/mutant-{name}.log","w").write(r.stdout+r.stderr+f"\nexit={r.returncode}\n--- audit ---\n"+r2.stdout+r2.stderr+f"\nexit={r2.returncode}\n")
    f1=[l.strip() for l in (r.stdout+r.stderr).splitlines() if l.strip().startswith("×")]
    f2=[l.strip() for l in (r2.stdout+r2.stderr).splitlines() if l.strip().startswith("×")]
    out.write(f"{name}\t{'KILLED' if r.returncode else 'SURVIVED'}\t{len(f1)}\t{'KILLED' if r2.returncode else 'SURVIVED'}\t{len(f2)}\n"); out.flush()
out.close()
