# SS33 — AGS 2.9.1 기존 개발 검증 근거

기존 오프라인 판정: **FAIL**. 이 게시 단계의 새 시험과 JEV/vendor/Claude/Codex 모델 호출은 모두 **0**이다.

| 변형 | 기존 오프라인 상태 | 실제 호스트 |
|---|---|---|
| secret-sentinel | FAIL — 전송 차단 응답이 task 비밀 표식 1회 포함 | NOTRUN |
| jev-budget | FAIL — invalid RESP의 유효 비용 유실 | NOTRUN |
| vendor-unapproved | FAIL — credential 대기 중 승인 철회 뒤 mock fetch 1회 | NOTRUN |
| vendor-unknown-budget | PASS — 기록된 경계 검사만 | NOTRUN |
| inflight-reservation | PASS — 기록된 경계 검사만 | NOTRUN |

기존 SS33 회귀는 9 PASS / 36 SKIPPED였다. 최종 신규 격리 실행은 16개 중 13 PASS / 3 FAIL, exit 1이다. 초기 실행은 14개 중 12 PASS / 2 FAIL이었으며 `initial` 파일로 구분한다. 초기와 최종 테스트 바이트가 다르므로 둘을 동일 테스트의 red/green 증거로 사용하지 않는다. 모든 로그·관측은 이미 끝난 실행에서 회수한 것이다.

고정 후보 commit `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`, tree `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`.
원 fixture SHA256 `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`, 동결 oracle SHA256 `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`.
SS33의 `originalPrompt`, `oracle`, 정확도 점수와 실제 선택 집합은 `null`이다. `selected/read/applied/verified`는 모두 **NOTRUN**이며 추천을 실제 AGENT 선택으로 취급하지 않는다.

원인별 근거는 `SS33.result.json`과 `observations/isolated-observations.json`에 있다. 비용 유실은 기존 발견과 동일 원인이다. 승인 철회 재현은 알려진 전송 직전 재검사 공백에 연결하되 생산 환경의 상태 공급까지 실제 검증한 것은 아니다. 새 고유 결함으로 중복 집계하지 않는다. 합성 누적 비용 `$5.5`와 장부 `$4.1`은 mock 관측이며 실제 청구액이 아니다.

원본과 공개본은 다르다. 개인 로컬 절대 경로는 상징 placeholder로, 합성 비밀 표식은 공개 대체 표식으로 바꿨다. 재현 테스트의 private 기본 경로도 `process.cwd()`로 치환했다. 실제 자격정보는 사용하거나 게시하지 않았다. 공개 입력/테스트는 재실행하지 않았으며 original SHA와 public SHA를 `manifest.json`에 따로 기록했다. 기존 snapshot/plan check의 digest는 원본 시험 바이트에 대한 값이다.

`manifest.json`은 모든 payload 파일의 bytes/SHA256와 원본 provenance를 포함하고 자신과 `SHA256SUMS`는 제외한다. `SHA256SUMS`는 payload와 manifest를 포함하고 자신은 제외한다. 두 control 파일의 최종 SHA는 게시 완료 응답에서 제공하며 순환 hash가 없다.

MISSING_ORIGINAL: 기존 회귀의 분리 stdout/stderr(merged 로그만 존재), 비밀이 포함된 원래 gateway 응답(처음부터 저장하지 않음), 외부 `TEST-SPEC.seq7.ko.md` 원문(embedded 원문만 존재). 원본 제품 수정 patch는 **NONE_CREATED**이며 새 patch를 만들지 않았다.

실제 호스트 구성·현재 예산·승인된 profile·활성 AGS MCP 도구·서명 관측이 없는 한 host 결과는 NOTRUN이다. 필요한 경로와 입력은 `host-support.json`에 기록했다. 이것은 독립 수용 감사나 릴리스 승인 근거가 아니다. 제품 root/main/tag와 다른 사례 경로는 이 게시물에서 변경하지 않는다.

재현 안내는 `repro/reproduce.md`를 참조한다. 이 게시 작업은 안내 명령을 실행하지 않았다.
