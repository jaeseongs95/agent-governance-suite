#!/usr/bin/env python3
"""Apply one named mutant to the candidate source tree (audit only).

usage: mutants.py <repo-root> <mutant-id>   # applies the mutant, exits 0
       mutants.py --list
Each mutant is a list of exact (file, old, new, count) replacements; the script
fails if an anchor does not match the expected number of times.
"""
import sys

STORE = "mcp-server/src/session-message-store.ts"
SERVICE = "mcp-server/src/session-message-service.ts"
CLIENT = "mcp-server/src/session-message-client.ts"
BROKER = "mcp-server/src/session-message-broker.ts"

ASSERT_FN_OLD = """    const owned = this.database.prepare("SELECT count(*) AS count, min(expires_at) AS earliest FROM prepared_messages WHERE receipt IS NOT NULL AND sender_host = ? AND sender_session_id = ?")
      .get(sender.host, sender.sessionId) as { count: number; earliest: string | null };
    if (owned.count >= MESSAGE_SENDER_RECEIPT_LIMIT) {
      throw new MessageCapacityError(`The bounded message receipt store is full for this sender${suffix}`, { scope: "sender", earliestReleaseAt: owned.earliest });
    }
    const all = this.database.prepare("SELECT count(*) AS count, min(expires_at) AS earliest FROM prepared_messages WHERE receipt IS NOT NULL")
      .get() as { count: number; earliest: string | null };
    if (all.count >= MESSAGE_RECEIPT_LIMIT) throw new MessageCapacityError(`The bounded message receipt store is full${suffix}`, { scope: "global", earliestReleaseAt: all.earliest });"""
ASSERT_FN_GLOBAL_FIRST = """    const all = this.database.prepare("SELECT count(*) AS count, min(expires_at) AS earliest FROM prepared_messages WHERE receipt IS NOT NULL")
      .get() as { count: number; earliest: string | null };
    if (all.count >= MESSAGE_RECEIPT_LIMIT) throw new MessageCapacityError(`The bounded message receipt store is full${suffix}`, { scope: "global", earliestReleaseAt: all.earliest });
    const owned = this.database.prepare("SELECT count(*) AS count, min(expires_at) AS earliest FROM prepared_messages WHERE receipt IS NOT NULL AND sender_host = ? AND sender_session_id = ?")
      .get(sender.host, sender.sessionId) as { count: number; earliest: string | null };
    if (owned.count >= MESSAGE_SENDER_RECEIPT_LIMIT) {
      throw new MessageCapacityError(`The bounded message receipt store is full for this sender${suffix}`, { scope: "sender", earliestReleaseAt: owned.earliest });
    }"""

SUBMIT_HEAD = """    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.prune(nowMs);
      const row = this.database.prepare("SELECT * FROM prepared_messages WHERE message_id = ? AND sender_host = ? AND sender_session_id = ? AND expires_at > ?")"""
# Ported for the integrated tree: the duplicate branch now also computes autoWake (same meaning).
SUBMIT_DUP = """      if (row.receipt !== null) {
        const receipt = JSON.parse(String(row.receipt)) as { messageId: string; createdAt: string; expiresAt: string };
        const autoWake = this.autoWakeOutlook(target, nowMs);
        this.database.exec("COMMIT");
        return { ...receipt, duplicate: true, autoWake };
      }
      this.assertReceiptCapacity(sender, ".");"""

ACK_LOOP = """      for (const messageId of new Set(messageIds)) {
        if (statement.run(iso(nowMs), messageId, target.host, target.sessionId).changes !== 1) continue;
        receipt.run(iso(nowMs + MESSAGE_RECEIPT_EXTRA_MS), messageId);
        count++;
      }
      this.recordActivity(target, nowMs);
      this.database.exec("COMMIT");"""  # ported: wake recordActivity now shares the ACK transaction

MUTANTS = {
    "M01-F1-sender-limit-251": [(STORE, "MESSAGE_SENDER_RECEIPT_LIMIT = 250;", "MESSAGE_SENDER_RECEIPT_LIMIT = 251;", 1)],
    "M02-F1-sender-check-removed": [(STORE, "if (owned.count >= MESSAGE_SENDER_RECEIPT_LIMIT) {", "if (false && owned.count >= MESSAGE_SENDER_RECEIPT_LIMIT) {", 1)],
    "M03-F1-global-checked-first": [(STORE, ASSERT_FN_OLD, ASSERT_FN_GLOBAL_FIRST, 1)],
    "M04-F1-send-check-removed": [(STORE, "      this.assertReceiptCapacity(sender, \".\");\n", "", 1)],
    "M05-F1-capacity-before-duplicate": [(STORE, SUBMIT_DUP, """      this.assertReceiptCapacity(sender, ".");
      if (row.receipt !== null) {
        const receipt = JSON.parse(String(row.receipt)) as { messageId: string; createdAt: string; expiresAt: string };
        const autoWake = this.autoWakeOutlook(target, nowMs);
        this.database.exec("COMMIT");
        return { ...receipt, duplicate: true, autoWake };
      }""", 1)],
    "M06-F1-check-outside-transaction": [
        (STORE, "      this.assertReceiptCapacity(sender, \".\");\n", "", 1),
        (STORE, SUBMIT_HEAD, """    const pre = this.database.prepare("SELECT receipt FROM prepared_messages WHERE message_id = ?").get(messageId) as { receipt: string | null } | undefined;
    if (pre && pre.receipt === null) { this.prune(nowMs); this.assertReceiptCapacity(sender, "."); }
""" + SUBMIT_HEAD, 1),
    ],
    "M07-F2-changes-check-removed": [(STORE, "        if (statement.run(iso(nowMs), messageId, target.host, target.sessionId).changes !== 1) continue;",
                                      "        statement.run(iso(nowMs), messageId, target.host, target.sessionId);", 1)],
    "M08-F2-min-removed": [(STORE, "SET expires_at = min(expires_at, ?) WHERE", "SET expires_at = ? WHERE", 1)],
    "M09-F2-receipt-update-removed": [(STORE, "        receipt.run(iso(nowMs + MESSAGE_RECEIPT_EXTRA_MS), messageId);\n", "", 1)],
    "M10-F2-ack-without-1h": [(STORE, "receipt.run(iso(nowMs + MESSAGE_RECEIPT_EXTRA_MS), messageId);", "receipt.run(iso(nowMs), messageId);", 1)],
    "M11-F2-update-after-commit": [(STORE, ACK_LOOP, """      const acked: string[] = [];
      for (const messageId of new Set(messageIds)) {
        if (statement.run(iso(nowMs), messageId, target.host, target.sessionId).changes !== 1) continue;
        acked.push(messageId);
        count++;
      }
      this.recordActivity(target, nowMs);
      this.database.exec("COMMIT");
      for (const messageId of acked) receipt.run(iso(nowMs + MESSAGE_RECEIPT_EXTRA_MS), messageId);""", 1)],
    "M12-F3-prepare-admission-removed": [(STORE, "      this.assertReceiptCapacity(input.sender, \"; no draft was created.\");\n", "", 1)],
    "M13-F3-admission-before-prune": [(STORE, """      this.prune(nowMs);
      // Admission only; submitPrepared repeats the authoritative check.
      this.assertReceiptCapacity(input.sender, "; no draft was created.");""", """      // Admission only; submitPrepared repeats the authoritative check.
      this.assertReceiptCapacity(input.sender, "; no draft was created.");
      this.prune(nowMs);""", 1)],
    "M14-D1-broker-omits-details": [(BROKER, "...(error instanceof MessageCapacityError ? { details: error.details } : {})", "...({})", 1)],
    "M15-D1-client-drops-details": [(CLIENT, "new BrokerRequestRejected(response.error || \"The broker rejected the request.\", response.details)",
                                     "new BrokerRequestRejected(response.error || \"The broker rejected the request.\")", 1)],
    "M16-D1-service-details-null": [(SERVICE, "`${(error as Error).message} ${capacityRelease(details)}`, { ...details });", "`${(error as Error).message} ${capacityRelease(details)}`, null);", 1),
                                    (SERVICE, "${capacityRelease(details)}`, { ...details });", "${capacityRelease(details)}`, null);", 1)],
    "M17-D1-earliest-uses-max": [(STORE, "SELECT count(*) AS count, min(expires_at) AS earliest FROM prepared_messages WHERE receipt IS NOT NULL AND sender_host",
                                  "SELECT count(*) AS count, max(expires_at) AS earliest FROM prepared_messages WHERE receipt IS NOT NULL AND sender_host", 1),
                                 (STORE, "SELECT count(*) AS count, min(expires_at) AS earliest FROM prepared_messages WHERE receipt IS NOT NULL\")",
                                  "SELECT count(*) AS count, max(expires_at) AS earliest FROM prepared_messages WHERE receipt IS NOT NULL\")", 1)],
    "M18-D1-scope-label-swapped": [(STORE, "{ scope: \"sender\", earliestReleaseAt: owned.earliest }", "{ scope: \"global\", earliestReleaseAt: owned.earliest }", 1)],
    "M19-D1-send-uses-uncertain-guidance": [(SERVICE, "      if (details) return failure(\"MCP_UNAVAILABLE\", `${(error as Error).message} This definite rejection",
                                             "      if (false && details) return failure(\"MCP_UNAVAILABLE\", `${(error as Error).message} This definite rejection", 1)],
    "M20-D1-byte-rejection-no-details": [(STORE, "throw new MessageCapacityError(\"The bounded message receipt store is full.\", { scope: \"global\", earliestReleaseAt: bytes.earliest });",
                                          "throw new Error(\"The bounded message receipt store is full.\");", 1)],
    "M21-D1-definite-on-any-rejection": [(SERVICE, "return error instanceof BrokerRequestRejected ? error.details : null;",
                                          "return error instanceof BrokerRequestRejected ? (error.details ?? { scope: \"global\", earliestReleaseAt: null }) : null;", 1)],
    "M22-F1-sender-count-unfiltered": [(STORE, "min(expires_at) AS earliest FROM prepared_messages WHERE receipt IS NOT NULL AND sender_host = ? AND sender_session_id = ?\")\n      .get(sender.host, sender.sessionId)",
                                        "min(expires_at) AS earliest FROM prepared_messages WHERE receipt IS NOT NULL\")\n      .get()", 1)],
}


def main() -> int:
    if sys.argv[1] == "--list":
        print("\n".join(MUTANTS))
        return 0
    root, mutant = sys.argv[1], sys.argv[2]
    for path, old, new, expected in MUTANTS[mutant]:
        full = f"{root}/{path}"
        with open(full, encoding="utf-8", newline="") as handle:
            text = handle.read()
        found = text.count(old)
        if found != expected:
            print(f"{mutant}: anchor matched {found} times in {path}, expected {expected}", file=sys.stderr)
            return 2
        with open(full, "w", encoding="utf-8", newline="") as handle:
            handle.write(text.replace(old, new))
    return 0


if __name__ == "__main__":
    sys.exit(main())
