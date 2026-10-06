"""Compare shipped closed-schema subset with python-jsonschema Draft 2020-12.

A development-only cross-check, not a runtime dependency or an AGS Ajv run.
"""
from __future__ import annotations
import copy
import json
import subprocess
import sys
from pathlib import Path
from importlib.metadata import version
from jsonschema import Draft202012Validator

ROOT=Path(__file__).resolve().parents[2]
SKILL=ROOT/'skills/cs-engineering'
EXAMPLE=SKILL/'assets/examples/sqlite-queue'
NAMES={'cs-request':'request','cs-constraint-report':'constraints','cs-review-report':'review','cs-engineering-binding':'binding','cs-candidate':'candidate','cs-policy':'policy','cs-stage-bundle':'stage-bundle'}
CASES=[]

def add(contract,label,value,expected):
    CASES.append({'contract':contract,'label':label,'value':value,'expected':expected})

for contract,example in NAMES.items():
    schema=json.loads((SKILL/f'contracts/{contract}.v1.schema.json').read_text(encoding='utf-8'))
    Draft202012Validator.check_schema(schema)
    data=json.loads((EXAMPLE/f'{example}.json').read_text(encoding='utf-8'))
    add(contract,'valid example',data,True)
    for label,mutation in [
        ('unknown property',lambda v:v.update(unknown=True)),
        ('missing required property',lambda v:v.pop(schema['required'][0])),
        ('wrong schema version',lambda v:v.update(schemaVersion='99.0.0')),
    ]:
        v=copy.deepcopy(data);mutation(v);add(contract,label,v,False)
    add(contract,'object replaced by null',None,False)
    for key,child in schema['properties'].items():
        if child.get('type')=='string' and child.get('minLength',0)>0:
            v=copy.deepcopy(data);v[key]='';add(contract,f'empty {key}',v,False);break
    for key,child in schema['properties'].items():
        if 'enum' in child:
            v=copy.deepcopy(data);v[key]='nonexistent-enum';add(contract,f'unknown {key}',v,False);break
    for case in [c for c in CASES if c['contract']==contract]:
        actual=Draft202012Validator(schema).is_valid(case['value'])
        if actual != case['expected']:raise AssertionError((contract,case['label'],actual))

module=(SKILL/'scripts/schema-validation.mjs').as_uri()
script=f"""
import {{readFileSync}} from 'node:fs';
import {{validateSchema,schemaEngine}} from {json.dumps(module)};
const cases=JSON.parse(readFileSync(0,'utf8'));
const results=cases.map(c=>{{try{{validateSchema(c.contract,c.value);return true;}}catch{{return false;}}}});
console.log(JSON.stringify({{schemaEngine,results}}));
"""
node=subprocess.run(['node','--input-type=module','-e',script],input=json.dumps(CASES,ensure_ascii=False),text=True,capture_output=True,check=True,cwd=ROOT,timeout=30)
observed=json.loads(node.stdout)
assert len(observed['results'])==len(CASES)
for case,actual in zip(CASES,observed['results']):
    if actual != case['expected']:raise AssertionError((case['contract'],case['label'],actual))
summary={'status':'PASS','schemas':len(NAMES),'cases':len(CASES),'agreements':len(CASES),'python':sys.version.split()[0],'pythonJsonschemaVersion':version('jsonschema'),'nodeSchemaEngine':observed['schemaEngine'],'scope':'Structural examples and negative cases compared with Python Draft 2020-12 and the packaged Node engine. Not a complete general JSON Schema conformance suite.'}
print(json.dumps(summary,ensure_ascii=False,indent=2))
if '--write-evidence' in sys.argv:(ROOT/'evidence/schema-reference-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
