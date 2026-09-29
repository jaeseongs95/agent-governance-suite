#!/usr/bin/env python3
"""Q audit mutants M03, M05, M11, M20 for the integration tree.
M03 and M20 reuse the audit anchors unchanged. M05 and M11 keep the audit meaning but
use anchors that include the wake additions (autoWake on duplicate, recordActivity in ACK)."""
import sys, importlib.util
spec = importlib.util.spec_from_file_location("audit", sys.argv[0].replace("mutants-integration.py", "mutants.py"))
audit = importlib.util.module_from_spec(spec); spec.loader.exec_module(audit)
STORE = audit.STORE
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
      this.database.exec("COMMIT");"""
MUTANTS = {
    "M03-F1-global-checked-first": audit.MUTANTS["M03-F1-global-checked-first"],
    "M05-F1-capacity-before-duplicate": [(STORE, SUBMIT_DUP, """      this.assertReceiptCapacity(sender, ".");
      if (row.receipt !== null) {
        const receipt = JSON.parse(String(row.receipt)) as { messageId: string; createdAt: string; expiresAt: string };
        const autoWake = this.autoWakeOutlook(target, nowMs);
        this.database.exec("COMMIT");
        return { ...receipt, duplicate: true, autoWake };
      }""", 1)],
    "M11-F2-update-after-commit": [(STORE, ACK_LOOP, """      const acked: string[] = [];
      for (const messageId of new Set(messageIds)) {
        if (statement.run(iso(nowMs), messageId, target.host, target.sessionId).changes !== 1) continue;
        acked.push(messageId);
        count++;
      }
      this.recordActivity(target, nowMs);
      this.database.exec("COMMIT");
      for (const messageId of acked) receipt.run(iso(nowMs + MESSAGE_RECEIPT_EXTRA_MS), messageId);""", 1)],
    "M20-D1-byte-rejection-no-details": audit.MUTANTS["M20-D1-byte-rejection-no-details"],
}
root, mutant = sys.argv[1], sys.argv[2]
for path, old, new, expected in MUTANTS[mutant]:
    full = f"{root}/{path}"
    text = open(full, encoding="utf-8", newline="").read()
    if text.count(old) != expected:
        print(f"{mutant}: anchor matched {text.count(old)} times in {path}", file=sys.stderr); sys.exit(2)
    open(full, "w", encoding="utf-8", newline="").write(text.replace(old, new))
