// Summarizes run-fix.mjs logs: reconcile results per phase, row invariants (00 vs 07), admission.
import { readFileSync } from 'node:fs';
for (const f of process.argv.slice(2)) {
  const L = readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  console.log(`\n## ${f.split('/').pop()}`);
  let phase = 'apply-1'; const res = {};
  for (const e of L) {
    if (e.step?.startsWith('snap:')) { const lab = e.step.slice(5); if (lab.startsWith('03')) phase = 'apply-2'; if (lab.startsWith('04')) phase = 'newgen-1'; if (lab.startsWith('05')) phase = 'newgen-2'; if (lab.startsWith('06')) phase = 'post'; }
    if (e.step === 'cli' && e.operation === 'reconcile-wake-observation') {
      const k = e.payload.target.sessionId + (phase === 'apply-1' && res[e.payload.target.sessionId]?.['apply-1'] !== undefined ? ' (wrong-receipt)' : '');
      let v; try { v = JSON.parse(e.stdout).data?.reconciled; } catch { v = 'ERR'; }
      (res[k] ??= {})[phase] = v;
    }
  }
  console.log('| target | apply-1 | apply-2 | new-gen apply-1 | new-gen apply-2 |\n|---|---|---|---|---|');
  for (const [k, v] of Object.entries(res)) console.log(`| ${k} | ${v['apply-1'] ?? '-'} | ${v['apply-2'] ?? '-'} | ${v['newgen-1'] ?? '-'} | ${v['newgen-2'] ?? '-'} |`);
  const snap = (p) => L.find((e) => e.step?.startsWith(`snap:${p}`));
  const s0 = snap('00'), s7 = snap('07') ?? snap('08');
  if (s0?.rows && s7?.rows) {
    console.log('\nrow invariance 00 -> 07 (all columns, rows present at 00):');
    for (const r of s0.rows.wake_nonces) {
      const a = s7.rows.wake_nonces.find((x) => x.rowid === r.rowid);
      console.log(`- ${r.session_id} rowid=${r.rowid} state ${r.state}->${a?.state} ${JSON.stringify(a) === JSON.stringify(r) ? 'UNCHANGED' : 'CHANGED'}`);
    }
  }
  const adm = L.find((e) => e.step === 'admission-summary')?.admission;
  if (adm) { console.log('\nadmission:'); for (const [k, v] of Object.entries(adm)) console.log(`- ${k}: reserve=${v.reserve} start=${v.start ?? '-'} outcome=${v.outcome ?? '-'} 2ndReserveActive=${v.secondReserveWhileActive ?? '-'} claim1=${JSON.stringify(v.claim1 ?? null)} claim2Replay=${JSON.stringify(v.claim2Replay ?? null)} reserveAfterClaim=${v.reserveAfterClaim ?? '-'}`); }
  const late = L.filter((e) => e.step === 'req' && e.op === 'record-wake-outcome' && e.payload?.outcome === 'submitted' && !e.payload.attempt?.nonce?.startsWith?.('e9-')).slice(0, 1);
  for (const e of late) console.log(`\nlate outcome on reconciled T3 old attempt: ${JSON.stringify(e.data)}`);
  const s3 = snap('03'), s4 = snap('04');
  if (s3 && s4) console.log(`\napply-2 no-op: messageLogical 03==04 ${s3.messageLogical.all_sha256 === s4.messageLogical.all_sha256}; wal sha 03==04 ${s3.stateDir['session-messages.sqlite3-wal']?.sha256 === s4.stateDir['session-messages.sqlite3-wal']?.sha256}`);
  const s5 = snap('05'), s6 = snap('06');
  if (s5 && s6) console.log(`newgen-2 no-op: messageLogical 05==06 ${s5.messageLogical.all_sha256 === s6.messageLogical.all_sha256}`);
  console.log(`defaultTrustDir in every snap: ${[...new Set(L.filter((e) => e.step?.startsWith('snap:')).map((e) => JSON.stringify(e.defaultTrustDir)))].join(',')}`);
  console.log(`trust receipts/keyDigest/schema by snap: ${L.filter((e) => e.step?.startsWith('snap:')).map((e) => `${e.label}:${e.trustLogical.receipts}/${e.trustLogical.keyDigest}/${e.trustLogical.schema.slice(0, 8)}`).join(' ')}`);
  const t3 = s7?.rows?.wake_nonces.filter((x) => /T3|T6/.test(x.session_id)).map((x) => `${x.session_id} ${x.state} attempt=${String(x.attempt_id).slice(0, 8)} observed=${x.observed_at} late=${x.late_observed_at} consumed=${x.consumed_at}`);
  if (t3) console.log('T3/T6 rows at 07:\n  ' + t3.join('\n  '));
  console.log(`broker env keys: ${L.find((e) => e.step === 'broker-start')?.envKeys}`);
}
