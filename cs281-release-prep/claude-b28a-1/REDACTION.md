# REDACTION

- private 원본 동결 cutoff UTC: `2026-10-06T11:34:29Z`. Cloud main transcript(상태 질문 turn 포함)와 child transcript, commands.jsonl(96행), commands-transfer.jsonl, raw/, raw-transfer/를 이 시각에 복사했다. 이후의 이송 작업(공개본 생성, preflight, commit, push)은 transcript에 없다. `tools-post-cutoff/`는 cutoff 뒤에 만든 redaction·residual 도구이고 원본 로그가 아니다.
- 파일 218개를 모두 공개 사본으로 만들었다(잔여 검출 때문에 비공개로 돌린 파일 0). private 원본과 내부 추론 전문은 공개하지 않는다.

## 규칙(순서대로 적용)

1. 구조 제거: JSON/JSONL을 파싱해 type이 thinking 또는 redacted_thinking인 content block 전체를 제거하고, signature 키를 제거한다. 원본의 signature 키는 모두 제거된 thinking block 안에 있었다(블록과 함께 제거, 별도 키 제거 0).
2. 리터럴 대조: container 환경 변수 중 이름에 TOKEN·SECRET·KEY·PASSWORD·AUTH·CREDENTIAL·COOKIE가 있는 값과 messaging broker token을 `<SECRET_LITERAL>`로 바꾼다. 목록 파일은 repo 밖에 mode 600으로 두었다. 잔여 검사가 끝난 직후 삭제했고, 값은 어디에도 기록하지 않았다.
3. 패턴: email → `<EMAIL>`; GitHub·sk-·Slack·AWS·JWT 토큰; Bearer 값; 이름이 _TOKEN, _SECRET, _KEY로 끝나는 변수 대입 값; Cookie·Set-Cookie·Authorization·Proxy-Authorization·X-API-Key 값 → `<REDACTED>`; plan_workflow integrityToken 값; URL query; IPv4; 200자 넘는 base64; 홈·사용자 경로(`/root`, `/home/<name>`) → `<REDACTED_HOME>`.
4. 계정 이름(GitHub 사용자명, 이메일 local part) → `<ACCOUNT>`. 예외: 저장소 결속 근거인 저장소 식별자 `jaeseongs95/agent-governance-suite`는 유지한다.
5. 문자열에 포함된 thinking 또는 signature JSON 패턴(redaction·residual 스크립트 소스와 설명 문구에 있던 것) → `<PATTERN_TEXT_REDACTED>`. 이 문자열은 실제 추론 내용이 아니다.
- 과잉 제거 주의: child 지시와 TaskEnvelope의 authorization 항목 줄은 header 규칙에 걸려 값이 `<REDACTED>`가 됐다. 원문은 private에만 있다.
- 재직렬화: JSONL은 compact JSON, `.json`은 2칸 들여쓰기로 다시 썼다. 그래서 redaction이 0인 파일도 public sha가 원본과 다를 수 있다. 원본 sha는 MAPPING.tsv와 MANIFEST.tsv에 있다.

## 항목별 제거 수(합계)

| 항목 | 수 |
|---|---|
| account | 44 |
| auth_header | 9 |
| base64_long | 10 |
| email | 21 |
| home_root | 717 |
| home_user | 700 |
| integrity_token | 15 |
| ipv4 | 10 |
| pattern_text_signature | 7 |
| pattern_text_thinking | 2 |
| secret_assign | 2 |
| thinking_blocks | 57 |
| url_query | 2 |

파일별 수는 MANIFEST.tsv의 `redactions` 열에 있다. 잔여 검사 결과는 residual.tsv에 있다.
