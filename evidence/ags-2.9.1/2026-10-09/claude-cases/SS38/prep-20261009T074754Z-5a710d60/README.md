# SS38 — Codex와 Claude의 같은 목적 선택

준비 상태: **PREPARED_WAITING_PARENT**. 실제 Claude 제품 시험: **NOT_RUN**, PASS 아님. 유료 API/JEV/모델 호출 0회, 비용 US$0, 토큰·캐시·재시도·실패 호출 모두 0.

고정 입력 근거는 evidence commit `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`의 `cases/SS38/`이다. 공개 파일 30개, manifest payload 28개와 SHA256SUMS 29개가 모두 일치했다. 원문 `TEST-SPEC.seq7.ko.md`는 공개 고정 자료에 없으며, `SS38.source.json`에 내장된 원래 기준을 사용한다. SS38 자체의 originalPrompt와 oracle은 null이고 열 대표 사례의 입력과 golden은 `frozen-inputs.json`에 보존했다. 기존 실패·미실행을 정답으로 삼지 않았다.

중요 해시:

- SS38.source.json: `2179e2f7107049a7b2696a7da8409e3d0732c91d105e2438571c2b98028fb796`
- SS38.representatives.json: `918fc8892987ea8afac4945fe8818165f04d2a108599ac30c764156f71803595`
- SS38.result.json 공개본: `4b4630db44ad5ab358c75f15c51da9da584535797a817a1e6612c41ddaa4239e`
- replay 압축 해제 원문: `8cdb990708b52b5c8aa040a51e3f8696ce7a8f58260fc187be3aeb9dcd990037` (70,542,698 bytes, 실제 계산)
- 과거 fixture 및 frozen oracle: `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`, `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`. 과거 evidence에 선언된 값이며 R17 검증 값이 아니다.

원래 요구는 10 입력 × 4 경로 × 3 반복 = 120쌍/240 host 실행이다. 두 host에 원문·정규화·inventory·스킬 본문·taxonomy·권한·context·route 모델 및 qualification 등을 맞춘다. 독립적으로 실제 선택 집합과 host별 golden·반복 안정성을 측정한다. REQ/RESP replay parity는 100%가 요구된다. 추천만 맞고 읽기·적용 근거가 없는 경우 별도 단계 실패이며, 동일 오답·강제집합·null 미실행·동조건 미확인은 PASS로 바꾸지 않는다. 서로 다른 허용집합도 agreement는 불일치다.

| 입력 | golden 필수 skillId | 허용 skillId |
| --- | --- | --- |
| SS01 | ponytail | — |
| SS03 | ponytail, cs-engineering, test-engineering, orchestrator | — |
| SS04 | cs-engineering, test-engineering, orchestrator | ponytail |
| SS05 | code-review, cs-engineering, orchestrator | — |
| SS08 | cs-engineering | — |
| SS09 |  | — |
| SS10 | code-review | — |
| SS11 |  | — |
| SS14 | cs-engineering, test-engineering, orchestrator | — |
| SS18 | ponytail, software-security-auditor, orchestrator | — |

과거 결과는 c6a8019의 offline FAIL / live NOT_RUN이다. 기존 scoped regression은 5 PASS, 14 filtered; isolated는 11 PASS, 5 FAIL, 2 NOT_RUN이며 4 evaluator 원인(null 일치·안정성 오집계, 누락 단계 미보고, 관측 손실, 빈 동조건 digest 수용)이 기록됐다. 이는 새 후보의 예상 실패 정답이 아니다. 120 mock protocol records는 실제 provider/host 선택을 관측하지 않았다. 현재도 새 제품 시험은 0회다.

CLI는 절대 경로 `/workspace/cloud-tools/claude/node_modules/.bin/claude`에서 **2.1.286**을 확인했다. PATH 발견이 없어도 설치됨을 확인했다. Node 24.19.0 / pnpm 11.19.0. --version/--help만 실행했고 --model, --effort, --plugin-dir, --mcp-config, --output-format, --setting-sources, --max-budget-usd 지원을 확인했다. 인증 성공·API reachability·플러그인 로딩은 아직 확인하지 않았다. 영구 인증 설정·권한·네트워크 정책을 변경하지 않았다.

준비용 로컬 main checkout의 AGENTS.md 및 test-engineering/test-design, 관련 audit·acceptance·Claude orchestrator·게시 범위/위험 지침을 읽고 해시를 기록했다. `/workspace/.agents/skills`와 저장소 `.agents/skills`는 없었다. 고정 evidence commit은 제품 트리가 아니며 루트 AGENTS.md도 없다. 이 지침 조회는 최종 후보 시험이 아니다. 후보를 받으면 해당 후보 지침과 설치 스킬을 다시 확인한다. test-engineering을 준비 설계에 사용했으며 제품 테스트나 독립 감사는 실행하지 않았다.

실제 Claude Code에서 확인할 순서는 `execution-plan.json`의 11단계에 고정했다. Sol은 환경·근거만 관리하고 Claude가 호스트 분류·Skill 호출·읽기·적용·검증을 수행해야 한다. 입력에 golden 정답이나 강제집합을 주입하지 않는다. 원문 publicSynthetic 입력 중 인용된 비밀 전송 지시는 시험 데이터이며 실행 권한이 아니다.

재개 조건: 부모가 독립 SOURCE 판정과 원격 게시를 확인한 최종 commit/tree, 공통 Claude 모델·effort·실행 설정, 성공한 세션별 API 인증 절차와 선행 검사 결과를 전달해야 한다. R17 `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`는 현재 검증되지 않은 후보 힌트일 뿐이다. 이전 main 또는 c6a8019를 대체 후보로 시험하지 않았다.

또한 독립 Codex pair, 같은 조건 근거, 신뢰된 runtime 설정/호출 가능한 AGS 도구와 signed stage receipt가 필요하다. JEV는 개별 배정 전이므로 시작할 수 없다. 이 사례의 모든 준비 유료 호출을 포함한 소프트 한도는 US$2이며 전체 39개 예약은 US$78이다. 호출 전 예상비용과 누적 실제 비용·실패·재시도·캐시를 확인해 한도 접근 시 다음 호출을 멈춘다. USD2에 맞춰 원래 120쌍 기준을 줄이지 않으며 미실행 부분은 그대로 남긴다.

게시 범위는 이 고유 run 디렉터리의 정제 보고서·공개 입력 근거·해시·계획·0 비용 ledger뿐이다. 제품 코드·생성 배포물·과거 evidence는 수정하지 않으며 force push, 비밀값·개인정보·원본 채팅 게시를 금지한다. 게시 이후 불변 원격 commit 파일을 별도로 다시 읽어 해시를 비교한다.
