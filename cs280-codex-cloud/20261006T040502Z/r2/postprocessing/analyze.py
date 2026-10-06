import json, pathlib

root = pathlib.Path(__file__).resolve().parent / 'evidence'
results = []
labels = ('03-candidate-observation', '04-baseline-observation', '07-baseline-history-observation')
expected = {
    labels[0]: '3 failed | 1 passed | 132 skipped (136)',
    labels[1]: '2 failed | 69 skipped (71)',
    labels[2]: '1 failed | 1 passed | 63 skipped (65)',
}
for label in labels:
    groups = {}
    for number, line in enumerate((root / (label + '.process.jsonl')).read_text().splitlines(), 1):
        row = json.loads(line)
        groups.setdefault((row['fixture'], row['pid']), []).append((number, row))
    log = (root / (label + '.log')).read_text()
    assert expected[label] in log
    assert 'fixture-process-observer: recording failed' not in log
    for (fixture, pid), rows in groups.items():
        kind = 'relay' if any(r['phase'].startswith('relay:') for _, r in rows) else 'broker'
        polls = [(n, r) for n, r in rows if r['phase'] == kind + ':kill-zero']
        assert polls
        number, last = polls[-1]
        starts = {s['starttime'] for _, r in rows for s in (r['before'], r['after']) if 'starttime' in s}
        if len(starts) > 1:
            classification = 'PID_REUSE'
        elif last['operation']['errorCode'] == 'ESRCH':
            classification = 'ESRCH_THIS_RUN_CAUSE_UNCONFIRMED'
        elif last['before'].get('state') == last['after'].get('state') == 'Z' and last['after'].get('ppid') == 1:
            classification = 'UNREAPED_ORPHAN_ZOMBIE'
        else:
            classification = 'SHUTDOWN_INCOMPLETE_NON_Z'
        case = ('historical-wake client-ensure' if fixture.startswith('historical-wake:') else
                'session-message profile relay' if kind == 'relay' else 'session-message broker teardown')
        results.append(dict(run=label, case=case, fixture=fixture, pid=pid, classification=classification,
                            initialStat=rows[0][1]['before'], lastKillZero=last,
                            distinctStarttimes=sorted(starts), records=len(rows),
                            evidencePath=label + '.process.jsonl', firstLine=rows[0][0], lastKillZeroLine=number))
assert sum(r['classification'] == 'UNREAPED_ORPHAN_ZOMBIE' for r in results if r['run'] == labels[0]) == 3
assert sum(r['classification'] == 'UNREAPED_ORPHAN_ZOMBIE' for r in results if r['run'] != labels[0]) == 3
record = dict(schema='AGSFixtureLifecycleEvidence.v1',
              scope='Only these comparative Codex Cloud diagnostic runs; not an update or validation of the unavailable RO DiagnosisReport.v1.',
              confirmedCause='Unreaped fixture orphans under this non-reaping Linux PID1',
              cases=results, repeatedExecutedCases=0,
              baselineInterruptedWorker='04 history worker failed before test start; only its two cases were completed in 07.',
              fullRegressionOnNewPin='NOT_RUN', releasePermission=False)
(root / 'fixture-lifecycle-classification.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'classifiedPersistentZombieTargets': 6, 'repeatedExecutedCases': 0, 'causeScope': record['scope']}))
