// Non-safety observations per trial: were pending bodies delivered, which rows stayed latched.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
const rows = [];
for (const f of readdirSync('/tmp/ev/trials').filter((f) => f.endsWith('.json'))) {
  const r = JSON.parse(readFileSync(`/tmp/ev/trials/${f}`, 'utf8'));
  const m = Object.fromEntries(r.observations.messages.map((x) => [x.message_id.startsWith('hist-body') ? x.message_id : 'D1', x]));
  const latched = r.observations.finalWake.filter((w) => ['reserved', 'started', 'submitted', 'unknown'].includes(w.state) && w.session_id !== 'wake-B')
    .map((w) => `${w.session_id}/${w.instance_id}:${w.state}${w.late_observed_at ? '+late' : ''}`);
  rows.push({ id: r.spec.id ?? f, version: r.version, step: r.spec.step, role: r.spec.role, label: r.spec.label,
    A_acked: Boolean(m['hist-body-wake-A']?.acknowledged_at), D_acked: Boolean(m.D1?.acknowledged_at), latched,
    dupDeliveries: Object.entries(r.observations.deliveries).filter(([, n]) => n > 1) });
}
const agg = {};
for (const x of rows) {
  const k = `${x.version}`; agg[k] ??= { trials: 0, A_notDelivered: 0, D_notDelivered: 0, latchedTrials: 0, dupDelivery: 0, latchedStates: {} };
  const a = agg[k]; a.trials++; if (!x.A_acked) a.A_notDelivered++; if (!x.D_acked) a.D_notDelivered++; if (x.latched.length) a.latchedTrials++; if (x.dupDeliveries.length) a.dupDelivery++;
  for (const l of x.latched) { const s = l.replace(/^[^:]+:/, ''); a.latchedStates[s] = (a.latchedStates[s] ?? 0) + 1; }
}
writeFileSync('/tmp/ev/liveness.json', JSON.stringify({ agg, rows }, null, 1));
console.log(JSON.stringify(agg, null, 1));
