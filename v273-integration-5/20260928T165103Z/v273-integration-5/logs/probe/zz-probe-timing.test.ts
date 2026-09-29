// Temporary probe (not committed): time the fill phase of the file-backed capacity test.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "vitest";
import { SessionMessageStore, MESSAGE_RECEIPT_LIMIT } from "../../mcp-server/src/session-message-store.js";
const target = { host: "test-host", sessionId: "retention-target" };
const hot = { host: "test-host", sessionId: "retention-hot" };
function sendNew(store: SessionMessageStore, sender: typeof hot, nowMs: number) {
  const draft = store.prepare({ sender, target, body: "Synthetic retention message" }, nowMs);
  return store.submitPrepared(sender, draft.messageId, nowMs);
}
for (const mode of ["memory", "FULL", "NORMAL", "OFF"]) {
  it(`fill ${mode}`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ags-probe-"));
    const store = new SessionMessageStore(mode === "memory" ? ":memory:" : path.join(dir, "db.sqlite3"));
    if (mode !== "memory") store.database.exec(`PRAGMA synchronous = ${mode};`);
    const now = Date.now();
    const t0 = performance.now();
    for (let i = 0; i < 249; i++) sendNew(store, hot, now);
    const t1 = performance.now();
    for (let i = 250; i < MESSAGE_RECEIPT_LIMIT; i++) sendNew(store, { host: "test-host", sessionId: `retention-global-${i % 3}` }, now);
    const t2 = performance.now();
    console.log(`PROBE ${mode} sender249=${(t1 - t0).toFixed(0)}ms global750=${(t2 - t1).toFixed(0)}ms total=${(t2 - t0).toFixed(0)}ms`);
    store.close(); await rm(dir, { recursive: true, force: true });
  }, 120_000);
}
