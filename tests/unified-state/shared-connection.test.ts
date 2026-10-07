import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { InactiveSharedConnection } from "../../runtime/unified-state/shared-connection.mjs";
import { createInactiveSharedStores } from "../../mcp-server/src/inactive-shared-stores.js";

const directories: string[] = [];
const owners = new Set<InactiveSharedConnection>();
const keys = { workflow: Buffer.alloc(32, 1).toString("base64url"), continuity: Buffer.alloc(32, 2).toString("base64url"), trust: Buffer.alloc(32, 3).toString("base64url") };
function directory() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ags-r2-owner-")); directories.push(dir); return dir; }
function bundle(dir = directory(), clock = () => 100) { const value = createInactiveSharedStores({ directory: dir, mode: "fixture-only", clock, syntheticKeys: keys }); owners.add(value.owner); return value; }
afterEach(() => {
  for (const owner of owners) owner.close(); owners.clear();
  for (const dir of directories.splice(0)) { expect(path.dirname(path.resolve(dir))).toBe(path.resolve(os.tmpdir())); expect(path.basename(dir)).toMatch(/^ags-r2-owner-/u); fs.rmSync(dir, { recursive: true }); }
});

describe("inactive native shared connection", () => {
  it("B2-OWNER-01: actual schemas, module versions and rows use one physical main connection", () => {
    const value = bundle();
    value.workflow.nextRunSequence(); value.continuity.ensureTask("synthetic-correlation", new Date(100).toISOString());
    value.messaging.send({ sender: { host: "fixture-a", sessionId: "s" }, target: { host: "fixture-b", sessionId: "r" }, messageId: "owner-message", body: "synthetic" }, 100);
    const snapshot = value.owner.inspect();
    expect(snapshot.databases.filter(row => row.file !== "")).toHaveLength(1); expect(snapshot.databases[0]).toMatchObject({ name: "main", file: value.owner.databasePath }); expect(snapshot.databases.every(row => row.name === "main" || row.name === "temp" && row.file === "")).toBe(true);
    expect(Object.keys(snapshot.counts)).toHaveLength(30); expect(snapshot.counts.messages).toBe(1); expect(snapshot.counts.continuity_tasks).toBe(1);
    expect(snapshot.modules.map(row => [row.module, row.version])).toEqual([["board", 0], ["continuity", 2], ["messaging", 1], ["trust", 1], ["workflow", 5]]);
    expect(snapshot.userVersion).toBe(1); expect(value.workflow.getSchemaVersion()).toBe(5); expect(value.continuity.getSchemaVersion()).toBe(2);
    expect(snapshot.integrity).toEqual([{ integrity_check: "ok" }]); expect(snapshot.foreignKeyViolations).toEqual([]);
    console.log("B2-RAW owner", JSON.stringify(snapshot));
  });
  it("B2-OWNER-02: closed adapter/captured statement cannot close or outlive other borrowed modules", () => {
    const value = bundle(); const statement = value.messaging.database.prepare("SELECT count(*) AS n FROM messages");
    value.messaging.close(); expect(() => statement.get()).toThrow(/borrowed module handle is closed/u);
    expect(value.workflow.nextRunSequence()).toBe(1); value.trust.close(); expect(value.continuity.ensureTask("survivor", "1970-01-01T00:00:00.100Z").currentEpoch).toBe(1);
    value.board.close(); expect(value.workflow.nextRunSequence()).toBe(2); value.owner.close();
    let rejected; try { value.workflow.nextRunSequence(); } catch (error) { rejected = error; } expect(rejected).toMatchObject({ code: "INVALID_INPUT", details: { cause: "The shared owner is closed." } });
  });
  it("B2-OWNER-07: native process crash rolls back queue/receipt; committed response loss replays the original ID", () => {
    const dir = directory(); const first = bundle(dir); const sender = { host: "crash-sender", sessionId: "s" }; const target = { host: "crash-recipient", sessionId: "t" };
    const draft = first.messaging.prepare({ sender, target, body: "fixed native crash input" }, 100); first.owner.close();
    const factory = pathToFileURL(path.resolve("mcp-server/src/inactive-shared-stores.ts")).href;
    const worker = (point: "inside" | "after") => {
      const action = `b.messaging.submitPrepared(${JSON.stringify(sender)},${JSON.stringify(draft.messageId)},100)`;
      const code = `import {createInactiveSharedStores} from ${JSON.stringify(factory)}; const b=createInactiveSharedStores({directory:${JSON.stringify(dir)},mode:'fixture-only',clock:()=>100,syntheticKeys:${JSON.stringify(keys)}}); ${point === "inside" ? `b.owner.transaction(()=>{${action}; process.exit(71);});` : `${action}; process.exit(72);`}`;
      return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], { cwd: path.resolve("."), encoding: "utf8", timeout: 10000, env: {} });
    };
    const interrupted = worker("inside"); expect(interrupted.status).toBe(71); const recovered = bundle(dir); expect(recovered.owner.inspect().counts.messages).toBe(0); expect(recovered.messaging.status(sender, draft.messageId, 100)?.state).toBe("prepared"); recovered.owner.close();
    const lost = worker("after"); expect(lost.status).toBe(72); const resumed = bundle(dir); expect(resumed.owner.inspect().counts.messages).toBe(1); expect(resumed.messaging.status(sender, draft.messageId, 100)?.state).toBe("queued"); expect(resumed.messaging.submitPrepared(sender, draft.messageId, 100)).toMatchObject({ messageId: draft.messageId, duplicate: true }); expect(resumed.owner.inspect().counts.messages).toBe(1);
    console.log("B2-RAW native-crash", JSON.stringify({ interrupted: interrupted.status, committedResponseLost: lost.status, replayCounts: resumed.owner.inspect().counts, messageId: draft.messageId }));
  });
  it("B2-OWNER-03: initializer failure rolls back DDL, module header and format marker together", () => {
    const dir = directory(); const filename = path.join(dir, "failed-init.sqlite3");
    const owner = new InactiveSharedConnection({ databasePath: filename, mode: "fixture-only", clock: () => 100 }); owners.add(owner);
    expect(() => owner.initialize(() => { const module = owner.borrow("board"); module.initialize(() => { module.database.exec("CREATE TABLE sessions(id TEXT)"); module.setSchemaVersion(0); throw new Error("fixed-init-fault"); }); })).toThrow("fixed-init-fault");
    owner.close(); const db = new DatabaseSync(filename, { readOnly: true });
    try { expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([]); expect(db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 0 }); } finally { db.close(); }
  });
  it("B2-OWNER-08: owner controls transaction/version SQL and native foreign-key rollback is active", () => {
    const value = bundle();
    expect(() => value.messaging.database.exec("BEGIN IMMEDIATE")).toThrow(/Connection control belongs/u); expect(() => value.messaging.database.prepare("BEGIN").run()).toThrow(/Connection control belongs/u); expect(() => value.messaging.database.exec("PRAGMA user_version=5")).toThrow(/Connection control belongs/u);
    expect(() => value.owner.transaction(() => { value.workflow.nextRunSequence(); value.messaging.database.prepare("INSERT INTO convergence_epochs(root_id,epoch,frame_digest,created_at) VALUES('missing-root',1,'synthetic','synthetic-time')").run(); })).toThrow(/FOREIGN KEY constraint failed/u);
    expect(value.workflow.nextRunSequence()).toBe(1); expect(value.owner.inspect().counts.convergence_epochs).toBe(0); expect(value.owner.inspect().foreignKeyViolations).toEqual([]);
  });
  it("B2-OWNER-04: reopened native format retains state and rejects schema/version drift", () => {
    const dir = directory(); const first = bundle(dir); expect(first.workflow.nextRunSequence()).toBe(1); first.owner.close();
    const second = bundle(dir); expect(second.workflow.nextRunSequence()).toBe(2); second.owner.close();
    const db = new DatabaseSync(second.owner.databasePath); db.exec("ALTER TABLE sessions ADD COLUMN forbidden_drift TEXT"); db.close();
    expect(() => bundle(dir)).toThrow(/Module versions and native schemas/u);
  });
  it("B2-OWNER-05: nested observations survive outer domain rollback and the next connection sees the maximum", () => {
    let now = 100; const dir = directory(); const first = bundle(dir, () => now);
    expect(() => first.owner.transaction(() => { first.workflow.nextRunSequence(); now = 200; first.messaging.pendingCount({ host: "clock-host", sessionId: "clock-session" }, 200); throw new Error("fixed-outer-fault"); })).toThrow("fixed-outer-fault");
    expect(first.owner.inspect().time).toBe(200); expect(first.workflow.nextRunSequence()).toBe(1);
    const second = bundle(dir, () => 105); second.messaging.pendingCount({ host: "clock-host", sessionId: "clock-session" }, 105);
    expect(second.owner.inspect().time).toBe(200);
  });
  it("B2-OWNER-06: independent actual processes contend for the same native claim with one winner", async () => {
    const dir = directory(); const value = bundle(dir);
    const target = { host: "process-target", sessionId: "receiver" };
    value.messaging.send({ sender: { host: "process-sender", sessionId: "sender" }, target, messageId: "process-message", body: "one winner" }, 100);
    const factory = pathToFileURL(path.resolve("mcp-server/src/inactive-shared-stores.ts")).href;
    const children = Array.from({ length: 2 }, () => {
      const code = `import {createInactiveSharedStores} from ${JSON.stringify(factory)}; const b=createInactiveSharedStores({directory:${JSON.stringify(dir)},mode:'fixture-only',clock:()=>100,syntheticKeys:${JSON.stringify(keys)}}); console.log('READY'); process.stdin.once('data',()=>{try{console.log(JSON.stringify({claimed:b.messaging.claim(${JSON.stringify(target)},100).length}));}finally{b.owner.close();}});`;
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], { cwd: path.resolve("."), stdio: ["pipe", "pipe", "pipe"], env: {} });
      let output = ""; let errors = "";
      const ready = new Promise<void>((resolve, reject) => { child.stdout.on("data", chunk => { output += String(chunk); if (output.includes("READY")) resolve(); }); child.once("error", reject); child.once("exit", exit => { if (!output.includes("READY")) reject(new Error(`Worker exited before READY: ${exit}: ${errors}`)); }); });
      child.stderr.on("data", chunk => { errors += String(chunk); });
      const done = new Promise<{ exit: number | null; output: string; errors: string }>(resolve => child.once("exit", exit => resolve({ exit, output, errors })));
      return { child, ready, done };
    });
    try {
      await Promise.all(children.map(child => child.ready)); children.forEach(({ child }) => child.stdin.end("GO\n"));
      const results = await Promise.all(children.map(child => child.done)); expect(results.every(result => result.exit === 0)).toBe(true);
      const winners = results.map(result => JSON.parse(result.output.trim().split("\n").at(-1)!) as { claimed: number });
      expect(winners.reduce((sum, result) => sum + result.claimed, 0)).toBe(1);
      expect(value.messaging.database.prepare("SELECT delivery_attempts FROM messages").get()).toMatchObject({ delivery_attempts: 1 });
      console.log("B2-RAW process", JSON.stringify(results));
    } finally { children.forEach(({ child }) => { if (child.exitCode === null) child.kill(); }); }
  }, 15000);
});
