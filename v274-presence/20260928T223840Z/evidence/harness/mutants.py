import subprocess, sys, os
E=sys.argv[1]
S='mcp-server/src/session-message-store.ts'; B='mcp-server/src/session-message-broker.ts'; P='mcp-server/src/session-message-protocol.ts'; V='mcp-server/src/session-message-service.ts'
M=[
 ("M1-live-by-birth", S, "DELETE FROM session_presence WHERE lease_until <= ?", "DELETE FROM session_presence WHERE started_at <= ?"),
 ("M2-no-latest-protection", S, "      AND NOT (EXISTS (SELECT 1 FROM session_presence live", "      AND NOT (0 AND EXISTS (SELECT 1 FROM session_presence live"),
 ("M3-retention-zero", S, ".run(iso(nowMs - PRESENCE_RETENTION_MS), now);", ".run(now, now);"),
 ("M4-retention-doubled", S, ".run(iso(nowMs - PRESENCE_RETENTION_MS), now);", ".run(iso(nowMs - 2 * PRESENCE_RETENTION_MS), now);"),
 ("M5-no-presence-prune", S, "DELETE FROM session_presence WHERE lease_until <= ?", "DELETE FROM session_presence WHERE 0 AND lease_until <= ?"),
 ("M6-batch-too-large", P, "SESSION_PRESENCE_LIST_MAX_TARGETS = 3;", "SESSION_PRESENCE_LIST_MAX_TARGETS = 100;"),
 ("M7-service-unbatched", V, "index += SESSION_PRESENCE_LIST_MAX_TARGETS) {\n        const batch = targets.slice(index, index + SESSION_PRESENCE_LIST_MAX_TARGETS)", "index += targets.length) {\n        const batch = targets"),
 ("M8-broker-ignores-targets", B, "store.listPresence(Date.now(), targets)", "store.listPresence(Date.now())"),
 ("M9-no-broker-size-check", B, "\"utf8\") > SESSION_MESSAGE_MAX_RESPONSE_BYTES) {\n        throw new Error(\"The presence list", "\"utf8\") > Infinity) {\n        throw new Error(\"The presence list"),
]
out=open(f"{E}/logs/mutants.tsv","w"); out.write("mutant\tfile\tresult\tfailed_tests\n")
for name,f,a,b in M:
    orig=open(f).read(); assert orig.count(a)==1,(name)
    open(f,"w").write(orig.replace(a,b))
    try:
        r=subprocess.run(["pnpm","exec","vitest","run","tests/session-messaging/presence-retention.test.ts"],capture_output=True,text=True,env={**os.environ,"PATH":"/opt/node24/bin:"+os.environ["PATH"]})
    finally:
        open(f,"w").write(orig)
    log=r.stdout+r.stderr
    open(f"{E}/logs/mutant-{name}.log","w").write(log+f"\nexit={r.returncode}\n")
    failed=[l.strip() for l in log.splitlines() if l.strip().startswith("×")]
    out.write(f"{name}\t{f}\t{'KILLED' if r.returncode!=0 else 'SURVIVED'}\t{' | '.join(failed)}\n")
out.close()
