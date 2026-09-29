#!/usr/bin/env python3
"""Mechanical resolution of claude/v273-integration (HEAD) + candidate 74395bf6 (theirs). Reference only."""
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

def server(i, ours, theirs):
    # integration (wake) sentences + candidate capacity sentences (the part after "prepare again only for a new intent.")
    tail = theirs.split("prepare again only for a new intent.", 1)[1].split('",', 1)[0]
    return ours.replace('",\n', tail + '",\n', 1)
resolve("mcp-server/src/server.ts", server)
resolve("mcp-server/src/session-message-service.ts", lambda i, o, t:
    'import { BrokerRequestRejected, sessionMessageRequest } from "./session-message-client.js";\nimport type { SessionPresenceView } from "./session-message-store.js";\n')
def store(i, ours, theirs):
    if i == 0: return ours + "  }\n\n" + theirs
    if i == 1: return '      this.assertReceiptCapacity(sender, ".");\n      const receipt = this.send({ messageId, sender, target, body: String(row.body), ttlSeconds: Number(row.ttl_seconds) }, nowMs);\n'
    if i == 2: return theirs + "      this.recordActivity(target, nowMs);\n"
    raise SystemExit(f"unexpected conflict {i}")
resolve("mcp-server/src/session-message-store.ts", store)
