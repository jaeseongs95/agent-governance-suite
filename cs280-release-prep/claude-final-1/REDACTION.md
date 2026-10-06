# 민감정보 제거 기록 (REDACTION)

- 동결 cutoff: `2026-10-06T06:04:22Z` (이 시점에 `$ST/out`을 복사해 redaction했다. 그 뒤 기록은 `worklog-append-1/`과 `NOT_VERIFIABLE.md` 참고)
- 교체한 값은 `[REDACTED]`, 200자 이상 인코딩 블록은 `[REDACTED_ENCODED_ARTIFACT: base64/<길이>/<SHA256>]`로 표시한다. 원래 값은 어디에도 적지 않는다.

## 규칙 (`redact.py`, 공개본은 worklog-append-1/에 있다)
- 이메일(`noreply@anthropic.com` 커밋 attribution은 남긴다), 사람 계정명 3종, Windows 사용자 홈의 사용자명
- IPv4(127.0.0.1, 0.0.0.0은 남긴다)
- ghp_/gho_/ghu_/ghs_/ghr_/github_pat_, 단독 sk-, xox?-, AKIA+16, JWT, `Bearer <값>`, `*_TOKEN|_SECRET|_KEY=` 값, http(s) URL query
- 200자 이상 base64 블록(16진 digest 연속은 제외)
- 런타임 비밀값 리터럴 대조: 이름에 TOKEN/SECRET/KEY/PASSWORD/SOCKET/CREDENTIAL이 들어간 환경 변수 값(경로 값 제외)과 session ingress token 파일 내용, 5개. 목록은 repo 밖 임시 파일에만 두었고 사용 직후 삭제했다. 대조 결과 교체 0건이다.
- 남기는 것: commit/tree SHA, 파일 해시, session·container ID, observationId·integrityToken(일회성 서명값이며 키가 아니다), 테스트 이름, VM 경로(`/root`, `/home/user/repo`). VM 경로는 이전 CS280 evidence와 같은 기준으로 남겼다.

## 파일별 교체 (133개 중 7개 변경, 나머지 0건)
| 파일 | 교체 |
| --- | --- |
| `C2/child-transcripts/-root-cs2x-final-20261006T054615Z-flow/15064980-a58d-565b-a1d4-887c2e2a8760.jsonl` | account-name=4, encoded-block-200=28 |
| `C2/child-transcripts/-root-cs2x-final-20261006T054615Z-flow/15064980-a58d-565b-a1d4-887c2e2a8760/subagents/agent-a74000ae2871c45fd.jsonl` | account-name=2, encoded-block-200=1 |
| `C2/child1-stream.jsonl` | encoded-block-200=29 |
| `C2/child2-stream.jsonl` | encoded-block-200=16 |
| `logs/32-C2-child-session.stdout` | encoded-block-200=29 |
| `logs/34-C2b-child-session-traced.stdout` | encoded-block-200=16 |
| `session-transcript/15064980-a58d-565b-a1d4-887c2e2a8760.jsonl` | account-name=20, email=1, encoded-block-200=61, secret-assignment=4, windows-home=6 |

- 인코딩 블록은 대부분 transcript의 thinking signature 등 base64 필드다.

## 잔여 검사 (control 파일 SHA256SUMS·MANIFEST.tsv와 이 문서 작성 전, 133개 파일)
```
# residual over 133 files
email                    12
github-token             0
sk-token                 0
slack-xox                0
aws-AKIA                 0
jwt                      0
bearer                   0
secret-assignment        0
url-query                0
windows-home             0
account-name             0
encoded-block-200        0
ipv4-non-loopback        0
```
- email 12건은 모두 `noreply@anthropic.com`이다.

## 구조화 내부 추론 제거 보정

- 적용 기준: 공개 evidence commit `28846ad0ff51e514f5e569e68f13563f3b170923`에서 확인한 실제 transcript의 structured content block만 제거했다.
- 제거 type: `thinking` 100건(6개 공개 경로, 4개 고유 Git blob). `analysis`, `reasoning`, `redacted_thinking`은 0건이었다.
- `text`, `tool_use`, `tool_result`, 사용자 명령, 실패 결과와 record 순서는 유지했다. 유효 JSON record는 target block 제거 전후 deep equality로 확인했다.
- session transcript의 기존 JSON parse-error 1행은 target type label이 없어서 원 byte 그대로 유지했다.
- 이 보정 뒤 `cs280-claude-cloud/`, `cs280-codex-cloud/`, `cs280-release-prep/`의 현재 tree Cloud packet JSON/JSONL/stdout 후보 685경로(내용 SHA-256 기준 626개)를 별도 검사했고, 실제 transcript의 structured internal block 잔여는 0건이었다.
- 새 commit은 이전 commit과 이미 가져간 Git object를 회수하지 않는다. 과거 접근 제거에는 별도 승인된 history rewrite, ref 점검과 호스팅 제공자 절차가 필요하다.

세부 전후 SHA와 건수는 `redaction-correction-1/PROVENANCE.json`에 기록한다.
