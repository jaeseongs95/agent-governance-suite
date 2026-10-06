import importlib.util, json, hashlib, pathlib, sys
root=pathlib.Path(sys.argv[1]);target=sys.argv[2];source=pathlib.Path(sys.argv[3]);public=root/'public'/('cs280-codex-cloud/'+root.name.removeprefix('publication-'))
spec=importlib.util.spec_from_file_location('publication_redactor',root/'redact.py');redactor=importlib.util.module_from_spec(spec);spec.loader.exec_module(redactor)
redactor.ids=set(json.loads((root/'audit/known-private-resource-ids.json').read_text()))
index=root/'audit/publication-artifact-registry.json';rows=json.loads(index.read_text()) if index.exists() else []
raw=source.read_bytes();number=len(rows)+1;p=root/'private/publication'/f'{number:03d}'/source.name;p.parent.mkdir(parents=True);p.write_bytes(raw);p.chmod(0o400)
sanitized,counts=redactor.redacted_bytes(raw,source.suffix)
out=public/target;out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(sanitized)
row=dict(path=target,originalBytes=len(raw),originalSha256=hashlib.sha256(raw).hexdigest(),publicBytes=len(sanitized),publicSha256=hashlib.sha256(sanitized).hexdigest(),removalsByKind=counts,removalCount=sum(counts.values()),privateSnapshot=str(p),kind='publication-only artifact')
rows.append(row);index.write_text(json.dumps(rows,indent=2)+'\n')
print(json.dumps({k:row[k] for k in ('path','originalSha256','publicSha256','removalCount')}))
