import os,re,sys,ipaddress
root=sys.argv[1]
A=["jae"+"seongs95","sjs"+"9505","sjs"+"95"]
P={"email":r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}","github-token":r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})","sk-token":r"(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}","slack-xox":r"\bxox[abprs]-[A-Za-z0-9-]{10,}","aws-AKIA":r"\bAKIA[0-9A-Z]{16}\b","jwt":r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}","bearer":r"(?i)Bearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{8,}","secret-assignment":r"\b[A-Z0-9_]*(?:_TOKEN|_SECRET|_KEY)=(?!\[REDACTED\])[^\s\"',;]+","url-query":r"https?://[^\s\"'?<>]+\?(?!\[REDACTED\])[^\s\"'<>)]+","windows-home":r"(?i)(?:[A-Z]:[\\/]{1,2}|/[a-z]/)Users[\\/]{1,2}(?!\[REDACTED\])[^\\/\s\"']+","account-name":"|".join(A),"encoded-block-200":r"(?![0-9a-f]{200})[A-Za-z0-9+/_-]{200,}"}
c={k:0 for k in P}; c["ipv4-non-loopback"]=0; n=0
for dp,_,fs in os.walk(root):
  for f in fs:
    if f in("SHA256SUMS","MANIFEST.tsv"): continue
    try: s=open(os.path.join(dp,f),encoding="utf-8").read()
    except UnicodeDecodeError: continue
    n+=1
    for k,r in P.items(): c[k]+=len(re.findall(r,s,re.I if k=="account-name" else 0))
    for v in re.findall(r"(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])",s):
      try: ipaddress.ip_address(v)
      except ValueError: continue
      if v not in("127.0.0.1","0.0.0.0"): c["ipv4-non-loopback"]+=1
print(f"# residual over {n} files"); [print(f"{k:24s} {v}") for k,v in c.items()]
