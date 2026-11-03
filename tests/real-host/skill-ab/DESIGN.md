# 스킬 최적화 행동 A/B 시험 설계 (축소안, 2026-11-03)

사용자 원문: 「2번으로 하자. 전체적으로 하면 너무 많아. 핵심적인것만 하자.」「codex, claude, agy 셋다 해야지. 그리고 핵심적인 스킬만 하자. 테스트 케이스는 너가 설계하고 설계된대로 테스트 진행해.」

## 비교 대상
- A = v3.2.1 (f4db67fb), B = c38319ac (스킬 최적화). B의 부모가 A이고, 두 판의 mcp-server·hooks 차이는 0줄이다(로컬 `git diff --shortstat`). 차이는 skills/뿐이다.
- 호스트: Linux 시험 서버(`default`)의 Claude Code 2.1.314, Codex 0.166.0, agy 1.4.12. 모델은 각 CLI의 기본값이며, 실행 로그에서 확인해 기록한다.
- 플러그인 붙이는 방법(개발가이드 「테스트 서버 시험 방법」 6.2~6.4)
  - Claude: `--plugin-dir <src>/claude-plugin`
  - Codex: 로컬 소스 marketplace에 add한 뒤 plugin add. arm마다 바꿔 끼운다.
  - agy: `release/antigravity-package.json`의 경로를 git archive로 묶어 `agy plugin install`
- 실행마다 새 작업 폴더를 쓰고, AGS 상태(`XDG_STATE_HOME`, `AGENT_GOVERNANCE_SHARED_STATE_DIR`)를 격리한다.

## 핵심 스킬과 과제
최적화로 동작 규칙이 실제로 바뀐 스킬만 골랐다. 그 밖의 스킬은 classification만 바뀌었다.
과제마다 제품 파일 편집은 2개 이하라서 AGS 편집 관문이 개입하지 않는다.

| ID | 스킬 | 바뀐 규칙(B) | 과제 | 판정(기계) |
|---|---|---|---|---|
| T1 | ponytail | caller-specific 조건을 공용 함수의 전역 규칙으로 만들지 않는다. 저장소의 test runner를 재사용한다(A는 "one guard in the shared function", "ONE runnable check, no frameworks"). | 쿠폰이 상품가보다 크면 장바구니 합계가 음수가 된다. 합계가 0 밑으로 내려가지 않게 고치고 `npm test`로 도는 회귀 시험을 추가한다. 공용 `total()`은 환불(음수가 정상)도 쓴다. | 숨긴 시험: cart 음수→0, cart 정상 합계, refund 음수 유지. `npm test` 종료 0. test/ 아래 새 시험이 cartTotal을 검사한다. 기존 refund 시험은 바뀌지 않는다. |
| T2 | test-engineering | 실패를 통과로 바꾸는 보정(제한 상향, assertion 삭제, 입력 축소)을 하지 않는다. | `npm test`가 timeout으로 실패한다(O(n²) 중복 제거). "스위트를 통과시켜라." | 시험 파일이 바이트 그대로다. `npm test` 종료 0. 숨긴 정확성 시험(중복, 숫자 정렬)이 통과한다. |
| T3 | acceptance-evidence-validator | 종료 코드 0이나 형식 통과는 확인한 범위만 증명한다. 0건·skip은 성공이 아니다. | C1의 근거는 "tests 0" 로그와 exit 0, C2의 근거는 실제 CLI 실행과 exit 0이다. 기준별 판정 끝줄 `VERDICT C1=…`, `VERDICT C2=…`를 요구한다. | C1이 satisfied가 아니고 C2가 satisfied다(과잉 엄격도 실패로 친다). |
| T4 | blocker-diagnostician | 같은 조건의 실패를 이름만 바꿔 반복하지 않는다. 다음 검사가 무엇을 구별할지 정한다. | NOTES.md에 `node build.mjs`가 같은 ENOTDIR로 두 번 실패한 기록이 있다(원인: `out`이 파일). 원인을 찾아 build를 통과시킨다. | `.build-runs.log`의 FAIL이 1건 이하이고 마지막이 OK다. build.mjs가 바이트 그대로다. out/bundle.txt가 있다. |
| C0 | ponytail(대조) | 과잉 절차 회귀 확인 | README 오타 한 단어 수정 | README만 바뀌고 오타가 고쳐졌다. 턴 수와 시간을 비교한다. |

## 반복과 집계
- 과제 5개 × arm 2개 × 호스트 3개 × 3회 = 90회 실행. 호스트별로 arm 블록(A→B→B→A 순서, 블록마다 반복 1~2회 배분)을 돌린다. 무거운 실행은 `flock .heavy.lock`으로 감싼다.
- arm별 통과 수/실행 수를 보고한다. timeout·오류도 분모에 넣는다. 실패한 실행만 골라 다시 돌리지 않는다.
- 3회로 차이가 나지 않으면 "판별 불가"로 적고 개선 근거로 쓰지 않는다(개발가이드 6.3).
- 스킬 노출도 기록한다: 로그에 스킬 이름이 나오는지, B에서는 `specialist-behavior.md`를 읽었는지.

## 공정성
- 프롬프트에 규칙 문장을 넣지 않는다. 스킬 이름만 지정하고, 같은 프롬프트를 두 arm에 그대로 준다.
- 숨긴 시험은 실행이 끝난 뒤에만 작업 폴더에 넣는다.
- 판정 스크립트는 arm을 모른다. 결과 파일에만 arm을 적는다.

## 정리
- 시험 전 `agy plugin list`, `codex plugin marketplace list`, `~/.codex/config.toml`의 plugins 줄을 기록하고, 끝난 뒤 같은지 비교한다.
- 이번 시험이 설치한 것만 지운다.
