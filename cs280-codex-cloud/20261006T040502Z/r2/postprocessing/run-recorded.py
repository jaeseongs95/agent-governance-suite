import datetime, hashlib, json, os, pathlib, platform, subprocess, sys

root = pathlib.Path(__file__).resolve().parent
label, repo = sys.argv[1], pathlib.Path(sys.argv[2]).resolve()
command = sys.argv[3:]
evidence = root / 'evidence'
tmp = pathlib.Path('/dev/shm/ags-cs-lifecycle-r2') / label
tmp.mkdir(parents=True, mode=0o700, exist_ok=False)
state = root / 'tool-state' / label
state.mkdir(mode=0o700)
env = dict(os.environ)
for name in list(env):
    if name.startswith('AGENT_GOVERNANCE_') or name == 'AGS_TEST_PROCESS_OBSERVATIONS':
        env.pop(name)
env.update(TMPDIR=str(tmp), XDG_DATA_HOME=str(state / 'data'),
           XDG_CACHE_HOME=str(state / 'cache'), XDG_STATE_HOME=str(state / 'state'),
           AGENT_GOVERNANCE_SHARED_STATE_DIR=str(state / 'shared-state'),
           npm_config_store_dir='/workspace/ags-cs-2x/tool-state/pnpm-store',
           CI='true', PYTHONDONTWRITEBYTECODE='1')
if label in ('03-candidate-observation', '04-baseline-observation', '07-baseline-history-observation'):
    env['AGS_TEST_PROCESS_OBSERVATIONS'] = str(evidence / (label + '.process.jsonl'))
    pathlib.Path(env['AGS_TEST_PROCESS_OBSERVATIONS']).touch(mode=0o600, exist_ok=False)
paths = ['tests/helpers/fixture-process-observer.ts',
         'tests/session-messaging/historical-wake.test.mjs',
         'tests/session-messaging/session-message.test.ts']
pin = {p: hashlib.sha256((repo / p).read_bytes()).hexdigest() for p in paths}
record = dict(label=label, command=command, cwd=str(repo),
              sourceCommit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip(),
              started=datetime.datetime.now(datetime.timezone.utc).isoformat(),
              environment=dict(hostname=platform.node(), platform=platform.platform(),
                               pid1=pathlib.Path('/proc/1/comm').read_text().strip(),
                               TMPDIR=str(tmp), sharedState=env['AGENT_GOVERNANCE_SHARED_STATE_DIR'],
                               observations=env.get('AGS_TEST_PROCESS_OBSERVATIONS'), subreaper=False,
                               databaseObserver=False), filePins=pin)
with (evidence / (label + '.log')).open('x') as out:
    out.write(json.dumps(record) + '\n'); out.flush()
    result = subprocess.run(command, cwd=repo, env=env, stdout=out, stderr=subprocess.STDOUT)
record.update(exitCode=result.returncode, finished=datetime.datetime.now(datetime.timezone.utc).isoformat())
with (evidence / 'commands.jsonl').open('a') as out:
    out.write(json.dumps(record) + '\n')
print(json.dumps(record))
sys.exit(result.returncode)
