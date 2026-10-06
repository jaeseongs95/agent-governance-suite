import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);public=root/'public'/('cs280-codex-cloud/'+root.name.removeprefix('publication-'));sha=lambda b:hashlib.sha256(b).hexdigest();encode=lambda j:(json.dumps(j,ensure_ascii=False,indent=2)+'\n').encode()
ledger=json.loads((public/'REDACTION.json').read_text());ledger['files']=[r for r in ledger['files'] if not r.get('kind')=='publication-only artifact']
registry=json.loads((root/'audit/publication-artifact-registry.json').read_text()) if (root/'audit/publication-artifact-registry.json').exists() else []
latest={r['path']:r for r in registry}
for row in latest.values():ledger['files'].append({k:v for k,v in row.items() if k!='privateSnapshot'})
for r in ledger['files']:assert sha((public/r['path']).read_bytes())==r['publicSha256'],r['path']
raw_count=sum(r.get('kind')!='publication-only artifact' for r in ledger['files'])
ledger['totals'].update(originalFiles=raw_count,publicCopies=raw_count,publicationArtifactFiles=len(latest),filesInRedactionLedger=len(ledger['files']),removals=sum(r['removalCount'] for r in ledger['files']))
ledger['scope']='Source copies and publication audit artifacts. REDACTION/MANIFEST/SHA256SUMS and generated control summaries are listed in the public manifest rather than recursively hashing themselves.'
(public/'REDACTION.json').write_bytes(encode(ledger))
files=[]
for p in sorted(public.rglob('*')):
 if p.is_file() and p.name not in ('MANIFEST.json','SHA256SUMS'):
  b=p.read_bytes();files.append(dict(path=p.relative_to(public).as_posix(),bytes=len(b),sha256=sha(b)))
manifest=dict(schema='AGSPublicEvidenceManifest.v1',prefix='cs280-codex-cloud/'+root.name.removeprefix('publication-'),files=files,scope='Exact public payload except MANIFEST.json and SHA256SUMS. These two controls are externally hashed by the delivery receipt and Git tree.')
raw=encode(manifest);(public/'MANIFEST.json').write_bytes(raw)
lines=[f"{f['sha256']}  {f['path']}" for f in files]+[f"{sha(raw)}  MANIFEST.json"]
(public/'SHA256SUMS').write_text('\n'.join(lines)+'\n')
result=dict(publicFiles=len(files)+2,payloadFiles=len(files),manifestSha256=sha(raw),redaction=ledger['totals'])
(root/'audit/seal-result.json').write_bytes(encode(result));print(json.dumps(result))
