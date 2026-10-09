from pathlib import Path
import subprocess,sys
root=Path(__file__).resolve().parent
modules=root/'repo/node_modules'
if not modules.is_dir():
    raise SystemExit('Existing dependencies missing; prepare Node24 and pinned pnpm dependencies separately.')
for p in [root/'node_modules']:
    if not p.exists(): p.symlink_to(modules,target_is_directory=True)
argv=['node',str(modules/'vitest/vitest.mjs'),'run','SS01.test.ts','--root',str(root),'--reporter=verbose']
r=subprocess.run(argv,cwd=root)
sys.exit(r.returncode)
