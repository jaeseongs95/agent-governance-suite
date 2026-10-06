# 민감정보 제거 기록 (worklog-append-1)

- **적용 규칙:** 상위 폴더 `scratchpad/redact.py`와 같은 규칙을 그대로 적용했다.
  - 이메일, 계정명, Windows 홈 경로, IPv4·IPv6(루프백·와일드카드 제외)
  - github/sk/xox/AKIA/JWT 토큰, Bearer, `*_TOKEN|_SECRET|_KEY=` 값
  - URL query, 200자 이상 base64 블록(표지로 교체)
  - 런타임 비밀값 리터럴 대조: 10개. 대조 목록은 저장소 밖 임시 파일에만 두었고 사용 직후 삭제했다.
- **원래 값:** 교체한 원래 값은 어디에도 적지 않는다.
- **cutoff UTC:** `2026-10-06T04:39:41Z`

## 파일별 교체 결과
- **교체 0건:** 아래 표에 없는 원자료 파일 전부
- **교체한 파일:**

| 파일 | 교체 |
| --- | --- |
| `push-failure.txt` | account-name=2 (저장소 소유자명) |
| `postprocess-raw/01-precheck.stdout` | account-name=1 |
| `postprocess-raw/18-fetch-check.stdout` | account-name=1 |
| `postprocess-raw/19-push.stderr` | account-name=1 |
| `postprocess-raw/21-fetch-ff.stdout` | account-name=1 |
| `postprocess-raw/commands.jsonl` | account-name=2 |

- 인코딩 블록 표지는 0개다.

## 검사 범위
- **원자료:** 42개 파일을 모두 검사했다.
  - `push-failure.txt`
  - `scratchpad/` 2개
  - `postprocess-raw/` 39개
- **generated 문서:** `REDACTION.md`와 `NOTES.md`는 잔여 검사 뒤에 썼다. 맨 아래 별도 패턴 검사로 확인했다.
- **control 파일:** `MANIFEST.tsv`와 `SHA256SUMS`에는 경로와 해시만 있다.
- **넣지 않은 것:**
  - 세션 transcript
  - 비밀값 대조 목록
  - key, DB, WAL, sqlite 파일
  - tgz·b64 사본

## 잔여 검사(seq 29 원시 출력, 원자료 42개 파일)
```
# residual grep over 42 files (recursive; excludes control files SHA256SUMS, MANIFEST.tsv)
email                      0
github-token               0
sk-standalone-token        0
sk-word-internal           0
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

## generated 문서 패턴 검사(seq 32 원시 출력)
```
/root/cs280-publish/worklog-append-1/REDACTION.md 0
/root/cs280-publish/worklog-append-1/NOTES.md 0
```
