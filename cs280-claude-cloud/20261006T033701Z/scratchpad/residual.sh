#!/usr/bin/env bash
# usage: residual.sh <dir> <literal-list>  -> counts only, never values
R=$1; L=$2
mapfile -t FILES < <(cd "$R" && find . -type f ! -name SHA256SUMS ! -name MANIFEST.tsv -printf '%P\n' | sort)
echo "# residual grep over ${#FILES[@]} files (recursive; excludes control files SHA256SUMS, MANIFEST.tsv)"
cd "$R" || exit 1
chk(){ printf '%-26s %s\n' "$1" "$(cat "${FILES[@]}" | grep -cP "$2")"; }
chk email '(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9])'
chk github-token '(?<![A-Za-z0-9])(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})'
chk sk-standalone-token '(?<![A-Za-z0-9])sk-[A-Za-z0-9_]{20,}'
chk sk-word-internal '(?<=[A-Za-z0-9])sk-'
chk slack-xox '(?<![A-Za-z0-9])xox[abprse]-[A-Za-z0-9-]{10,}'
chk aws-AKIA 'AKIA[0-9A-Z]{16}'
chk bearer-value '(?i)Bearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{8,}'
chk secret-assignment '[A-Za-z0-9](_TOKEN|_SECRET|_KEY)=(?!\[REDACTED\])[^\s"'"'"',;]{4,}'
chk jwt 'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.'
chk windows-home-name '(?i)(c:\\\\?users\\\\?|c:/users/[REDACTED]/c/users/[REDACTED]\[REDACTED\])[A-Za-z0-9]'
chk account-name '(?i)([REDACTED]|[REDACTED]|[REDACTED])'
chk url-query 'https?://[^\s?#"'"'"'<>]+\?(?!\[REDACTED\])[^\s"'"'"'<>]'
chk ipv4-non-loopback '(?<![0-9.])(?!127\.0\.0\.1(?![0-9.]))(?!0\.0\.0\.0(?![0-9.]))(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![0-9.])'
chk encoded-block-200 '(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{200,}'
python3 -I - "$L" "${FILES[@]}" <<'PY'
import ipaddress, re, sys
lits = [l.rstrip("\n") for l in open(sys.argv[1]) if len(l.strip()) >= 6]
texts = [open(f, encoding="utf-8").read() for f in sys.argv[2:]]
print("%-26s %d" % ("runtime-secret-literal", sum(t.count(l) for t in texts for l in lits)))
n = 0
for t in texts:
    for m in re.finditer(r"(?<![0-9A-Za-z:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Za-z:])", t):
        try:
            ip = ipaddress.ip_address(m.group(0))
        except ValueError:
            continue
        n += str(ip) not in ("::1", "::")
print("%-26s %d" % ("ipv6-non-loopback", n))
PY
