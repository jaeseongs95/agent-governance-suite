# TASK V06-b3 handoff — Linux 보호 Node interpreter 후보 closure 생산

- TASK_ID: V06-b3 (AGS 3.x)
- 결과: **NEEDS_SPLIT**
- 영역/브랜치: `scripts/qualification/`, `tests/coordinate-subagents/v3x/`, `docs/implementation-3x/evidence/v06-b3/` — 브랜치 `claude/v3x-v06-b3-linux-closure`
- start SHA: `da753126be83e1e17c68700d5dcb4c4658a3943c` (tree `73636510ce3c4c5350a0b217935001b8ebed3a50`) — `git fetch origin codex/v3x-v06-b3-linux-closure` 후 FETCH_HEAD로 확인, 지시된 값과 일치.
- final SHA/commit SHA: 이 문서를 포함한 커밋 SHA (아래 "8. 마무리" 보고 참조)
- push 여부: `git push origin claude/v3x-v06-b3-linux-closure` 수행 (아래 readback 참조)
- CI: NOT_RUN (PR 생성·CI 실행 금지 지시에 따름)

## 1. 시간 기록

- 시작(UTC): 2026-09-24T11:09:33Z
- NEEDS_SPLIT 판단(UTC): 2026-09-24T11:12Z경, 계약 원문·checkpoint 검토 직후
- 계획 예산 25분 / hard stop 30분 규칙에 따라, "구현을 멈추고 결과를 기록한 뒤 커밋·push" 절차를 그대로 수행함. 미완성 구현을 COMPLETED로 보고하지 않음.

## 2. 수행한 작업

1. `git fetch origin codex/v3x-v06-b3-linux-closure` → FETCH_HEAD `da753126be...` / tree `73636510ce...` 확인 (지시값과 일치) → 그 SHA에서 `claude/v3x-v06-b3-linux-closure` 브랜치 생성.
2. 저장소 루트 `AGENTS.md`(=`CLAUDE.md`) 재확인.
3. checkpoint 두 파일의 SHA-256을 재계산해 Task 카드 값과 대조:
   - `scripts/qualification/v06-b3-linux-closure.mjs` → `0e1d4046dd059f861f21cc1b14ae785eff6523b4357d040c779d3b0bf81fdbb5` (일치)
   - `scripts/qualification/v06-b3-linux-inspect.py` → `f9a54a643d15c8329a0403697fede2c0b973e41cc549ed5ac6bb33e3b5b9427f` (일치)
4. `docs/implementation-3x/protected-node-closure-v2.ko.md` (ags-protected-node-closure/v2 rev 2) 원문 전체 정독.
5. checkpoint 두 파일 전체 정독 (Docker Desktop/Windows 기반 producer + Docker 컨테이너 내부 inspector).
6. 환경 사실 재확인: `node --version` → v22.22.2 (PATH `/opt/node22`), `package.json` engines `>=24` 확인. `nodejs.org`, `registry.npmjs.org` HTTPS 200 확인. `git clone --depth 1 https://github.com/nodejs/release-keys.git` 성공 (`gpg-only-active-keys/pubring.kbx`, `trustdb.gpg` 존재 확인) — Task 카드의 환경 사실과 일치.
7. 공통 검증 4종을 변경 전 baseline으로 실행 (아래 5절).
8. **핵심 판단**: checkpoint의 producer(`v06-b3-linux-closure.mjs`)는 (a) `process.platform !== 'win32'`일 때 즉시 실패하도록 만들어진 **Windows 호스트 전용 Docker Desktop producer**이고, (b) 결과 `status`를 계약에 없는 `DOCKER_CANDIDATE_OBSERVED`로 기록하며, (c) 이전 Codex 작업에서 이미 ELF interpreter 거절로 FAIL한 상태다. 계약 원문(`protected-node-closure-v2.ko.md` §5)의 최대 도달 상태는 `CANDIDATE_VERIFIED_LIVE_PENDING`이며, 이번 Task는 네이티브 Linux host(Docker 불요)에서 linux-x64만 생산하라고 명시한다. 즉 checkpoint는 **패치 대상이 아니라 프로덕서 전체를 새로 설계**해야 하는 상태다: 서명된 archive 획득·검증, `/usr/lib/agent-governance-suite/protected-runtime/<releaseSha256>` 보호 root 생성과 조상 실효권한(owner/ACL/mode/symlink/mount/hardlink 교체 불가) 검사, 설치된 `node` bytes와 archive 추출 bytes 완전 일치 검사, entry point 4종 실행과 loader/ELF/so 전이적 closure 측정(정적 분석 아님, 실제 로드 관측), 검증-실행 사이 identity 재대조, 그리고 변조·누락·symlink/mode·search-path 오염 각각에 대한 **실제 거절 재현 테스트**까지 하나의 파이프라인으로 새로 구현해야 한다.
9. 이 전체를 25/30분 예산 안에서 "실제 실행 근거"와 "재현 가능한 거절 테스트"까지 갖춰 독립 감사를 통과할 수준으로 완성하는 것은 불가능하다고 판단. 특히 보호 root 조상권한 검사와 거절 경로 테스트는 정확성이 핵심인 보안 로직이라 축소·추정 구현으로 때우면 계약의 "합성 fixture를 운영 또는 실제 package 증거로 승격하지 않는다" 원칙을 위반할 위험이 크다. 이에 따라 **코드를 추측성으로 고치지 않고 NEEDS_SPLIT으로 정지**했다.
10. checkpoint 두 파일은 그대로 두었다(수정하지 않음) — 위 SHA로 재확인 가능. 잘못된 부분 수정을 시도하다 중단하면 "검증 전 WIP"보다 더 오도적인 상태가 될 수 있어, 변경하지 않는 쪽이 다음 작업자에게 더 정직한 시작점이라 판단했다.

## 3. 변경 파일

- 신규: `docs/implementation-3x/evidence/v06-b3/TASK_V06-b3_handoff.ko.md` (이 문서)
- 그 외 기존 파일은 변경 없음 (`scripts/qualification/v06-b3-linux-closure.mjs`, `scripts/qualification/v06-b3-linux-inspect.py` 등 checkpoint 파일 포함).
- `tests/coordinate-subagents/v3x/V06-b3.test.mjs`는 생성하지 않음 — Task 카드 메타 "test_path는 계획상 위치이며 존재/완료를 뜻하지 않음"에 따라, 구현 없이 빈 테스트 파일을 만드는 것은 오히려 완료를 가장하는 결과이므로 만들지 않았다.

## 4. 실제 검증 결과 (PASS/FAIL/NOT_RUN)

변경 파일이 handoff 문서 1개뿐이라 아래는 baseline(회귀 없음) 확인 목적으로 실행했다.

| 명령 | 결과 | 비고 |
|---|---|---|
| `pnpm exec vitest run tests/coordinate-subagents/v3x/V06-b1.test.mjs tests/coordinate-subagents/v3x/V06-b3.test.mjs` | **PASS(부분)** | V06-b1.test.mjs: 4/4 PASS. V06-b3.test.mjs: 파일 없음 → vitest가 "No test files found"로 종료(코드 1). 이는 예상된 NOT_RUN 상태이며 구현 실패가 아님. |
| `pnpm exec eslint scripts/qualification/v06-b3-linux-closure.mjs` (변경 파일 없어 checkpoint 파일 그대로 대상) | **PASS** | 오류 없음(경고 없음) |
| `node scripts/validate-repository.mjs` | **PASS** | 출력: `repository: valid` |
| `git diff --check` | **PASS** | whitespace 오류 없음 |
| 서명 archive 검증·loader 실행 | **NOT_RUN** | 구현하지 않았으므로 실행 근거 없음. 대신 네트워크 전제조건만 확인: `nodejs.org` HTTPS 200, `registry.npmjs.org` HTTPS 200, `git clone --depth 1 https://github.com/nodejs/release-keys.git` 성공(`gpg-only-active-keys/pubring.kbx`, `trustdb.gpg` 확보). 즉 **환경이 막고 있는 것이 아니라 구현 범위·시간이 문제**임을 확인함. |

## 5. NOT_OBSERVED 항목

- Docker 데몬: 미설치/미확인 (Task 카드 환경 사실과 동일, 이번 세션에서 재확인 시도하지 않음 — 어차피 이번 Task는 네이티브 host 실행으로 전환해야 하므로 Docker 유무는 최종 설계와 무관)
- patchelf: 미설치 (Task 카드 환경 사실과 동일)
- ARM 아키텍처: 미관측 (이번 Task는 linux-x64만 대상이므로 범위 밖)
- 실제 서명 Node v24.x linux-x64 archive 다운로드·gpgv 서명 검증: 미실행 (키링 clone까지만 확인, 실제 archive 다운로드·서명 검증·ELF 로더 실행은 수행하지 않음)
- `/usr/lib/agent-governance-suite/protected-runtime/<releaseSha256>` 보호 root 생성 및 조상권한 검사: 미실행

이 항목들을 성공 증거로 승격하지 않는다. 후보 package 근거(candidate evidence)와 운영 설치 자격(production install eligibility)은 애초에 이번 Task 범위에서도 분리된 개념이며(계약 §5, LIVE_PENDING), 이번 handoff는 candidate 근거 자체도 아직 생산하지 못한 단계임을 명확히 한다.

## 6. 독립 감사

아래 "독립 감사 판정"은 이 문서 커밋·push 직후 fresh 서브에이전트(쓰기 금지)에게 다음을 확인시켜 얻는다:
- 최종 commit SHA/tree, 변경 파일이 이 handoff 문서 1개뿐인지
- checkpoint 두 파일이 변경되지 않았는지(SHA-256 재확인)
- `V06-b3.test.mjs`가 생성되지 않았는지
- 이 문서가 주장하는 baseline 검증 결과(§4)가 실제 명령 재실행으로 재현되는지
- NEEDS_SPLIT 판단 근거(계약서 §5의 `CANDIDATE_VERIFIED_LIVE_PENDING` vs checkpoint의 `DOCKER_CANDIDATE_OBSERVED`/Windows 전용 가드)가 원본 대조로 타당한지

(판정 결과는 이 절에 이어서 기록 — 아래 "독립 감사 판정" 참고.)

**독립 감사 판정**: <감사 완료 후 기입>

## 7. 후보 근거 vs 운영 설치 자격 구분

- 이번 handoff는 **후보 근거를 전혀 생산하지 않았다.** candidate.json이나 그에 준하는 측정 결과가 없다.
- 계약(§5)상 이 Task가 도달 가능한 최댓값은 `CANDIDATE_VERIFIED_LIVE_PENDING`이며, 운영 host 자격(설치·principal·ACL·제품 종단, V03-h)은 이 Task 범위 밖이다. 다음 Task도 이 구분을 유지해야 하며, checkpoint의 `DOCKER_CANDIDATE_OBSERVED`라는 상태명 자체를 그대로 계승하지 않아야 한다(계약에 정의되지 않은 상태값).

## 8. 남은 문제와 다음 Task 최소 정보

다음 Task(V06-b3 재시도 또는 하위 분할)에 필요한 최소 정보:

1. **하위 분할 제안** (단일 Task로 다시 시도한다면 동일 25/30분 예산으로는 부족할 가능성이 높음):
   - (a) 서명 archive 획득·검증 모듈: `nodejs.org/download/release/v<version>/` 정확한 버전 URL에서 `node-v<version>-linux-x64.tar.xz`, `SHASUMS256.txt`, `.sig` 획득 → `release-keys.git`의 `gpg-only-active-keys/` 키링으로 `gpgv` 서명 검증 → archive sha256 대조. (checkpoint의 `verifyRelease`/`signedArchiveDigest` 로직은 로직 자체는 재사용 가능해 보이나 Windows 전제 없이 독립 검증 필요.)
   - (b) 네이티브 Linux 보호 root 설치 모듈: `/usr/lib/agent-governance-suite/protected-runtime/<releaseSha256>`에 `node`+`package` 설치, 조상(`/usr`, `/usr/lib`, `/usr/lib/agent-governance-suite`, installRoot) 실효 쓰기권한·symlink·mount·hardlink 재교체 불가 검사, 설치된 `node` bytes와 archive 추출 bytes 완전 일치 검사.
   - (c) entry point 실행·전이적 closure 측정 모듈: `checkpoint`의 `v06-b3-linux-inspect.py` 측정 로직(ELF interpreter/dynamic/RPATH 파싱, `/proc/<pid>/maps` 기반 loaded file 식별·hash·identity·mount 검사, 4개 entry point 각각 `--no-addons --no-global-search-paths` 실행)을 Docker 없이 네이티브로 재사용. **단, `elf_search_paths`의 `os.path.realpath(interpreter).startswith('/usr/lib/')` 조건이 이전 FAIL(ELF interpreter 거절) 원인일 가능성이 높으므로, 이번 컨테이너의 실제 `/lib64/ld-linux-x86-64.so.2` realpath를 먼저 확인하고 계약(§3 "실제 적용·로드 관측")에 맞게 조건을 재검토해야 한다.**
   - (d) 거절 경로 테스트 스위트: 변조(byte tamper), 누락(missing loaded file), symlink 삽입, mode 변경, `LD_LIBRARY_PATH`/RPATH/RUNPATH 오염 각각에 대해 실제로 거절되는지 재현하는 테스트 — 계약 §"rejectOn" 12개 항목과 대응.
2. **미확인 사실**: 이 컨테이너의 `/lib64/ld-linux-x86-64.so.2` 실제 realpath가 `/usr/lib/`로 시작하는지 여부 — 다음 Task 시작 시 가장 먼저 확인할 것 (`readlink -f /lib64/ld-linux-x86-64.so.2`).
3. **재사용 가능 자산**: checkpoint의 `verifyRelease`/`signedArchiveDigest`/`releaseId`(Windows 가드만 제거·조정) 및 `v06-b3-linux-inspect.py`의 ELF 파서·`measured_mappings`·`package_files` 로직은 설계가 계약 요구사항과 대체로 부합해 보이며, Docker 격리를 네이티브 프로세스 격리(별도 비특권 사용자 + tmpfs 대신 실제 protected root)로 바꾸는 리팩터링이 핵심 작업이다.

## 9. 모델 기록

- 요청 모델: `claude-sonnet-5`
- effort: cloud routine에서 미노출(unobserved)
- 실제 관측 모델(세션 자체 확인, `get_session`): `configured_model=claude-sonnet-5`, `session_context.model=claude-sonnet-5`, `external_metadata.last_served_model=claude-sonnet-5`

## 10. 일회성 실행 예외 기록

사용자의 Claude 이관 지시(이 세션을 통한 실행)는 `TASKS.json`의 `gpt sol/high` 배정보다 우선하는 **일회성 실행 예외**다. 이번 handoff의 NEEDS_SPLIT 판단과 다음 단계 계획은 이 예외 하에서 기록되며, 이후 배정은 저장소의 `TASKS.json` 정책을 따른다.
