import json, pathlib
from runner import ROOT, write
result=json.loads((ROOT/'raw/OFFICIAL-RESULT.json').read_text())
assert result['status']=='PASS' and result['exitCode']==0 and result['pluginPassed'] and result['skillsPassed']==22
stdout=(ROOT/'raw/logs/06-final2-validate-official.stdout.log').read_text()
assert 'Already up to date' in stdout
bundle=pathlib.Path('/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/dist/pnpm.mjs')
lines=bundle.read_text().splitlines()
write('PNPM-PREFIX-OBSERVATION.json',dict(observedLines=stdout.splitlines()[:2],
    explicitNewInstallCommands=0,internalPnpmInstallOutputObserved=True,
    rawHeuristic='OFFICIAL-RESULT implicitInstallObserved=false was a narrow Packages/Progress/Lockfile pattern. It does not establish zero internal installer calls; original report preserved.',
    confirmedInternalInvocationPath=None,
    sourceSupport=[dict(start=a,end=b,lines=[dict(number=i,text=lines[i-1]) for i in range(a,b+1)]) for a,b in [(200292,200314),(253961,253976),(264433,264450)]],
    limitation='No per-child process/syscall trace. Do not claim no internal installer attempt solely from unchanged workspace/module state.',
    sourceAndLockByteExact=True,workspaceModuleStateByteExact=True,allNodeModulesPayloadBytesPreHashed=False,
    storeBinding='Child config get and store path both verified task-owned private store/v11; no global config/HOME repair, gate override or extra install command',
    metadataOutcome='Official plugin plus22 skill emitted success, exit0; this prefix is disclosed separately and does not relabel prior failures'))
write('STATUS.json',dict(status='OFFICIAL_METADATA_PASS',exitCode=0,plugin='PASS',skillsPassed=22,skillsExpected=22,
    actualValidatorRunCommands=1,priorPnpmWrapperFailures=2,firstOfficial1='Preserved exit1 / NOT_RUN',final1='Preserved exit1 / NOT_RUN',
    sourceHead=result['sourceHead'],sourceTree=result['sourceTree'],trackedFiles=1344,sourceByteExact=True,sourceClean=True,
    lockSha256=result['lockSha256'],workspaceModuleStateByteExact=True,supplierFilesByteExact=5,
    internalPnpmPrefix='Already up to date / Done... observed; detailed call path not traced. Raw narrow implicitInstallObserved flag is not a zero-call claim.',
    newExplicitInstallCommands=0,allNodeModulesPayloadBytesPreHashed=False,
    fullTestsBuildRuntime='NOT_RUN in this task; parent CI is separate',qualityABC='NOT_RUN',signedWholeLifecycleGlobalAcceptance='NOT_IMPLEMENTED',
    independentSourceAudit='Separate parent responsibility',mainTagReleaseHostInstall='Not performed by this Cloud task',
    scope='Pinned official plugin/skill metadata validation only; no full Linux failure promotion, runtime/security/quality/release/host install approval'))
print(json.dumps(dict(status='OFFICIAL_METADATA_PASS',plugin='PASS',skills=22,internalPnpmPrefixDisclosed=True,productReexecution=False)))
