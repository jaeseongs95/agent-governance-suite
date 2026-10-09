# SS21 — 동일 REQ RESP와 코드 포장

상태: **준비 완료 / 부모 입력 대기**. 실제 Claude Code 제품 시험 **NOTRUN**, PASS 주장 없음. 유료 모델/API 호출 0, JEV 호출 0, 이 사례 지출 US$0.

## 고정 근거와 기대 결과

공개 evidence commit `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`의 SS21 자료를 읽었다. 원래 `originalPrompt=null`, `oracle=null`이고 `TEST-SPEC.seq7.ko.md` 원본은 부재한다. `SS21.source.json`의 내장 `sourceSpec.fields`가 기준이다. 제목과 입력·판정 기준을 변경하지 않았다. 공개 원본 위치: https://github.com/jaeseongs95/agent-governance-suite/tree/af579e2caa8c09b380bdf88b5e9c675b0b0b9c68/evidence/ags-2.9.1/2026-10-09/cases/SS21/

SHA256SUMS의 공개 파일 20개, manifest의 크기/해시 19개, gzip 해제 JSON의 크기/해시를 대조했다. 모두 일치했다. 과거 fixture SHA256 `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`와 JS JSON.stringify 방식 동결 oracle SHA256 `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`를 재계산해 확인했다. SS21.source.json SHA256 `7dca9fae18c67d3bfcaac211f7809b590b41426e78ced71b8427d9fd33ce937f`. 공개/원래 artifact 해시를 혼동하지 않는다. 원래 raw network wire bytes는 별도로 보존되지 않았고 기존 parsed objects만 있다.

같은 원문 prompt·확인 metadata·전체 inventory·request/operation ID를 무손실 코드 포장해 공통 REQ로 만들고 adapter만 바꾼다. 같은 상위 소비 코드가 동일 schema·상태·오류·불확실 계약을 소비해야 한다. 원문·부정·인용·제약·전체 후보의 digest/count를 유지하고, 앞단 포장 LLM 호출과 추가 요약 토큰은 0이어야 한다. 실제 분류 입력 tokens/cost는 포장 시간과 별도로 측정하고 미확인을 0으로 쓰지 않는다. 최종 선택 주체는 AGENT다. 전체 내장 기준과 단계별 기대 결과는 input-evidence.json 및 execution-plan.json에 있다.

## 기존 결과의 범위

과거 후보 c6a8019의 표적 회귀는 8 PASS/65 SKIPPED(exit0), 격리 mock은 12 PASS/1 FAIL(exit1)이었다. 10개 기본 variant 계약은 통과했지만 유효 비용+invalid RESP에서 비용·token 유실이 발생했다. 기대값은 INVALID 응답, input321/output42/cost0.125 보존 및 spent0.125이다. 관측 null 사용량/spent0/pending0.4를 정답으로 채택하지 않는다. 실제 의미 품질과 AGENT selected/read/applied/verified는 모두 NOTRUN이며 원래 hostReceipt=null이다. 기존 성공한 mock을 실제 Claude 호스트 성공으로 바꾸지 않는다.

## 로컬 준비

지정 Claude CLI `/workspace/cloud-tools/claude/node_modules/.bin/claude`에서 `2.1.286 (Claude Code)`을 재확인했다. `--version`, `--help`만 로컬 실행했다. Node v24.19.0, pnpm11.19.0. CLI 존재는 API 인증·플러그인 설치·provider qualification·호스트 도구 작동 검증을 대신하지 않는다. 현재 작업 checkout의 AGENTS.md와 관련 SKILL.md, 과거 AGENTS.md를 읽었고 workspace/repository `.agents/skills`는 부재했다. 지침 해시는 input-evidence.json에 있다. evaluation-validity 지침은 준비에 참고했으며 독립 감사 PASS를 만들지 않았다.

제품 코드·생성 배포물은 수정하지 않았고 제품 시험도 실행하지 않았다. 공개 원본을 격리 폴더에 읽기용으로 추출하고 시험 절차·근거 해시·비용 ledger만 작성했다. 영구 인증 설정, 권한, 네트워크 정책을 변경하지 않았다. 비밀값·인증 placeholder·개인정보·원본 채팅은 보고서에 포함하지 않았다.

## 실제 Claude Code가 확인할 절차

1. 부모가 확인한 R17 commit/tree와 독립 SOURCE·원격 고정 파일을 확인하고 해당 후보 AGENTS.md/Claude SKILL.md 및 설치 트리·MCP 상태를 읽는다.
2. 원래 criterion과 synthetic 입력의 provenance를 보존한다. 원래 의미 prompt/oracle이 없으므로 mock label을 의미 정답으로 발명하지 않는다.
3. Claude가 실제 호스트 도구로 격리 candidate의 SS21 mock과 비용 보존·Noul·wire-limit 경계를 실행한다. 원래 공개 시험 파일을 쓰기 전 후보 fixture의 호환성과 digest를 확인하며, 다른 파일을 덮어쓰지 않는다. Sol은 환경·근거만 관리한다.
4. 승인된 profile/runtime/route와 별도 실제 task/source가 갖춰지면 Claude가 실제 분류와 AGENT 선택·읽기·적용·검증 evidence를 남긴다. JEV live 호출은 개별 배정 전 금지한다.
5. 모든 호출의 비용·input/output/cache token·retry·failure를 기록하고 US$2 soft 한도 접근 또는 알 수 없는 소비 시 다음 호출을 멈춘다. mock telemetry와 실제 사용량을 분리한다.
6. 수정 없는 고정 후보의 기준별 실제 결과를 판정하고 정제 근거만 고유 run 경로에 게시한 후 고정 원격 파일을 재독해 해시를 확인한다.

## 막힘과 재개 조건

R17 `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`는 부모가 전달한 로컬 고정 보고만 있다. 독립 SOURCE 판정과 원격 게시 확인이 필요하다. 이전 main이나 c6a8019는 최종 후보 시험에 사용하지 않는다. 부모의 검증 후보, 공통 정확한 Claude model/effort·성공한 API 인증 절차·호출 제한·선행 검사 결과가 오기 전 invocation은 만들거나 실행하지 않는다. 이후 실제 provider/host profile·MCP·선택 receipt·원래 의미 입력 provenance의 남은 공백을 명시적으로 확인한다. 부모가 이 조건을 전달하면 같은 SS21 기준으로 재개한다.

게시 대상: 기존 evidence 브랜치의 `evidence/ags-2.9.1/2026-10-09/claude-cases/SS21/prep-20261009T074419Z-24c93ecf4a08/`. 이는 준비 보고서이며 실제 시험 결과 게시가 아니다.
