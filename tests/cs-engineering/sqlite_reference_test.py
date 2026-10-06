"""Actual SQLite/process reference tests. No AGS product code is imported."""
from __future__ import annotations
import importlib.util
import hashlib
import json
import multiprocessing as mp
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[2]
CANDIDATE = ROOT / 'skills/cs-engineering/assets/examples/sqlite-queue/candidate/queue.py'
spec = importlib.util.spec_from_file_location('cs_queue_reference', CANDIDATE)
queue = importlib.util.module_from_spec(spec)
spec.loader.exec_module(queue)


def worker(filename, barrier, results, owner):
    try:
        barrier.wait(timeout=15)
        results.put({'owner': owner, 'token': queue.claim(filename, owner, 0, 100)})
    except BaseException as exc:
        results.put({'error': type(exc).__name__})


def broken_worker(filename, barrier, results, owner):
    with closing(queue.connect(filename)) as connection:
        row = connection.execute("SELECT id FROM tasks WHERE state='pending'").fetchone()
        barrier.wait(timeout=15)
        if row:
            connection.execute("UPDATE tasks SET state='running', owner=? WHERE id=?", (owner,row[0]))
            results.put(owner)


def uncommitted_crash(filename):
    connection = queue.connect(filename)
    connection.execute('BEGIN IMMEDIATE')
    connection.execute("UPDATE tasks SET state='done'")
    os._exit(17)


class SQLiteReferenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cs-engineering-sqlite-')
        self.addCleanup(self.temp.cleanup)
        self.db = str(Path(self.temp.name) / 'queue.sqlite3')
        queue.initialize(self.db)
        with closing(queue.connect(self.db)) as con:
            con.execute("INSERT INTO tasks(id,state) VALUES(1,'pending')")

    def run_workers(self, function, count):
        ctx = mp.get_context('spawn')
        barrier, results = ctx.Barrier(count), ctx.Queue()
        workers = [ctx.Process(target=function,args=(self.db,barrier,results,f'w{i}')) for i in range(count)]
        try:
            for p in workers: p.start()
            output = [results.get(timeout=20) for _ in workers]
            for p in workers:
                p.join(timeout=20)
                self.assertFalse(p.is_alive())
                self.assertEqual(p.exitcode, 0)
            return output
        finally:
            for p in workers:
                if p.is_alive(): p.terminate(); p.join(timeout=5)
            results.close()
            results.join_thread()

    def test_CONC_CLAIM_001_six_independent_processes_one_winner(self):
        output = self.run_workers(worker,6)
        self.assertFalse(any('error' in x for x in output),output)
        self.assertEqual(sum(x['token'] is not None for x in output),1)

    def test_CONC_CLAIM_001_negative_read_then_write_has_two_winners(self):
        self.assertEqual(len(self.run_workers(broken_worker,2)),2)

    def test_CONC_FENCE_002_stale_owner_cannot_publish(self):
        first = queue.claim(self.db,'old',0,10)
        second = queue.claim(self.db,'new',11,10)
        self.assertGreater(second['generation'],first['generation'])
        self.assertFalse(queue.finish(self.db,first,'stale',12))
        self.assertTrue(queue.finish(self.db,second,'current',12))
        with closing(queue.connect(self.db)) as c:
            self.assertEqual(c.execute('SELECT result FROM tasks').fetchone()[0],'current')

    def test_CONC_FENCE_002_expired_unreassigned_lease_rejected(self):
        first = queue.claim(self.db,'old',0,10)
        self.assertFalse(queue.finish(self.db,first,'late',10))

    def test_DB_BOUNDARY_001_crash_rolls_back_uncommitted_state(self):
        ctx=mp.get_context('spawn'); p=ctx.Process(target=uncommitted_crash,args=(self.db,))
        p.start();p.join(timeout=20)
        if p.is_alive(): p.terminate();p.join();self.fail('Crash worker did not exit')
        self.assertEqual(p.exitcode,17)
        with closing(queue.connect(self.db)) as c:
            self.assertEqual(c.execute('SELECT state FROM tasks').fetchone()[0],'pending')

    def test_DB_ISOLATION_002_two_connection_snapshot(self):
        with closing(queue.connect(self.db)) as a, closing(queue.connect(self.db)) as b:
            a.execute('BEGIN')
            self.assertEqual(a.execute('SELECT state FROM tasks').fetchone()[0],'pending')
            b.execute("UPDATE tasks SET state='running'")
            self.assertEqual(a.execute('SELECT state FROM tasks').fetchone()[0],'pending')
            with self.assertRaises(sqlite3.OperationalError):
                a.execute("UPDATE tasks SET state='done'")
            a.execute('ROLLBACK')
            self.assertEqual(a.execute('SELECT state FROM tasks').fetchone()[0],'running')

    def test_DB_CONSTRAINT_003_primary_key_and_check_reject_invalid_state(self):
        with closing(queue.connect(self.db)) as c:
            with self.assertRaises(sqlite3.IntegrityError):
                c.execute("INSERT INTO tasks(id,state) VALUES(1,'pending')")
            with self.assertRaises(sqlite3.IntegrityError):
                c.execute("UPDATE tasks SET state='invented'")
            self.assertEqual(c.execute('SELECT state FROM tasks').fetchone()[0],'pending')

    def test_DB_MIGRATION_004_rollback_retry_and_data_preservation(self):
        with closing(queue.connect(self.db)) as c:
            c.execute('BEGIN')
            c.execute('ALTER TABLE tasks ADD COLUMN migrated INTEGER NOT NULL DEFAULT 0')
            c.execute('ROLLBACK')
            self.assertNotIn('migrated',[x[1] for x in c.execute('PRAGMA table_info(tasks)')])
            def migrate():
                if 'migrated' not in [x[1] for x in c.execute('PRAGMA table_info(tasks)')]:
                    c.execute('ALTER TABLE tasks ADD COLUMN migrated INTEGER NOT NULL DEFAULT 0')
            migrate();migrate()
            self.assertEqual(c.execute('SELECT id,state,migrated FROM tasks').fetchall(),[(1,'pending',0)])

    def test_OS_LIFETIME_invalid_claim_leaves_queue_usable(self):
        with self.assertRaises(ValueError):queue.claim(self.db,'',0,10)
        self.assertIsNotNone(queue.claim(self.db,'valid',0,10))


if __name__ == '__main__':
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(SQLiteReferenceTests)
    case_ids=[case.id().split('.')[-1] for case in suite]
    before='sha256:'+hashlib.sha256(CANDIDATE.read_bytes()).hexdigest()
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    unchanged=before=='sha256:'+hashlib.sha256(CANDIDATE.read_bytes()).hexdigest()
    summary={'scope':'local SQLite reference candidate; not AGS product integration','python':sys.version.split()[0], 'sqlite':sqlite3.sqlite_version, 'processStartMethod':'spawn','testsRun':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skipped':len(result.skipped),'status':'PASS' if result.wasSuccessful() and unchanged else 'FAIL', 'candidateRawDigest':before, 'candidateUnchangedDuringRun':unchanged, 'testScriptDigest':'sha256:'+hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'caseIds':case_ids}
    if '--write-evidence' in sys.argv:
        dest=ROOT/'evidence/sqlite-reference-summary.json';dest.parent.mkdir(parents=True,exist_ok=True)
        dest.write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        example=ROOT/'skills/cs-engineering/assets/examples/sqlite-queue/evidence/queue-tests.json'
        example.write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(summary))
    sys.exit(0 if summary['status']=='PASS' else 1)
