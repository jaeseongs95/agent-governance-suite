import base64, collections, datetime, hashlib, json, pathlib, re, sys
root=pathlib.Path(sys.argv[1]);public=root/'public'/('cs280-codex-cloud/'+root.name.removeprefix('publication-'))
inventory=json.loads((root/'audit/raw-inventory.json').read_text());by={r['path']:r for r in inventory};ledger=json.loads((public/'REDACTION.json').read_text());minimum=[]
top={'original':{'change-list.json':'archive-change-list.json','source-pin.json':'archive-source-pin.json','verification-report.ko.md':'verification-report.ko.md','verification-status.json':'archive-verification-status.json'},'r1':{'change-list.json':'archive-change-list.json','source-pin.json':'source-pin.json','verification-report.ko.md':'verification-report.ko.md','verification-status.json':'verification-status.json'},'r2':{n:n for n in ['change-list.json','source-pin.json','verification-report.ko.md','verification-status.json']}}
for stage in top:
 for row in inventory:
  if row['stage']==stage and row['path'].startswith(stage+'/evidence/') and pathlib.Path(row['path']).suffix in ('.log','.json','.jsonl'):minimum.append(dict(stage=stage,logicalName=row['path'].split('/evidence/')[1],publicPath=row['path'],originalSha256=row['originalSha256']))
 for logical,name in top[stage].items():
  path=stage+'/reports/'+name;row=by[path];minimum.append(dict(stage=stage,logicalName=logical,publicPath=path,originalSha256=row['originalSha256']))
counts=collections.Counter(r['stage'] for r in minimum);assert counts=={'original':68,'r1':33,'r2':21},counts
critical={'pid','ppid','parent_pid','start','starttime','state','exit','exitCode','commandExitCode','sourceCommit','baseCommit','passed','failed','skipped','total','notSelected','subreaper','databaseReads','instanceId','transport','role','classification'}
def signatures(value,path=()):
 out=[]
 if isinstance(value,dict):
  for k,v in value.items():
   if k in critical and not isinstance(v,(dict,list)):out.append((path+(k,),v))
   out+=signatures(v,path+(k,))
 elif isinstance(value,list):
  out.append((path+('recordCount',),len(value)))
  for n,v in enumerate(value):out+=signatures(v,path+(n,))
 return out
checked=[];encoded=[]
encoded_pattern=re.compile(r'(?<![A-Za-z0-9+/])(?:H4sI[A-Za-z0-9+/=]{64,}|[A-Za-z0-9+/]{256,}={0,2})(?![A-Za-z0-9+/=])')
for row in inventory:
 p=root/'private'/row['path'];q=public/row['path'];raw=p.read_bytes();published=q.read_bytes();assert hashlib.sha256(raw).hexdigest()==row['originalSha256']
 if p.suffix=='.json':assert signatures(json.loads(raw))==signatures(json.loads(published)),row['path']
 if p.suffix=='.jsonl':
  a=[json.loads(x) for x in raw.decode().splitlines() if x.strip()];b=[json.loads(x) for x in published.decode().splitlines() if x.strip()];assert len(a)==len(b) and signatures(a)==signatures(b),row['path']
 if p.suffix=='.log':
  # Entire original line sequence is retained. Parsed header normalization stays one line.
  a=raw.decode().splitlines();b=published.decode().splitlines();assert len(a)==len(b),row['path']
  patterns=[r'\b\d+ (?:passed|failed|skipped)\b',r'\b(?:PASS|FAIL|SKIP|NOT_RUN|NOT_IMPLEMENTED|BLOCKED)\b']
  for pattern in patterns:assert re.findall(pattern,raw.decode())==re.findall(pattern,published.decode()),row['path']
 checked.append(dict(path=row['path'],recordOrderAndCriticalValuesPreserved=True))
 matches=list(encoded_pattern.finditer(raw.decode()))
 if matches:
  text=published.decode()
  for match in matches:
   value=match.group(0)
   try:decoded=base64.b64decode(value,validate=True)
   except ValueError:continue
   marker={'marker':'REDACTED_ENCODED_ARTIFACT','kind':'BASE64_OPAQUE_OR_COMPRESSED','encodedBytes':len(value.encode()),'encodedSha256':hashlib.sha256(value.encode()).hexdigest(),'decodedBytes':len(decoded),'decodedSha256':hashlib.sha256(decoded).hexdigest()}
   if value in text:text=text.replace(value,json.dumps(marker,separators=(',',':')))
   encoded.append(dict(path=row['path'],**marker))
  if text!=published.decode():q.write_text(text)
 # The current supplied files have no encoded transcript payload. If encountered,
 # stop to revise the public ledger and JSON escaping rather than silently ship it.
assert not encoded,'Encoded payloads detected; public marker handling and ledger need review before publication'
for row in minimum:row['publicSha256']=hashlib.sha256((public/row['publicPath']).read_bytes()).hexdigest()
result=dict(minimumFiles=len(minimum),byStage=dict(counts),mismatchCount=0,files=minimum,allAvailableOriginalCopies=len(inventory),allOriginalCopiesChecked=len(checked),recordsOrderExitStatusAndProcessIdentityPreserved=True,encodedTranscriptPayloadsSupplied=0,encodedPayloads='NOT_VERIFIABLE: no native transcript payload supplied; any future supplied payload requires REDACTED_ENCODED_ARTIFACT metadata-only handling',cutoff=datetime.datetime.now(datetime.timezone.utc).isoformat())
(root/'audit/minimum-preservation.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
excluded=json.loads((public/'EXCLUSIONS.json').read_text())
markers=[dict(marker='REDACTED_ENCODED_ARTIFACT',kind=pathlib.Path(r['path']).suffix.removeprefix('.').upper(),bytes=r['bytes'],sha256=r['originalSha256'],path=r['path'],rawPayloadPublished=False) for r in excluded]
(root/'audit/encoded-artifact-markers.json').write_text(json.dumps({'excludedRawFiles':markers,'encodedNativeTranscriptPayload':'NOT_VERIFIABLE/not supplied','publicPolicy':'Metadata marker only; no base64/compressed/Gitbundle raw payload'},indent=2)+'\n')
print(json.dumps({k:result[k] for k in ['minimumFiles','byStage','mismatchCount','allAvailableOriginalCopies','recordsOrderExitStatusAndProcessIdentityPreserved','cutoff']}))
