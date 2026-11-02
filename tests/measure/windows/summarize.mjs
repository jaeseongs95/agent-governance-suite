// Prints a compact summary of the measurement result files (d7-<tag>.jsonl, pglite-crash.jsonl).
import fs from "node:fs";
const [kind, file] = process.argv.slice(2);
const rows = fs.readFileSync(file, "utf8").replace(/^﻿/u, "").split(/\r?\n/u).filter(Boolean).map((l) => JSON.parse(l.replace(/^﻿/u, "")));
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const log = (r) => (r.svcLog ?? []).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
if (kind === "d7") {
  for (const r of rows) {
    if (r.ev === "env") console.log("ENV", JSON.stringify(r));
    if (r.ev === "d7") {
      const h = r.hostResult ?? {};
      const start = log(r).find((x) => x.ev === "start") ?? {};
      console.log("D7", r.hostKind, r.mode, JSON.stringify({ hostMs: r.hostMs, eof: h.eof ?? !h.timedOut, eofMs: h.eofMs ?? h.closeMs, assigned: h.assigned,
        launcherMs: r.hook?.launcherMs, coldMs: r.hook?.coldStartMs, hookErr: r.hook?.err, svcPid: r.svcPid, ppid: start.ppid, probeEnv: start.probeEnv,
        alive3s: r.after3s?.alive, hbAgeMs: r.after3s?.hbAgeMs, svcJob: r.after3s?.svcJob, hello: String(r.after3s?.pipeHello ?? "").slice(0, 30) }));
    }
    if (r.ev === "keep" || r.ev === "done") console.log("KEEP", JSON.stringify(r));
  }
  for (const m of ["shellexecute", "cim", "detached"]) {
    const c = rows.filter((r) => r.ev === "cold" && r.mode === m).map((r) => r.hook ?? {});
    const v = c.map((h) => h.coldStartMs).filter((x) => x != null);
    console.log("COLD", m, JSON.stringify({ n: c.length, ok: v.length, min: Math.min(...v), med: med(v), max: Math.max(...v), launcherMed: med(c.map((h) => h.launcherMs).filter((x) => x != null)), errs: c.filter((h) => h.err).map((h) => h.err) }));
  }
} else {
  const cyc = rows.filter((r) => r.ev === "cycle");
  const bad = cyc.filter((r) => r.loss || r.damaged || (!r.open && r.phaseAtKill !== "starting"));
  console.log("CYCLES", cyc.length, "phases", JSON.stringify(cyc.reduce((a, r) => ((a[r.phaseAtKill] = (a[r.phaseAtKill] ?? 0) + 1), a), {})),
    "openMed", med(cyc.filter((r) => r.open).map((r) => r.open.openMs)), "openMax", Math.max(...cyc.filter((r) => r.open).map((r) => r.open.openMs)),
    "rssMed", med(cyc.filter((r) => r.open).map((r) => r.open.rssOpenMb)), "lastC", cyc.at(-1)?.lastC);
  for (const r of bad.slice(0, 5)) console.log("BAD", JSON.stringify(r).slice(0, 600));
  const s = rows.find((r) => r.ev === "summary");
  if (s) console.log("SUMMARY", JSON.stringify(s));
}
