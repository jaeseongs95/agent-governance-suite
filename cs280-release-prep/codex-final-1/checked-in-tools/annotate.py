import datetime, json, pathlib
from environment import ROOT, sha
from runner import run, write
bundle = pathlib.Path('/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/dist/pnpm.mjs')
lines = bundle.read_text().splitlines()
ranges = [(148030, 148115), (148160, 148205), (149725, 149745), (150075, 150087), (253960, 254004), (255470, 255505)]
excerpts = [dict(start=start, end=end, lines=[dict(number=i, text=lines[i-1]) for i in range(start, end+1)]) for start, end in ranges]
write('PNPM-RUN-OPTION-SOURCE.json', dict(path=str(bundle), sha256=sha(bundle.read_bytes()), version='11.19.0', excerpts=excerpts,
    observedFailure='Unknown option store-dir from pnpm run parser, before scripts/validate-official.mjs',
    prospectiveBinding='Child process only PNPM_CONFIG_STORE_DIR=/workspace/ags-cs-2x/official-final-3ff79982/pnpm-store-private; command pnpm validate:official without unsupported run option',
    prospectiveExecution='NOT_RUN: one authorized final wrapper attempt exhausted; no automatic corrected retry',
    dependencyGate='verify-deps-before-run remains unchanged; no PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN override'))
_, out, _ = run('34-pnpm-run-help', ['pnpm', 'help', 'run'], ROOT / 'candidate')
assert '--store-dir' not in out.read_text()
result = json.loads((ROOT / 'raw/OFFICIAL-RESULT.json').read_text())
assert result['exitCode'] == 1 and result['stdoutBytes'] == 0 and not result['pluginPassed'] and result['skillsPassed'] == 0
stderr = (ROOT / 'raw/logs/30-final-validate-official.stderr.log').read_text()
assert "Unknown option: 'store-dir'" in stderr
write('ANNOTATED-RESULT.json', dict(status='BLOCKED_PNPM_RUN_OPTION', pnpmWrapperAttempts=1, pnpmExitCode=1,
    officialPythonValidatorExecutions=0, officialPlugin='NOT_RUN', official22Skills='NOT_RUN',
    originalOutcome='OFFICIAL-RESULT.json raw FAIL retained; not an actual validator FAIL. Its generic firstOfficial1 explanatory PASS wording is not a result and is superseded by this explicit status.',
    lockedInstall='PASS: one --frozen-lockfile private --store-dir install exit0, verified workspace-state/modules and source/lock unchanged',
    cause='Evidence runner passed --store-dir to pnpm implicit run. pnpm11.19 accepts this for install/store but rejects it for run before package script.',
    correctionApplied=False, validatorRetryCount=0, prospectiveChangedInput='Child-only PNPM_CONFIG_STORE_DIR binding; pnpm validate:official without CLI store-dir. No user/global config or dependency gate change. Await separate parent decision.',
    sourceHead=result['sourceHead'], sourceTree=result['sourceTree'], trackedFiles=1344, sourcePrePostExact=True, sourceClean=True,
    supplierCommit=result['supplierCommit'], supplierBytesExact=True, dependencyStateByteExact=True,
    fullTestBuildRuntime=0, productSourceWrites=0, firstOfficial1Preserved=True,
    preparatoryFailures='00 overly narrow docs/metadata path allowlist and17 SyntaxError retained; neither executed install or official validators. Changed harness corrected,25 syntax check exit0, locked install22 exit0.',
    claimScope='New final-pin environment preparation PASS and official validation BLOCKED only; original Linux full3F, signed whole lifecycle/global acceptance, SOURCE/release/install claims are not promoted.',
    preparedAtUtc=datetime.datetime.now(datetime.timezone.utc).isoformat()))
print(json.dumps(dict(status='BLOCKED_PNPM_RUN_OPTION', officialPythonValidatorExecutions=0, lockedInstall='PASS', originalFailureRetained=True, correctedRetry=0)))
