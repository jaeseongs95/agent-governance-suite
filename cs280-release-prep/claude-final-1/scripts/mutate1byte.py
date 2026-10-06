import sys,hashlib
p=sys.argv[1]; b=bytearray(open(p,'rb').read()); before=hashlib.sha256(b).hexdigest()
i=b.rindex(b'}'); b.insert(i, 0x20)  # one extra byte of whitespace before the final brace
open(p,'wb').write(b); print(f"mutated {p}: +1 byte, sha256 {before} -> {hashlib.sha256(b).hexdigest()}")
