# Temporary slow-runner variant (never committed): seed live rows 25-26 s in the past, as a runner that needs that long
# between seeding and the broker query would. Run: python3 slow-runner-variant.py apply|restore
import sys, shutil
R='tests/session-messaging/presence-retention.test.ts'; P='tests/session-messaging/previous-broker.test.ts'
V={R:[('largeFixture(path.join(state, "session-messages.sqlite3"), now)).toEqual', 'largeFixture(path.join(state, "session-messages.sqlite3"), now - 25_000)).toEqual'),
      ('born(store, `valid-${index}`, `valid-${index}`, now - 1000);', 'born(store, `valid-${index}`, `valid-${index}`, now - 26_000);')],
   P:[('instanceId: "presence-instance", transport: "portable", wakeVisibility: "none", canWakeSilently: false }, Date.now());',
       'instanceId: "presence-instance", transport: "portable", wakeVisibility: "none", canWakeSilently: false }, Date.now() - 25_000);')]}
for f,pairs in V.items():
    if sys.argv[1]=='apply':
        shutil.copy(f, f+'.orig'); s=open(f).read()
        for a,b in pairs: assert s.count(a)==1,(f,a); s=s.replace(a,b)
        open(f,'w').write(s)
    else: shutil.move(f+'.orig', f)
