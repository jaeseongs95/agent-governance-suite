// Offline invariant checker over the audit log written by worker TEMP triggers.
import { DatabaseSync } from 'node:sqlite';

const ACTIVE = new Set(['reserved', 'started', 'submitted', 'unknown']);
const TERMINAL = new Set(['observed', 'not-submitted']);
const OUTCOME_OPS = new Set(['dispatch', 'lateOutcome', 'relayCycle']);
const HOOK_OPS = new Set(['hook', 'hookReplay']);

export function check(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA wal_checkpoint(TRUNCATE);');
  const audit = db.prepare('SELECT * FROM h_audit ORDER BY seq').all();
  const opsRows = db.prepare('SELECT * FROM h_ops ORDER BY rowid').all();
  const effects = db.prepare('SELECT * FROM h_effects ORDER BY rowid').all();
  const ops = new Map();
  for (const o of opsRows) ops.set(o.op_id, { ...o, args: o.args ? JSON.parse(o.args) : null, result: o.result ? JSON.parse(o.result) : null });
  const inv = {}; const mk = (k) => (inv[k] = { checks: 0, violations: 0, samples: [] });
  ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'transition', 'h_stuck_reserved'].forEach(mk);
  const viol = (k, detail) => { inv[k].violations += 1; if (inv[k].samples.length < 8) inv[k].samples.push(detail); };
  const info = { oldGenRetire: 0, currentObserve: 0, unknownCreated: 0, unknownToObserved: 0, unknownToOther: {}, effectRowNotStarted: 0,
    outcomeOnTerminalOrLate: 0, hookRejectedWithRowChange: 0, unknownExposures: 0, genSwitches: 0, sameMsRestart: 0, lateRetireOfCurrentGen: 0,
    reservedStuckOldGenEnd: 0, activeEnd: {}, errors: {} };

  const rows = new Map();
  const presence = new Map(); // target -> Map(inst -> {started, lease, ended, order})
  let presenceOrder = 0;
  const tkey = (h, s) => `${h}|${s}`;
  const currentPresence = (t) => {
    const m = presence.get(t); if (!m) return null;
    let best = null;
    for (const [inst, p] of m) if (!best || p.started > best.started || (p.started === best.started && p.order > best.order)) best = { inst, ...p };
    return best;
  };
  const startSeqOf = new Map(); // `${digest}:${epoch}` -> seq
  const hookTouched = new Map(); // op_id -> Set(digest)
  const hookMsgClaims = new Map();

  for (const a of audit) {
    const op = ops.get(a.op_id);
    const opname = a.op;
    if (a.tbl === 'presence') {
      const t = tkey(a.host, a.session_id);
      if (!presence.has(t)) presence.set(t, new Map());
      const extra = JSON.parse(a.extra);
      const prev = presence.get(t).get(a.instance_id);
      if (a.kind === 'I' || (prev && prev.started !== a.gen)) info.genSwitches += 1;
      if (extra.old_started && extra.old_started === a.gen && prev && prev.ended && !extra.ended_at) info.sameMsRestart += 1;
      presence.get(t).set(a.instance_id, { started: a.gen, lease: extra.lease_until, ended: extra.ended_at, order: prev?.order ?? presenceOrder++ });
      if (a.kind === 'I') presence.get(t).get(a.instance_id).order = presenceOrder++;
      let unk = 0; for (const r of rows.values()) if (r.state === 'unknown' && tkey(r.host, r.sid) === t) unk += 1;
      info.unknownExposures += unk;
      continue;
    }
    if (a.tbl === 'message') {
      const extra = JSON.parse(a.extra);
      if (HOOK_OPS.has(opname)) { if (!hookMsgClaims.has(a.op_id)) hookMsgClaims.set(a.op_id, 0); hookMsgClaims.set(a.op_id, hookMsgClaims.get(a.op_id) + 1); }
      if (extra.acked && !extra.old_acked) { const t = tkey(a.host, a.session_id); for (const r of rows.values()) if (r.state === 'unknown' && tkey(r.host, r.sid) === t) info.unknownExposures += 1; }
      continue;
    }
    // wake_nonces
    const prev = rows.get(a.key);
    const t = tkey(a.host, a.session_id);
    if (a.kind === 'D') {
      inv.b.checks += 1;
      if (prev && ACTIVE.has(prev.state)) viol('g', { seq: a.seq, op: opname, op_id: a.op_id, msg: 'active row deleted', state: prev.state });
      rows.delete(a.key);
      continue;
    }
    const next = { state: a.new_state, late: a.new_late, gen: a.gen, inst: a.instance_id, attempt: a.attempt_id, epoch: a.new_epoch, host: a.host, sid: a.session_id };
    if (HOOK_OPS.has(opname)) { if (!hookTouched.has(a.op_id)) hookTouched.set(a.op_id, new Set()); hookTouched.get(a.op_id).add(a.key); }
    if (a.kind === 'I') {
      inv.transition.checks += 1;
      if (!['reserved', 'legacy'].includes(a.new_state) || (a.new_state === 'reserved' && !['reserve', 'relayCycle'].includes(opname)) || (a.new_state === 'legacy' && opname !== 'legacyReserve')) viol('transition', { seq: a.seq, op: opname, msg: 'unexpected insert', state: a.new_state });
    } else {
      const from = a.old_state; const to = a.new_state;
      inv.transition.checks += 1; inv.b.checks += 1;
      // (b) terminal never returns / changes.
      if (TERMINAL.has(from) && to !== from) viol('b', { seq: a.seq, op: opname, op_id: a.op_id, from, to, key: a.key.slice(0, 12) });
      // (f) outcome never touches terminal or late rows.
      if (OUTCOME_OPS.has(opname)) { inv.f.checks += 1; if (TERMINAL.has(from) || a.old_late !== null) viol('f', { seq: a.seq, op: opname, op_id: a.op_id, from, to, oldLate: a.old_late }); }
      // (g) unknown resolution requires hook arrival or the attempt's own outcome.
      if (from === 'unknown' && to !== 'unknown') {
        inv.g.checks += 1;
        if (to === 'observed') info.unknownToObserved += 1; else info.unknownToOther[`${opname}:${to}`] = (info.unknownToOther[`${opname}:${to}`] ?? 0) + 1;
        const ok = (HOOK_OPS.has(opname) && to === 'observed') || (OUTCOME_OPS.has(opname) && ['submitted', 'reserved'].includes(to));
        if (!ok) viol('g', { seq: a.seq, op: opname, op_id: a.op_id, from, to });
      }
      if (to === 'unknown' && from !== 'unknown') info.unknownCreated += 1;
      const allowed = {
        'legacy>legacy': ['claim', 'hook', 'hookReplay'],
        'reserved>reserved': ['reserve', 'relayCycle'],
        'reserved>started': ['start', 'relayCycle'], 'reserved>not-submitted': ['start', 'relayCycle'],
        'started>submitted': [...OUTCOME_OPS], 'started>unknown': [...OUTCOME_OPS, 'reserve'], 'started>reserved': [...OUTCOME_OPS],
        'started>observed': [...HOOK_OPS], 'submitted>observed': [...HOOK_OPS], 'unknown>observed': [...HOOK_OPS],
        'unknown>unknown': [...OUTCOME_OPS], 'unknown>submitted': [...OUTCOME_OPS], 'unknown>reserved': [...OUTCOME_OPS],
      }[`${from}>${to}`];
      if (!allowed || !allowed.includes(opname)) viol('transition', { seq: a.seq, op: opname, op_id: a.op_id, from, to });
      if (from === 'reserved' && to === 'started') startSeqOf.set(`${a.key}:${a.new_epoch}`, a.seq);
      // (c) generation handling of arrivals.
      if (HOOK_OPS.has(opname) && to === 'observed' && from !== 'observed') {
        const hop = ops.get(a.op_id);
        const cur = currentPresence(t);
        const nowMs = a.now_ms;
        const online = cur && !cur.ended && Date.parse(cur.lease) > nowMs;
        const expired = JSON.parse(a.extra).expires <= new Date(nowMs).toISOString();
        const currentGen = cur && online && cur.inst === a.instance_id && cur.started === a.gen && !expired;
        inv.c.checks += 1;
        if (a.new_late === null) {
          info.currentObserve += 1;
          if (!currentGen) viol('c', { seq: a.seq, op_id: a.op_id, msg: 'claimed as current but generation/presence/TTL not current', rowGen: a.gen, curGen: cur?.started, online, expired });
        } else {
          info.oldGenRetire += 1;
          if (currentGen) info.lateRetireOfCurrentGen += 1;
        }
        if (hop && ['expired', 'bogus'].includes(hop.args?.receiptMode)) viol('c', { seq: a.seq, op_id: a.op_id, msg: 'unverified receipt changed a row', receiptMode: hop.args.receiptMode });
      }
    }
    rows.set(a.key, next);
    // (a) at most one active row per target after every audited write.
    inv.a.checks += 1;
    let active = 0; for (const r of rows.values()) if (ACTIVE.has(r.state) && tkey(r.host, r.sid) === t) active += 1;
    if (active > 1) viol('a', { seq: a.seq, op: opname, op_id: a.op_id, target: t, active });
  }

  // (c) hook ops: only candidate rows touched, messages only when recognized, bindings current.
  for (const o of ops.values()) {
    if (o.error) info.errors[`${o.op}: ${o.error.slice(0, 120)}`] = (info.errors[`${o.op}: ${o.error.slice(0, 120)}`] ?? 0) + 1;
    if (!HOOK_OPS.has(o.op) || !o.args) continue;
    inv.c.checks += 1;
    const touched = hookTouched.get(o.op_id) ?? new Set();
    const cands = new Set(o.args.nds);
    for (const k of touched) if (!cands.has(k)) viol('c', { op_id: o.op_id, msg: 'hook touched non-candidate row', key: k.slice(0, 12) });
    if (!o.result?.recognized && (hookMsgClaims.get(o.op_id) ?? 0) > 0) viol('c', { op_id: o.op_id, msg: 'rejected hook claimed messages' });
    if (!o.result?.recognized && touched.size > 0) info.hookRejectedWithRowChange += 1;
  }

  // (d)/(e) effects.
  const seenEffect = new Map();
  const byTarget = new Map();
  for (const e of effects) {
    inv.e.checks += 1;
    const k = `${e.nonce_digest}:${e.epoch}`;
    if (seenEffect.has(k)) viol('e', { msg: 'duplicate effect for nonce/epoch', key: k.slice(0, 16), ops: [seenEffect.get(k), e.op_id] });
    seenEffect.set(k, e.op_id);
    const startSeq = startSeqOf.get(k);
    if (startSeq === undefined) viol('e', { msg: 'effect without committed reserved->started transition at that epoch', op_id: e.op_id, epoch: e.epoch });
    if (e.row_state !== 'started' || e.row_epoch !== e.epoch) info.effectRowNotStarted += 1;
    const t = tkey(e.host, e.session_id);
    if (!byTarget.has(t)) byTarget.set(t, []);
    byTarget.get(t).push({ ...e, startSeq });
  }
  // Rebuild row state at each start to test that the previous effect's attempt was retired first.
  for (const [t, list] of byTarget) {
    list.sort((x, y) => (x.startSeq ?? 0) - (y.startSeq ?? 0));
    for (let i = 1; i < list.length; i += 1) {
      const prevE = list[i - 1]; const cur = list[i];
      if (prevE.startSeq === undefined || cur.startSeq === undefined) continue;
      inv.d.checks += 1;
      let state = null;
      for (const a of audit) { if (a.seq >= cur.startSeq) break; if (a.tbl === 'wake' && a.key === prevE.nonce_digest) state = a.kind === 'D' ? 'deleted' : a.new_state; }
      const retired = state === 'observed' || state === 'not-submitted' || state === 'deleted' || (prevE.nonce_digest === cur.nonce_digest && state === 'reserved');
      if (!retired) viol('d', { target: t, prevOp: prevE.op_id, curOp: cur.op_id, prevState: state, prevGen: prevE.generation, curGen: cur.generation });
    }
  }
  // (h) liveness observation: active rows at end whose generation is not the current presence.
  for (const r of rows.values()) {
    if (!ACTIVE.has(r.state)) continue;
    info.activeEnd[r.state] = (info.activeEnd[r.state] ?? 0) + 1;
    const cur = currentPresence(tkey(r.host, r.sid));
    inv.h_stuck_reserved.checks += 1;
    if (r.state === 'reserved' && cur && (cur.started !== r.gen || cur.inst !== r.inst)) { info.reservedStuckOldGenEnd += 1; viol('h_stuck_reserved', { target: tkey(r.host, r.sid), rowGen: r.gen, rowInst: r.inst, curGen: cur.started, curInst: cur.inst }); }
  }
  db.close();
  return { opCount: opsRows.length, errorCount: opsRows.filter((o) => o.error).length, effectCount: effects.length, auditCount: audit.length,
    opMix: opsRows.reduce((m, o) => ((m[o.op] = (m[o.op] ?? 0) + 1), m), {}), invariants: inv, info };
}
