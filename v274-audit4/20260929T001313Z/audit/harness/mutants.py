# Audit mutation run: writer's M1/M2/M5/M7/M9 (same replacements) plus auditor mutants A1-A3.
import subprocess, sys, os
W="/home/[REDACTED]/ags-v274d"; L="/home/[REDACTED]/v274d/logs"
S='mcp-server/src/session-message-store.ts'; B='mcp-server/src/session-message-broker.ts'; V='mcp-server/src/session-message-service.ts'
M=[
 ("M1-live-by-birth", S, "DELETE FROM session_presence WHERE lease_until <= ?", "DELETE FROM session_presence WHERE started_at <= ?"),
 ("M5-no-presence-prune", S, "DELETE FROM session_presence WHERE lease_until <= ?", "DELETE FROM session_presence WHERE 0 AND lease_until <= ?"),
 ("M7-service-unbatched", V, "index += SESSION_PRESENCE_LIST_MAX_TARGETS) {\n      const batch = asked.slice(index, index + SESSION_PRESENCE_LIST_MAX_TARGETS)", "index += asked.length) {\n      const batch = asked"),
 ("M9-no-broker-size-check", B, "\"utf8\") > SESSION_MESSAGE_MAX_RESPONSE_BYTES) {\n        throw new Error(\"The presence list", "\"utf8\") > Infinity) {\n        throw new Error(\"The presence list"),
 ("A1-protects-oldest-not-latest", S, "AND latest.session_id = session_presence.session_id ORDER BY latest.started_at DESC, latest.rowid DESC LIMIT 1))", "AND latest.session_id = session_presence.session_id ORDER BY latest.started_at ASC, latest.rowid ASC LIMIT 1))"),
 ("A2-lapsed-counts-as-live", S, "AND live.session_id = session_presence.session_id AND live.ended_at IS NULL AND live.lease_until > ?)", "AND live.session_id = session_presence.session_id AND live.ended_at IS NULL AND (live.lease_until > ? OR 1))"),
 ("A3-service-drops-last-partial-batch", V, "for (let index = 0; index < asked.length; index += SESSION_PRESENCE_LIST_MAX_TARGETS) {", "for (let index = 0; index + SESSION_PRESENCE_LIST_MAX_TARGETS <= asked.length; index += SESSION_PRESENCE_LIST_MAX_TARGETS) {"),
 ("F2-isolation-reverted", V, "        unanswered.push(...batch);\n", "        return ok({ sessions: [], unanswered: [...asked, ...unanswered] });\n"),
 ("F2-pattern-filter-removed", V, "(isBoundedIdentity({ host, sessionId }) ? asked : unanswered)", "(true ? asked : unanswered)"),
 ("F4-continue-after-transport-failure", V, "        if (!(error instanceof BrokerRequestRejected)) { unanswered.push(...asked.slice(index)); break; }\n", ""),
 ("F4-stop-on-refusal-too", V, "if (!(error instanceof BrokerRequestRejected)) { unanswered.push(...asked.slice(index)); break; }", "if (true) { unanswered.push(...asked.slice(index)); break; }"),
 ("L1-lease-ignored-for-online", S, 'state: endedAt ? "ended" : Date.parse(leaseUntil) > nowMs ? "online" : "unreachable",', 'state: endedAt ? "ended" : "online",'),
 ("F2-server-ignores-unanswered", "mcp-server/src/server.ts", "presence.ok && !unanswered.has(key(session))", "presence.ok"),
]
env={**os.environ,"PATH":"/opt/node24/bin:"+os.environ["PATH"]}
out=open(f"{L}/mutants.tsv","w"); out.write("mutant\tcandidate_tests(presence-retention+presence-batches+session-board)\tfailed\taudit_tests(v274-audit)\taudit_failed\n")
for name,f,a,b in [("BASELINE",None,None,None)]+M:
    p=os.path.join(W,f) if f else None
    orig=open(p).read() if p else None
    if p:
        assert orig.count(a)==1,(name); open(p,"w").write(orig.replace(a,b))
    try:
        r=subprocess.run(["pnpm","exec","vitest","run","tests/session-messaging/presence-retention.test.ts","tests/session-messaging/presence-batches.test.ts","tests/session-board"],cwd=W,capture_output=True,text=True,env=env)
        r2=subprocess.CompletedProcess([],0,"","")
    finally:
        if p: open(p,"w").write(orig)
    open(f"{L}/mutant-{name}.log","w").write(r.stdout+r.stderr+f"\nexit={r.returncode}\n--- audit ---\n"+r2.stdout+r2.stderr+f"\nexit={r2.returncode}\n")
    f1=[l.strip() for l in (r.stdout+r.stderr).splitlines() if l.strip().startswith("×")]
    f2=[l.strip() for l in (r2.stdout+r2.stderr).splitlines() if l.strip().startswith("×")]
    out.write(f"{name}\t{'KILLED' if r.returncode else 'SURVIVED'}\t{len(f1)}\t{'KILLED' if r2.returncode else 'SURVIVED'}\t{len(f2)}\n"); out.flush()
out.close()
