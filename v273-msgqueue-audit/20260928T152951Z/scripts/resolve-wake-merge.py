#!/usr/bin/env python3
"""Mechanical resolution of the trial merge candidate + claude/v273-wake-liveness (reference only)."""
import re, sys
root = sys.argv[1]

def resolve(path, chooser):
    full = f"{root}/{path}"
    text = open(full, encoding="utf-8", newline="").read()
    pattern = re.compile(r"<<<<<<< HEAD\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n", re.S)
    index = [0]
    def repl(m):
        out = chooser(index[0], m.group(1), m.group(2)); index[0] += 1; return out
    new = pattern.sub(repl, text)
    assert "<<<<<<<" not in new, path
    open(full, "w", encoding="utf-8", newline="").write(new)

# server.ts: wake description + the capacity sentence from the candidate
D1 = " A receipt-capacity rejection with error.details (scope, earliestReleaseAt) is definite: nothing was queued, and a new prepare may succeed after that time."
def server(i, ours, theirs):
    return theirs.replace('",\n', D1 + '",\n', 1)
resolve("mcp-server/src/server.ts", server)

def service(i, ours, theirs):
    return 'import { BrokerRequestRejected, sessionMessageRequest } from "./session-message-client.js";\nimport type { SessionPresenceView } from "./session-message-store.js";\n'
resolve("mcp-server/src/session-message-service.ts", service)

def store(i, ours, theirs):
    if i == 0:  # keep both helper blocks
        return ours + "  }\n\n" + theirs if not ours.rstrip().endswith("}") else ours + theirs
    if i == 1:  # candidate capacity check + wake target variable
        return '      this.assertReceiptCapacity(sender, ".");\n      const receipt = this.send({ messageId, sender, target, body: String(row.body), ttlSeconds: Number(row.ttl_seconds) }, nowMs);\n'
    if i == 2:  # candidate ACK loop + wake activity record
        return ours + "      this.recordActivity(target, nowMs);\n"
    raise SystemExit(f"unexpected conflict {i}")
resolve("mcp-server/src/session-message-store.ts", store)
