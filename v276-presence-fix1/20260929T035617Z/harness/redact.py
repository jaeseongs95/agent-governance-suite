import re, sys, os, json
root=sys.argv[1]
rules=[
 ("github-token", re.compile(r"\b(ghp_|gho_|github_pat_)[A-Za-z0-9_]+"), "[REDACTED]"),
 ("anthropic-key", re.compile(r"sk-ant-[A-Za-z0-9_-]+"), "[REDACTED]"),
 ("aws-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[REDACTED]"),
 ("private-key-line", re.compile(r"^.*BEGIN [A-Z ]*PRIVATE KEY.*$", re.M), "[REDACTED]"),
 ("bearer", re.compile(r"(?i)(authorization:\s*)?bearer\s+[A-Za-z0-9._~+/=-]+"), "[REDACTED]"),
 ("email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b(?<!noreply@anthropic\.com)"), "[REDACTED]"),
 ("home-path", re.compile(r"/home/[A-Za-z0-9._-]+"), "/home/[REDACTED]"),
 ("root-home", re.compile(r"(?<![A-Za-z0-9_])/root(?=/|\b)"), "/[REDACTED-HOME]"),
 ("ipv4", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "[REDACTED]"),
 ("account-name", re.compile(os.environ["AGS_REDACT_ACCOUNT_PATTERN"]), "[REDACTED]"),
 ("windows-home", re.compile(r"(?i)[A-Z]:\\{1,2}Users\\{1,2}[^\\/\s\"']+"), r"C:\\Users\\[REDACTED]"),
]
counts={n:0 for n,_,_ in rules}
for d,_,fs in os.walk(root):
  for f in fs:
    if f=="SHA256SUMS": continue
    p=os.path.join(d,f)
    try: s=open(p,encoding="utf-8").read()
    except Exception: continue
    o=s
    for n,r,rep in rules:
      s,k=r.subn(rep,s); counts[n]+=k
    if s!=o: open(p,"w",encoding="utf-8").write(s)
print(json.dumps(counts))
