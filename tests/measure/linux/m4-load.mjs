// M4 synthetic load: 37 clients -> one service -> FIFO queue -> single PGlite connection.
// Phase 1 closed loop (each client 1 outstanding request, like "rpc 1 request per connection").
// Phase 2 open loop at fixed total rates (requests may pipeline per connection).
// usage: node m4-load.mjs <runDir> <pgDataDir> <stepSeconds>
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, pct, sleep } from "./ipc-client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const [runDir, pgDir, stepArg] = process.argv.slice(2);
const stepS = Number(stepArg ?? 15);
const N = 37;
const sock = path.join(runDir, "m4.sock");
fs.rmSync(pgDir, { recursive: true, force: true });
const svc = spawn(process.execPath, [path.join(here, "ipc-service.mjs"), sock, "pglite", pgDir], { stdio: ["ignore", "inherit", "inherit"], cwd: here });
let ctl;
for (let i = 0; i < 300; i++) {
  await sleep(100);
  try {
    ctl = await connect(sock);
    break;
  } catch {}
}
const clients = [];
for (let i = 0; i < N; i++) clients.push(await connect(sock));
let seq = 0;
const results = [];

function summarize(label, e2e, errors, extra, st) {
  const r = {
    label,
    ...extra,
    sent: e2e.length + errors.busy + errors.other,
    ok: e2e.length,
    busyReplies: errors.busy,
    otherErrors: errors.other,
    e2eP50: pct(e2e, 50),
    e2eP99: pct(e2e, 99),
    e2eMax: pct(e2e, 100),
    svc: st.result,
  };
  results.push(r);
  console.error(JSON.stringify(r));
}
async function one(c, i, e2e, errors) {
  const t = performance.now();
  const r = await c.request("write", { session: i, seq: seq++ });
  if (r.result) e2e.push(performance.now() - t);
  else if (r.error?.data?.reason === "SERVICE_BUSY") errors.busy++;
  else errors.other++;
}

// warm up
for (let i = 0; i < 200; i++) await one(clients[i % N], i % N, [], { busy: 0, other: 0 });
await ctl.request("status", { reset: true });

// ---- phase 1: closed loop ----
{
  const e2e = [];
  const errors = { busy: 0, other: 0 };
  const end = performance.now() + stepS * 1000;
  await Promise.all(
    clients.map(async (c, i) => {
      while (performance.now() < end) await one(c, i, e2e, errors);
    }),
  );
  const st = await ctl.request("status", { reset: true });
  summarize("closed-loop-37x1", e2e, errors, { seconds: stepS }, st);
}

// ---- phase 2: open loop at fixed rates ----
for (const rate of [20, 50, 100, 200, 400, 800, 1600]) {
  await sleep(2000);
  await ctl.request("status", { reset: true });
  const e2e = [];
  const errors = { busy: 0, other: 0 };
  const inflight = [];
  const periodMs = (N * 1000) / rate;
  const end = performance.now() + stepS * 1000;
  await Promise.all(
    clients.map(async (c, i) => {
      let next = performance.now() + Math.random() * periodMs;
      while (next < end) {
        const d = next - performance.now();
        if (d > 0) await sleep(d);
        inflight.push(one(c, i, e2e, errors));
        next += periodMs;
      }
    }),
  );
  await Promise.all(inflight);
  const st = await ctl.request("status", { reset: true });
  summarize(`open-${rate}rps`, e2e, errors, { targetRps: rate, seconds: stepS, achievedSendRps: Math.round(inflight.length / stepS) }, st);
}
const fin = await ctl.request("status");
const rowCount = fin.result;
for (const c of clients) c.destroy();
await ctl.request("shutdown");
await new Promise((r) => svc.on("exit", r));
console.log(JSON.stringify({ N, stepS, results, final: rowCount }));
