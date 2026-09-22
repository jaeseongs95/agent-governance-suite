# Semantic Decision Layer — S0 기준선

## 출처와 범위

2026-09-22, `codex/v250-model-routing-integration`의 실제 HEAD는
`6e96640066e20358ba523beba505c64a4d330ccc`, tree는
`119ad98fedbf470000f7674336d0c0b03aba7a1f`였다. main은 사용하지 않았다.
이 commit에서 `codex/v260-semantic-decision-layer`를 분기했다.
패키지 버전은 그대로 `2.4.0`이다.

컨테이너의 GitHub DNS 오류와 pnpm 부재 때문에 GitHub 연결 도구로 원격을 읽고,
전용 브랜치에 검증 workflow만 먼저 추가했다. 이 검증용 상태의 commit은
`6e248d48297196453b51f7793b6adf025d9af54f`, tree는
`ce125336912f8e16ddc95933a4a4a563e17bb9ac`이다. 제품 소스 변경 전 상태다.

Actions run `35678507919`가 frozen dependency 설치 후, 빌드 전에 workspace를
보존했다. `.git`, 인증 설정, runner home은 포함하지 않았다. artifact
`10672904674`의 ZIP SHA-256은
`e34b1052ae5fd26dfc16874af722bd304d9e1c0b54579f0a7346e9fee29048b2`다.
이 archive에서 재구성한 로컬 index의 `git write-tree`가 위 원격 tree와 일치했다.
로컬 synthetic commit은 원격 commit으로 주장하지 않는다. 사용자의 PC/worktree를
조회하거나 변경한 것도 아니다. 별도 baseline worktree를 보존했다.

## 이번 세션에서 새로 실행한 원격 검사

Actions run `35678507919`, Node `v22.23.2`, `pnpm@11.19.0`, Ubuntu runner.
기존 인계문서의 테스트 수를 복사한 것이 아니라 이번 실행의 artifact
`10672994887` 로그를 직접 읽었다. artifact ZIP SHA-256:
`f5fa01ad5ff0150692effff7fed6bae5549178a49ffb90d25e14ecd69abf6784`.

| 명령 | 실제 결과 |
|---|---|
| `pnpm install --frozen-lockfile` | 성공 |
| `pnpm bundle:check` (build 전) | 성공 |
| `pnpm claude:drift` | 종료 0; drift 경고와 배포 동기화 완료는 별개 |
| `pnpm lint`, `pnpm build` | 성공 |
| focused Vitest | 14 files / 385 tests 통과 |
| `pnpm test` | 68 files 통과 / 1 제외; 986 tests 통과 / 0 실패 / 1 제외 |
| `pnpm runtime:check`, `pnpm validate:all` | 성공 |
| `pnpm validate:official` | ENOENT: runner에 공식 validator 파일 없음 |
| `pnpm source:check`, 최종 `pnpm bundle:check`, `git diff --check` | 성공 |

focused 범위는 이 브랜치의 workflow에 명시된 v2 라우팅, 서비스, workflow,
hook, capability, peer handoff/preflight/start 및 runtime 테스트다. 과거 인계의
focused 445와 실행 범위가 다르므로 증감으로 해석하지 않는다.
공식 validator 미설치는 제품 회귀로 해석하지도, 검증 통과로 바꾸지도 않는다.

## 로컬 검사와 golden

Node `v22.16.0`, Linux 컨테이너, 내려받은 동일 lockfile 의존성을 사용했다.
`pnpm`이 없어 `node node_modules/vitest/vitest.mjs run`으로 직접 실행했다.
변경 전 `node scripts/check-bundle.mjs`는 성공했다.
전체 결과는 980 통과 / 6 실패 / 1 제외다. 실패 이름·원인은
`evidence/s0-summary.json`에 기록했다. Node의 worker TypeScript 실행 지원,
pnpm script 실행 환경, 재구성 저장소의 과거 Git 이력 부재가 원인에 포함된다.
동일 컨테이너의 변경 전후 결과와 원격 정상 환경의 결과를 섞지 않는다.

`tests/coordinate-subagents/semantic-decision/fixtures/v2-golden.json`은 변경하지
않은 baseline worktree의 기존 `resolveV2`로 생성했다. 21개의 고정 request,
catalog/policy/capability 입력, 예상 전체 payload, canonical 문자열, digest,
기존 네 v2 schema 파일의 SHA-256을 포함한다. 정상/차단, required/preferred,
독립성, 만료, 관측 요구, fallback origin, high-risk floor, 입력 순서를 다룬다.
fixture helper가 덮어쓰는 두 binding 필드는 실제 `supportedBindings[0]`를 수정해
재봉인한 입력으로 보정했다. 첫 capture와 보정 capture는 세션 증거에 보존했다.
골든 생성기는 테스트 중 실행하지 않는다. 이후 변경된 함수끼리 비교하지 않는다.

## 범위 밖

실제 vendor 계정, Jev API, native worker, 설치 캐시, Windows 실측 및 배포는
S0의 검증 결과가 아니다. 이 문서는 S1a 완료나 v2.6 릴리스 완료를 선언하지 않는다.
