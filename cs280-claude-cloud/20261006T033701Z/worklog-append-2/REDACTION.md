# 민감정보 제거 기록 (worklog-append-2)

- **적용 규칙:** 상위 폴더 `scratchpad/redact.py`와 같은 규칙을 그대로 적용했다.
  - 이메일, 계정명, Windows 홈 경로, IPv4·IPv6(루프백·와일드카드 제외)
  - github/sk/xox/AKIA/JWT 토큰, Bearer, `*_TOKEN|_SECRET|_KEY=` 값
  - URL query, 200자 이상 base64 블록(표지로 교체)
  - 런타임 비밀값 리터럴 대조: 10개. 대조 목록은 저장소 밖 임시 파일에만 두었고 사용 직후 삭제했다(seq 49).
- **원래 값:** 교체한 원래 값은 어디에도 적지 않는다.
- **cutoff UTC:** `2026-10-06T04:46:17Z`

## 포함 범위
- `postprocess-raw/`: 후처리 원 로그 41개
  - seq 25~44의 stdout·stderr
  - seq 25는 완결본이다. append-1의 부분본은 그대로 두었다.
  - seq 44는 부분본이다.
  - `commands.jsonl`에는 seq 01~43이 있다.
- `scratchpad/build_append_manifest.py`: 수정본
- `NOT_VERIFIABLE.md`, `REDACTION.md`: 새로 쓴 문서. 잔여 검사 뒤에 썼으며 맨 아래 별도 검사로 확인했다.

## 파일별 교체 결과
- **교체 0건:** 아래 표에 없는 원자료 파일 전부
- **교체한 파일:**

| 파일 | 교체 |
| --- | --- |
| `postprocess-raw/commands.jsonl` | account-name=4 |
| `postprocess-raw/37-fetch-ff-check.stdout` | account-name=1 |
| `postprocess-raw/38-push.stderr` | account-name=1 |
| `postprocess-raw/40-precheck-ff.stdout` | account-name=1 |

- 인코딩 블록 표지는 0개다.

## 잔여 검사(seq 48 원시 출력, 원자료 42개 파일)
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

## generated 문서 패턴 검사(seq 51 원시 출력)
```
REDACTION.md 0
NOT_VERIFIABLE.md 0
```
