// Aggregate summary.jsonl files and the kept op-level sample.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
const out = {};
for (const d of ['11-e9-mixed', '14-v53-mixed', '12-e9-readonly', '13-e9-missing']) {
  const rows = readFileSync(`/tmp/ev/${d}/summary.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
  const byN = {};
  for (const r of rows) {
    const b = byN[r.n] ??= { runs: 0, seeds: new Set(), ops: 0, reconciled: 0, recAttempts: 0, effects: 0, starts: 0, lateObserved: 0, hookRecognized: 0, errors: 0, violations: 0, sidecarRuns: 0, holderRuns: 0, variants: {}, missingKinds: {}, errorKinds: {} };
    b.runs++; b.seeds.add(r.seed); for (const k of ['ops', 'reconciled', 'recAttempts', 'effects', 'starts', 'lateObserved', 'hookRecognized', 'errors', 'violations']) b[k] += r[k];
    if (r.sidecarsCreated.length) b.sidecarRuns++; if (r.holder) b.holderRuns++;
    for (const v of r.variants) b.variants[v] = (b.variants[v] ?? 0) + 1; if (r.missingKind) b.missingKinds[r.missingKind] = (b.missingKinds[r.missingKind] ?? 0) + 1;
    for (const e of r.errorKinds) b.errorKinds[e] = (b.errorKinds[e] ?? 0) + 1;
  }
  for (const b of Object.values(byN)) b.seeds = `${Math.min(...b.seeds)}..${Math.max(...b.seeds)} (${b.seeds.size})`;
  out[d] = byN;
}
// op-level exercise counts from kept sample
const dir = '/tmp/ev/15-e9-mixed-keep'; const ex = { runs: 0, ops: {}, reconcileTrue: 0, reconcileBadTrue: 0, lateOutcomeOldTrue: 0, lateOutcomeOldOnLateRow: 0, lateOutcomeMineTrue: 0, lateOutcomeMineOnTerminal: 0,
  hookOldRecognized: 0, hookOldOnTerminal: 0, terminalUpdates: 0, controllerPass1True: 0, genChangesAfterReconcile: 0, effectsAfterReconcileSameTarget: 0, invalidVariantReconcileAttempts: 0 };
for (const f of readdirSync(dir).filter(n => n.endsWith('.json'))) {
  const r = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')); ex.runs++;
  const bySid = Object.fromEntries(r.cfg.targets.map((t, i) => [t.target.sessionId, r.stats.variants[i]]));
  const recAt = {};
  for (const e of r.audit) if (e.op === 'U' && e.o_state === 'unknown' && e.n_state === 'observed' && e.n_obs !== e.n_cons) recAt[e.sid] = e.seq;
  for (const l of r.logs) {
    ex.ops[l.op] = (ex.ops[l.op] ?? 0) + 1;
    if (l.op === 'reconcile' && l.result?.reconciled && l.w !== 'controller') ex.reconcileTrue++;
    if (l.op === 'reconcile' && l.result?.reconciled && l.w === 'controller') ex.controllerPass1True++;
    if (l.op === 'reconcile-bad' && l.result?.reconciled) ex.reconcileBadTrue++;
    if (l.op === 'late-outcome-old') { if (l.result) ex.lateOutcomeOldTrue++; if (!['no-late'].includes(bySid[l.sid])) ex.lateOutcomeOldOnLateRow++; }
    if (l.op === 'late-outcome-mine' && l.result) ex.lateOutcomeMineTrue++;
    if (l.op === 'hook-old' && l.result?.recognized) ex.hookOldRecognized++;
    if ((l.op === 'reconcile' || l.op === 'reconcile-bad') && !['valid', 'current-gen', 'actor-main'].includes(bySid[l.payload?.target?.sessionId])) ex.invalidVariantReconcileAttempts++;
  }
  // effects on a target after its seeded row was reconciled (new wake cycle after reconcile)
  const startSeqs = r.audit.filter(e => e.n_state === 'started' && e.o_state !== 'started');
  for (const s of startSeqs) if (recAt[s.sid] !== undefined && s.seq > recAt[s.sid]) ex.effectsAfterReconcileSameTarget++;
}
out.opLevelSample = ex;
console.log(JSON.stringify(out, null, 1));
