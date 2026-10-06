# 민감정보 제거 기록 (REDACTION)

교체한 값은 `[REDACTED]`로 표시한다. 인코딩된 블록은 `[REDACTED_ENCODED_ARTIFACT: <종류>/<bytes>/<SHA256>]` 표지로 바꾼다. 원래 값은 어디에도 적지 않는다.

## 규칙(`scratchpad/redact.py`)
- **이메일 주소**
- **사람 계정명·사용자명**
- **Windows 사용자 홈의 사용자명 부분:** `C:\Users\…`, `C:/Users/…`, `/c/Users/…`
- **IPv4·IPv6:** `ipaddress`로 형식을 검증한다. `127.0.0.1`, `0.0.0.0`, `::1`, `::`는 남긴다.
- **토큰과 키:**
  - `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`
  - 단독 `sk-` 토큰
  - `xox?-`, `AKIA` + 16자
  - `Bearer <값>`
  - `*_TOKEN=`·`*_SECRET=`·`*_KEY=` 뒤의 값
  - JWT 형태(`eyJ…`)
- **http(s) URL의 `?` 뒤 query**
- **200자 이상 base64 블록:** 표지로 바꾼다.
- **런타임 비밀값 리터럴 대조:**
  - 대상: 이름에 TOKEN/SECRET/KEY/PASSWORD/SOCKET/CREDENTIAL이 들어간 환경 변수의 값과 session ingress token 파일 내용. 10개를 문자열 그대로 대조했다.
  - 대조 목록은 저장소 밖 임시 파일에만 두었고 사용 뒤 삭제했다.
- **남기는 것:** commit/tree SHA, 파일 해시, session·container ID, 테스트 이름, VM 경로(`/root`, `/home/user/repo`), 단어 안의 `risk-`·`task-`

## 검사 범위
- R의 모든 파일을 검사했다.
- 예외는 control 파일 두 개(`SHA256SUMS`, `MANIFEST.tsv`)와, 검사 뒤에 쓴 generated 문서 3개다.
  - control 파일에는 파일명과 해시만 있다.
  - generated 문서(`REDACTION.md`, `NOT_VERIFIABLE.md`, `postprocess-summary.md`)는 맨 아래의 별도 패턴 검사로 확인했다.
- 바이너리, sqlite, DB, WAL, key 파일은 없다.

## 파일별 교체 결과
- **교체 0건:** original-E 41파일(`SHA256SUMS.original` 포함), `postprocess-raw/` 중 아래 1개를 뺀 나머지
- **교체한 파일:**

| 파일 | class | 교체 |
| --- | --- | --- |
| `scratchpad/redact.py` | raw-new | account-name=3, windows-home=1 (탐지 패턴 안에 있는 계정명 목록과 경로 예시 문자열) |
| `scratchpad/residual.sh` | raw-new | account-name=3, windows-home=2 (같은 이유) |
| `postprocess-raw/01-precheck.stdout` | raw-new | account-name=1 (git fetch 출력의 저장소 소유자명) |

- 공개본 `redact.py`와 `residual.sh`는 패턴 문자열 일부가 `[REDACTED]`로 바뀌어 그대로는 원본과 같은 동작을 하지 않는다. 원본은 VM scratchpad에 있고, redaction 전 SHA는 `MANIFEST.tsv`에 적었다.
- 인코딩 블록 표지는 0개다. `cs280-b64-*` 조각은 이 폴더에 넣지 않았고, transcript는 포함하지 않는다(`NOT_VERIFIABLE.md` 참고).

## 잔여 검사(seq 09 원시 출력, control 파일을 뺀 64개 파일)
```
# residual grep over 64 files (recursive; excludes control files SHA256SUMS, MANIFEST.tsv)
email                      0
github-token               0
sk-standalone-token        0
sk-word-internal           19
slack-xox                  0
aws-AKIA                   0
bearer-value               0
secret-assignment          0
jwt                        0
windows-home-name          0
account-name               0
url-query                  0
ipv4-non-loopback          0
encoded-block-200          0
runtime-secret-literal     0
ipv6-non-loopback          0
```

`sk-` 앞 글자 확인(seq 10): `ri`(risk-) 21개, `ta`(task-) 15개. 모두 단어 안의 오탐이다.

## generated 문서 패턴 검사(seq 12 원시 출력)
```
REDACTION.md 0
NOT_VERIFIABLE.md 0
postprocess-summary.md 0
```
