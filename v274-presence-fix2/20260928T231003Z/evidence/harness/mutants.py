import subprocess, sys, os
E=sys.argv[1]
S='mcp-server/src/session-message-store.ts'; B='mcp-server/src/session-message-broker.ts'; V='mcp-server/src/session-message-service.ts'
M=[
 ("F2a-isolation-reverted", V, "      } catch {\n        unanswered.push(...batch);\n      }", "      } catch (error) {\n        return failure(\"MCP_UNAVAILABLE\", error instanceof Error ? error.message : \"Session presence is unavailable.\");\n      }"),
 ("F2b-pattern-filter-removed", V, "(isBoundedIdentity({ host, sessionId }) ? asked : unanswered)", "(true ? asked : unanswered)"),
 ("A1-protects-oldest-not-latest", S, "AND latest.session_id = session_presence.session_id ORDER BY latest.started_at DESC, latest.rowid DESC LIMIT 1))", "AND latest.session_id = session_presence.session_id ORDER BY latest.started_at ASC, latest.rowid ASC LIMIT 1))"),
 ("A2-lapsed-counts-as-live", S, "AND live.session_id = session_presence.session_id AND live.ended_at IS NULL AND live.lease_until > ?)", "AND live.session_id = session_presence.session_id AND live.ended_at IS NULL AND (live.lease_until > ? OR 1))"),
 ("A3-service-drops-last-partial-batch", V, "for (let index = 0; index < asked.length; index += SESSION_PRESENCE_LIST_MAX_TARGETS) {", "for (let index = 0; index + SESSION_PRESENCE_LIST_MAX_TARGETS <= asked.length; index += SESSION_PRESENCE_LIST_MAX_TARGETS) {"),
 ("M1-live-by-birth", S, "DELETE FROM session_presence WHERE lease_until <= ?", "DELETE FROM session_presence WHERE started_at <= ?"),
 ("M5-no-presence-prune", S, "DELETE FROM session_presence WHERE lease_until <= ?", "DELETE FROM session_presence WHERE 0 AND lease_until <= ?"),
 ("M7-service-unbatched", V, "index += SESSION_PRESENCE_LIST_MAX_TARGETS) {\n      const batch = asked.slice(index, index + SESSION_PRESENCE_LIST_MAX_TARGETS);", "index += asked.length) {\n      const batch = asked;"),
 ("M9-no-broker-size-check", B, "\"utf8\") > SESSION_MESSAGE_MAX_RESPONSE_BYTES) {\n        throw new Error(\"The presence list", "\"utf8\") > Infinity) {\n        throw new Error(\"The presence list"),
]
tests=["tests/session-messaging/presence-retention.test.ts","tests/session-messaging/presence-batches.test.ts","tests/session-board/session-board.test.ts"]
env={**os.environ,"PATH":"/opt/node24/bin:"+os.environ["PATH"]}
out=open(f"{E}/logs/mutants.tsv","w"); out.write("mutant\tfile\tresult\tfailed_tests\n")
for name,f,a,b in [("BASELINE",V,"","")]+M:
    orig=open(f).read()
    if a: assert orig.count(a)==1,name; open(f,"w").write(orig.replace(a,b))
    try: r=subprocess.run(["pnpm","exec","vitest","run",*tests],capture_output=True,text=True,env=env)
    finally: open(f,"w").write(orig)
    log=r.stdout+r.stderr
    open(f"{E}/logs/mutant-{name}.log","w").write(log+f"\nexit={r.returncode}\n")
    failed=[l.strip() for l in log.splitlines() if l.strip().startswith("×")]
    res=("PASS" if r.returncode==0 else "FAIL") if name=="BASELINE" else ("KILLED" if r.returncode!=0 else "SURVIVED")
    out.write(f"{name}\t{f}\t{res}\t{' | '.join(failed)}\n")
out.close()
