// Audit probe: synchronous is per connection; the fill connection's NORMAL does not reach other connections.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { SessionMessageStore } from '../../mcp-server/src/session-message-store.ts';
test('fill connection NORMAL(1); a second in-process connection and a child-process connection stay at the default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ags-sync-')); const db = join(dir, 'm.sqlite3');
  const fill = new SessionMessageStore(db); fill.database.exec('PRAGMA synchronous = NORMAL;');
  const other = new SessionMessageStore(db);
  const child = spawnSync(process.execPath, ['--import', 'tsx', '-e',
    `import { SessionMessageStore } from '${join(process.cwd(), 'mcp-server/src/session-message-store.ts')}'; const s = new SessionMessageStore(${JSON.stringify(db)}); console.log(JSON.stringify({ sync: s.database.prepare('PRAGMA synchronous').get().synchronous, mode: s.database.prepare('PRAGMA journal_mode').get().journal_mode })); s.close();`],
    { encoding: 'utf8' });
  const out = { fill: fill.database.prepare('PRAGMA synchronous').get().synchronous, other: other.database.prepare('PRAGMA synchronous').get().synchronous,
    child: JSON.parse(child.stdout.trim()), fillMode: fill.database.prepare('PRAGMA journal_mode').get().journal_mode };
  console.log('AUDIT-SYNC', JSON.stringify(out));
  assert.equal(out.fill, 1); assert.equal(out.other, 2); assert.equal(out.child.sync, 2); assert.equal(out.fillMode, 'wal'); assert.equal(out.child.mode, 'wal');
  fill.close(); other.close(); rmSync(dir, { recursive: true, force: true });
});
