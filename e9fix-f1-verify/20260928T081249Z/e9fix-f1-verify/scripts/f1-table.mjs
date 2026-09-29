// Builds the F1 e9-vs-fix table from /tmp/ev/[5-7]?-f1-*.log
import { readdirSync, readFileSync } from 'node:fs';
const rows = [];
for (const f of readdirSync('/tmp/ev').filter((n) => /^\d\d-f1-(e9|fix)-.*\.log$/.test(n)).sort()) {
  const s = readFileSync(`/tmp/ev/${f}`, 'utf8'); const [, ver, kind, cas] = f.match(/-f1-(e9|fix)-(codex|claude)-(.+)\.log$/);
  const r = Object.fromEntries([...s.matchAll(/^RESULT (\S+?)[ =](\S+)$/gm)].map((m) => [m[1], m[2]]));
  const afterJson = s.split('--- after (broker live)')[1]?.split('\n--- default dir after broker stop')[0] ?? '';
  const j = JSON.parse(afterJson.slice(afterJson.indexOf('{'), afterJson.lastIndexOf('}') + 1));
  const w = j.wake_nonces?.find((x) => x.late_observed_at) ?? j.wake_nonces?.[0];
  const env = s.match(/count=(\d+)/)?.[1] ?? '(c2: CLI-spawned)';
  rows.push({ f, ver, kind, cas, run1: r.run1, run2: r.run2, wake: `${w?.state} consumed=${w?.consumed_at ? 'set' : 'null'}`,
    msgClaimed: j.messages?.some((m) => m.claimed_at) ? 'yes' : 'no', obs: j.input_observations,
    defaultUntouched: r.default_untouched, defaultDir: r.default_dir_exists_after, rTrust: r.R_trust_exists_after, brokerEnvAG: env });
}
console.log('| log | ver | tree | case | run1 | run2 | old wake after | msg claimed | obs | default dir untouched | default dir exists | R/trust exists | broker AGENT_GOVERNANCE_* |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const x of rows) console.log(`| ${x.f.slice(0, 2)} | ${x.ver} | ${x.kind} | ${x.cas} | ${x.run1} | ${x.run2} | ${x.wake} | ${x.msgClaimed} | ${x.obs} | ${x.defaultUntouched} | ${x.defaultDir} | ${x.rTrust} | ${x.brokerEnvAG} |`);
