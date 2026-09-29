// Runs a plan with bounded concurrency. usage: node campaign.mjs <plan.json> <worktree> <version> <resultsJsonl> [concurrency]
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
const [planPath, worktree, version, resultsPath, conc = '3'] = process.argv.slice(2);
const { plan } = JSON.parse(readFileSync(planPath, 'utf8'));
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const todo = plan.filter((p) => !only || only.has(p.id));
mkdirSync('/tmp/ev/trials', { recursive: true });
let i = 0;
async function worker() {
  while (i < todo.length) {
    const p = todo[i++];
    const dir = `/tmp/work/${p.id}`;
    const cfg = { version, worktree, dir, spec: p, outcome: p.outcome, refSchema: `/tmp/ev/ref/schema-${worktree.split('/').pop()}.json` };
    const started = Date.now();
    const line = await new Promise((resolve) => {
      const c = spawn(process.execPath, ['--import', 'tsx', '/tmp/ev/scripts/orchestrator.mjs', JSON.stringify(cfg)], { cwd: worktree, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = ''; c.stdout.on('data', (d) => out += d); c.stderr.on('data', (d) => err += d);
      const t = setTimeout(() => c.kill('SIGKILL'), 120000);
      c.on('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal, out: out.trim().split('\n').pop(), err: err.slice(-2000) }); });
    });
    let parsed = null; try { parsed = JSON.parse(line.out); } catch {}
    appendFileSync(resultsPath, JSON.stringify({ id: p.id, ms: Date.now() - started, exit: line.code, signal: line.signal, ...(parsed ?? { raw: line.out, err: line.err }) }) + '\n');
    if (existsSync(`${dir}/result.json`)) copyFileSync(`${dir}/result.json`, `/tmp/ev/trials/${p.id}.json`);
    const failed = !parsed || Object.values(parsed.verdicts ?? {}).includes('FAIL') || parsed.harnessIssues;
    if (!failed) rmSync(dir, { recursive: true, force: true });
  }
}
await Promise.all(Array.from({ length: Number(conc) }, worker));
