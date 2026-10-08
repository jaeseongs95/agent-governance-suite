import fs from "node:fs";
import { setTimeout, clearTimeout } from "node:timers";
import { InactiveUnifiedAuthority, createProviderAdapter, fixtureDigest } from "../../runtime/unified-state/authority.mjs";
import { scopeA, workflowRef, nextWorkflowRow } from "./fixtures.mjs";

const [mode, directory, parameter] = process.argv.slice(2);
if (mode === "claim") {
  const authority = new InactiveUnifiedAuthority({ directory, mode: "fixture-only", clock: () => 1000 });
  const provider = createProviderAdapter(authority, scopeA);
  const deadline = setTimeout(() => process.exit(73), 5000);
  process.on("message", () => {
    const lease = provider.claim(workflowRef, { expectedRevision: 4, owner: parameter, ttlMs: 1000 });
    process.send({ type: "result", lease });
    clearTimeout(deadline);
    authority.close();
    process.disconnect();
  });
  process.send({ type: "ready" });
} else if (mode === "clock-rejection") {
  const observedTimes = [];
  const clockValue = parameter === "105" ? 105 : 200;
  const authority = new InactiveUnifiedAuthority({ directory, mode: "fixture-only", clock: () => { observedTimes.push(clockValue); return clockValue; } });
  const provider = createProviderAdapter(authority, scopeA);
  let rejection = null;
  try { provider.claim(workflowRef, { expectedRevision: 99, owner: "fixture-clock-other", ttlMs: 10 }); }
  catch (error) { rejection = error.code; }
  console.log(JSON.stringify({ rejection, observedTimes, revision: provider.read(workflowRef).revision }));
  authority.close();
  if (rejection !== "STALE_REVISION") process.exit(75);
} else if (mode === "crash-import") {
  const authority = new InactiveUnifiedAuthority({ directory, mode: "fixture-only", fault: (point) => { if (point === parameter) process.exit(71); } });
  const snapshotJson = fs.readFileSync(`${directory}/source-fixture.json`, "utf8");
  createProviderAdapter(authority, scopeA).importFixture({ snapshotJson, sourceDigest: fixtureDigest(snapshotJson), intentId: "import-once" });
  authority.close();
  process.exit(74);
} else if (mode === "crash-write") {
  const authority = new InactiveUnifiedAuthority({ directory, mode: "fixture-only", clock: () => 1000, fault: (point) => { if (point === parameter) process.exit(point === "after-commit-before-response" ? 72 : 71); } });
  const provider = createProviderAdapter(authority, scopeA);
  const lease = provider.claim(workflowRef, { expectedRevision: 4, owner: "fixture-owner", ttlMs: 1000 });
  provider.commit(workflowRef, { expectedRevision: 4, lease, row: nextWorkflowRow(), intentId: "effect-once", receiptId: "effect-receipt-original" });
  authority.close();
  process.exit(74);
} else throw new Error("Unknown fixture worker mode.");
