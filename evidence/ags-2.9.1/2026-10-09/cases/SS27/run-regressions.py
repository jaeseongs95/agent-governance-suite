import json, subprocess, pathlib
root=pathlib.Path.cwd()
commands=[
('response-validation',['node','scripts/run-tests.mjs','tests/mcp/skill-classification-validation.test.ts','-t','rejects unknown, duplicate and invalid output without creating negative judgments','--reporter=json','--outputFile=evidence/SS27/regression-response.vitest.json']),
('fallback',['node','scripts/run-tests.mjs','tests/mcp/skill-classification-service.test.ts','-t','SS27/30 malformed and incomplete JEV judgments produce INVALID and vendor fallback','--reporter=json','--outputFile=evidence/SS27/regression-fallback.vitest.json']),
('wire-variants',['node','scripts/run-tests.mjs','tests/mcp/skill-classification-providers.test.ts','-t','SS27/28 rejects (unknown-id|missing-id|nan) responses rather than producing no-skill','--reporter=json','--outputFile=evidence/SS27/regression-wire.vitest.json'])]
rows=[]
for name,cmd in commands:
    run=subprocess.run(cmd,cwd=root,capture_output=True,text=True,timeout=60)
    (root/f'evidence/SS27/regression-{name}.stdout.log').write_text(run.stdout)
    (root/f'evidence/SS27/regression-{name}.stderr.log').write_text(run.stderr)
    report=json.loads((root/cmd[-1].split('=',1)[1]).read_text())
    rows.append(dict(name=name,command=cmd,exitCode=run.returncode,executionKind='existing-regression-offline-mock',passed=report['numPassedTests'],failed=report['numFailedTests'],skipped=report['numPendingTests'],assertions=[dict(title=t['fullName'],status=t['status']) for x in report['testResults'] for t in x['assertionResults'] if t['status']!='pending']))
(root/'evidence/SS27/regression-commands.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(rows,ensure_ascii=False,indent=2))
