# AGS 2.7.7 fix1: release notes의 hook 경로 노출 문장 정정(D-1)

- 기준: `claude/v277-utf8-framing` = `fd3f486a4ad976756532d1de0705e8a819f92778`
- 새 HEAD `00b16e845ec02a94d9d6be7877f62987687e80c7`, tree `e36595c3b9caaaeed89f3bf30b94d4fa0573e36c`
- commit `00b16e8` docs: correct the hook path exposure in the 2.7.7 notes. non-force fast-forward(`fd3f486..00b16e8`)이며 `ls-remote`로 확인했다.
- 바꾼 파일은 `docs/release-notes-v2.7.7.md` 하나다. 소스, 시험, 버전은 그대로다. `claude:build` 뒤 claude-plugin 차이는 없었다.

## 바꾼 문장

1. 5행
   - 전: hook 전달 경로는 한 번에 한 메시지(본문 4096 byte 이하)만 받으므로 응답이 16384 byte에 닿지 않아 영향이 없었습니다.
   - 후: hook 전달 경로는 한 번에 한 메시지(본문 4096 byte 이하)만 받으므로, 일반 텍스트 본문이면 응답이 16384 byte에 닿지 않습니다. 다만 제어 문자는 JSON에서 `\u0001`처럼 6 byte로 늘어나므로, 제어 문자가 많은 본문은 hook 경로에서도 응답이 16384 byte를 넘어 같은 결함을 겪을 수 있었습니다. 이번 수정은 이 경우도 고칩니다.
2. 13행
   - 전: 번들 client가 보내는 요청은 본문이 4096 byte 이하라 16384 byte에 닿기 어렵습니다.
   - 후: 번들 client가 보내는 요청은 본문이 4096 byte 이하라 일반 텍스트 본문이면 16384 byte에 닿지 않습니다. 제어 문자가 많아 JSON escape로 크게 늘어나는 본문은 요청도 16384 byte를 넘을 수 있고, 이때는 이전 broker의 reader가 그대로 적용됩니다.

`docs/architecture.md`와 `docs/session-message-lifecycle.md`에는 같은 주장이 없어 바꾸지 않았다. 공개된 v2.7.6 이하 notes는 범위 밖이다.

## 검증 (Node v24.21.0, `logs/summary.tsv`)

| 단계 | 종료 코드 |
|---|---|
| lint | 0 |
| validate:all | 0 |
| bundle:check | 0 |
| claude:build | 0 |
| claude:check | 0 (fresh) |
| git diff --check (작업 트리) | 0 |
| git diff --check fd3f486..HEAD | 0 |

## NOT_RUN

- test, runtime:check, validate:official: 문서만 바뀌었으므로 요청 목록에 없다.
- Windows 실행과 push 뒤 CI
- 감사 정보 항목 I-1~I-6은 다음 버전 후보로 남겼다.

## 가림

- evidence 폴더 밖의 스크립트로 push 전에 가렸다. 규칙은 지난번과 같다: 토큰 패턴, private key 줄, Bearer, 이메일, 사용자 홈 경로, root 홈, IP, 계정명, Windows 사용자 홈.
- 건수는 `meta.json`에 있다.
- `SHA256SUMS`는 커밋된 blob 기준이다.
