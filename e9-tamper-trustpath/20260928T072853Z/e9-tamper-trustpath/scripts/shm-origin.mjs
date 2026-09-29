// Who creates the leftover -shm in the locking_mode=EXCLUSIVE case? A: holder only. B: holder + read-only reader.
import { DatabaseSync } from 'node:sqlite'; import { spawnSync, spawn } from 'node:child_process'; import { mkdirSync, rmSync, readdirSync } from 'node:fs';
const { TrustStore } = await import('/tmp/e9/mcp-server/src/trust-store.ts');
for (const withReader of [false, true]) {
  const d = `/tmp/shm-origin-${withReader}`; rmSync(d, { recursive: true, force: true }); mkdirSync(d); const p = `${d}/trust.sqlite3`;
  new TrustStore(p).close();
  console.log(withReader ? 'B' : 'A', 'initial', readdirSync(d));
  const code = `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; UPDATE trust_metadata SET value=value;');process.stdout.write('R\\n');setTimeout(()=>{d.exec('ROLLBACK');d.close()},1500)`;
  const c = spawn(process.execPath, ['-e', code, p], { stdio: ['ignore', 'pipe', 'inherit'] }); await new Promise(r => c.stdout.once('data', r));
  console.log(' holder running', readdirSync(d));
  if (withReader) console.log(' readVerified =', TrustStore.readVerifiedInputSource(p, 'source-x'), readdirSync(d));
  await new Promise(r => c.once('exit', r));
  console.log(' after holder exit', readdirSync(d));
}
