#!/usr/bin/env python3
# Aggregate per-seed JSON results: python3 aggregate.py <resultsDir> <outJson>
import json, sys, glob, collections
d, out = sys.argv[1], sys.argv[2]
agg = {}
for f in sorted(glob.glob(f'{d}/*.json')):
    r = json.load(open(f))
    n = r['n']
    a = agg.setdefault(n, {'runs': 0, 'ops': 0, 'errors': 0, 'effects': 0, 'kills': 0, 'nonzeroExit': 0, 'inv': collections.defaultdict(lambda: [0, 0]),
                           'violSeeds': collections.defaultdict(list), 'info': collections.Counter(), 'errorMsgs': collections.Counter(), 'unknownToOther': collections.Counter()})
    a['runs'] += 1; a['ops'] += r['opCount']; a['errors'] += r['errorCount']; a['effects'] += r['effectCount']; a['kills'] += len(r['kills'])
    a['nonzeroExit'] += sum(1 for e in r['exits'] if e['code'] not in (0, None))
    for k, v in r['invariants'].items():
        a['inv'][k][0] += v['checks']; a['inv'][k][1] += v['violations']
        if v['violations']: a['violSeeds'][k].append(r['seed'])
    for k, v in r['info'].items():
        if isinstance(v, (int, float)): a['info'][k] += v
    for k, v in r['info']['errors'].items(): a['errorMsgs'][k] += v
    for k, v in r['info']['unknownToOther'].items(): a['unknownToOther'][k] += v
res = {}
for n, a in sorted(agg.items()):
    res[n] = {'runs': a['runs'], 'ops': a['ops'], 'opErrors': a['errors'], 'effects': a['effects'], 'sigkills': a['kills'], 'nonzeroWorkerExit': a['nonzeroExit'],
              'invariants': {k: {'checks': c, 'violations': v, 'seeds': a['violSeeds'][k]} for k, (c, v) in a['inv'].items()},
              'info': dict(a['info']), 'errorMsgs': dict(a['errorMsgs']), 'unknownToOther': dict(a['unknownToOther'])}
json.dump(res, open(out, 'w'), indent=1)
for n, r in res.items():
    print(f"n={n} runs={r['runs']} ops={r['ops']} opErrors={r['opErrors']} effects={r['effects']} sigkills={r['sigkills']} nonzeroExit={r['nonzeroWorkerExit']}")
    for k, v in r['invariants'].items(): print(f"   {k}: checks={v['checks']} violations={v['violations']} seeds={v['seeds'][:15]}{'...' if len(v['seeds'])>15 else ''} ({len(v['seeds'])} seeds)")
    print('   info', r['info']); print('   unknownToOther', r['unknownToOther']); print('   errors', r['errorMsgs'])
