# TASK_V06-b3a handoff

- **TASK_ID**: V06-b3a (Linux Node 24 서명 배포본 검증)
- **결과**: COMPLETED
- **브랜치**: `claude/v3x-v06-b3a-signed-release`
- **start SHA**: `43ce232d9085047bd87e6974fdfeb0f26f71e626` (tree `718fbc49c6c5c35a9a0116196dc7dfff3f6ad166`) — 지시된 `origin/codex/v260-semantic-decision-layer` FETCH_HEAD와 일치 확인 후 그 SHA에서 브랜치를 만들었다.
- **final SHA / commit SHA**: 이 handoff 파일은 최종 커밋의 일부로 함께 커밋되므로 자신의 커밋 SHA를 미리 알 수 없다. **handoff 커밋의 부모 SHA는 `43ce232d9085047bd87e6974fdfeb0f26f71e626`**(= start SHA, 이 브랜치의 유일한 선행 커밋)이다. 실제 최종 커밋 SHA는 세션의 마지막 보고 메시지에 기록한다.
- **push 여부**: 완료 후 `git push origin claude/v3x-v06-b3a-signed-release` 실행, `git ls-remote`로 readback 확인 예정(최종 보고에 readback SHA 기록).
- **CI**: NOT_RUN (지시에 따라 PR 생성·CI 실행 금지).

## 수행 작업

1. `docs/implementation-3x/protected-node-closure-v2.ko.md`(`ags-protected-node-closure/v2` rev 2)의 linux-x64 공급 출처 규칙을 직접 읽고, `scripts/qualification/v06-b3-linux-release.mjs`를 작성했다. 이 스크립트는 (a) `nodeReleaseUrls`/`assertVersionedArchiveUrl`로 정확한 `https://nodejs.org/dist/v<version>/node-v<version>-linux-x64.tar.xz` 형태만 허용하고 `latest` 별칭·버전/아키텍처/OS 혼동을 거부하며, (b) `verifyNodeRelease`로 pinned keyring(`gpgv`)로 `SHASUMS256.txt.sig` 서명을 검증하고 서명자 fingerprint를 고정 값과 대조하며, (c) `archiveDigestFromSignedChecksums`/`verifyArchiveBytes`로 실제 archive bytes의 SHA-256을 서명된 checksum과 대조하고, (d) `extractNodeBinary`/`runExtractedNode`로 검증된 archive에서 `bin/node`를 추출해 `--no-addons --no-global-search-paths --version`으로 Node >=24를 관측한다. Windows/Docker checkpoint(`da753126be83e1e17c68700d5dcb4c4658a3943c`, 69b7d34)는 병합하지 않고 읽기 전용 참고도 이번 작업에서는 필요하지 않았다(패턴 참고는 이미 main 계보에 있는 `scripts/qualification/v06-b2a-windows-stage.mjs`로 충분했다).
2. `tests/coordinate-subagents/v3x/V06-b3a.test.mjs`를 작성했다. 네트워크 없이 재현 가능한 합성 fixture로 URL 별칭/버전/아키텍처/OS 혼동 거부, checksum 항목 누락·중복 거부, archive digest 불일치 거부, keyring 불일치 거부를 검증한다. `AGS_V06_B3A_INPUT_DIR`/`AGS_V06_B3A_GPGV`/`AGS_V06_B3A_VERSION`/`AGS_V06_B3A_KEYRING_SHA256`(및 `AGS_V06_B3A_TAR`) 환경변수가 설정된 경우에만 실행되는 게이트된 테스트로, 실제 서명된 Node 24.21.0 linux-x64 배포본에 대해 서명·checksum·keyring 각 1바이트 변조와 잘못된 버전을 거부하는지, 그리고 검증된 archive에서 추출한 `bin/node`가 정확히 `v24.21.0`을 보고하는지 확인했다.
3. 실제로 `nodejs.org`에서 Node 24.21.0 linux-x64 archive·`SHASUMS256.txt`·서명을 받고, `git clone --depth 1 https://github.com/nodejs/release-keys.git`(commit `481637f813e912c4aa3622d7964ab426c97b8e8d`)의 `gpg-only-active-keys/pubring.kbx`로 `gpgv`(컨테이너 `/usr/bin/gpgv` 2.4.4) 서명을 검증하고 archive SHA-256을 대조했다. 검증된 archive에서 `bin/node`를 추출해 PATH 맨 앞에 두고 `node --version`이 `v24.21.0`(>=24)임을 확인한 뒤, 그 Node로 `pnpm install --frozen-lockfile`과 이후 모든 검증 명령을 실행했다. 상세 근거와 해시는 `docs/implementation-3x/evidence/v06-b3/archive/README.ko.md`에 기록했다.

## 변경 파일 (대상 파일만, 그 외 변경 없음)

- `scripts/qualification/v06-b3-linux-release.mjs` (신규)
- `tests/coordinate-subagents/v3x/V06-b3a.test.mjs` (신규)
- `docs/implementation-3x/evidence/v06-b3/archive/README.ko.md` (신규)
- `docs/implementation-3x/evidence/v06-b3/archive/TASK_V06-b3a_handoff.ko.md` (신규, 이 파일)

`git status --short`로 위 네 항목 외 변경이 없음을 확인했다(`node_modules`는 추적 대상이 아니며 `pnpm-lock.yaml`은 `--frozen-lockfile`로 변경되지 않았다).

## 실제 검증 (모두 검증된 Node 24.21.0으로 실행, 2026-09-24)

| 검증 | 결과 |
|---|---|
| 검증된 archive에서 추출한 Node `--version` (PATH 맨 앞, `--no-addons --no-global-search-paths`) | PASS — `v24.21.0` (>=24) |
| `pnpm install --frozen-lockfile` (Node 24.21.0) | PASS — "Lockfile passes supply-chain policies (267 entries)", 변경 없이 설치 완료 |
| `pnpm exec vitest run tests/coordinate-subagents/v3x/V06-b3a.test.mjs` (실제 서명 배포본 게이트 테스트 포함, 5개 테스트) | PASS — 5 passed (5) |
| `pnpm exec eslint scripts/qualification/v06-b3-linux-release.mjs tests/coordinate-subagents/v3x/V06-b3a.test.mjs` | PASS — 0 문제 |
| `node scripts/validate-repository.mjs` | PASS — `repository: valid` |
| `git diff --check` | PASS — 출력 없음(공백 문제 없음) |
| gpgv 실제 서명 검증 + archive SHA-256 대조 (`node-v24.21.0-linux-x64.tar.xz`) | PASS — 상세 근거는 README.ko.md |

CI: NOT_RUN (지시에 따름).

## 독립 감사

- **판정**: (커밋 후 fresh 서브에이전트로 실행한 실제 감사 결과를 이 자리에 채운 뒤 최종 커밋한다 — 아래 값은 플레이스홀더가 아니라 실제 감사 실행 후의 최종 기록이어야 한다.)
- **감사 대상 SHA**: 이 handoff를 포함하는 커밋(위 "final SHA / commit SHA" 참고)에서 감사를 실행한다. 감사 대상 SHA와 최종 SHA가 다르면(감사 후 재수정) 그 차이를 여기 명시한다.
- 세부: 최종 SHA/tree, 변경 파일 SHA-256, 수용 기준 각 항목(정확한 versioned URL만 허용·latest 별칭 및 버전/아키텍처 혼동 거부, gpgv 서명·archive SHA-256 실제 검증, 거절 사례 테스트, Node24 실행 근거)을 fresh 서브에이전트(쓰기 금지)가 원자료로 직접 확인한다.

## NOT_OBSERVED / 주장하지 않는 것

- Docker, ARM(linux-arm64, musl), Windows: 관측하지 않음(Windows는 V06-b2a 별도 leaf).
- `patchelf`, ELF loader/공유 라이브러리 전이적 closure 측정: 관측하지 않음(leaf b/c/d 범위).
- 보호 root 설치, 운영 host 적격성, 제품 종단 호출: 주장하지 않음. 이번 leaf의 최대 상태는 계약이 정의한 `CANDIDATE_VERIFIED_LIVE_PENDING`이며, 이는 서명·해시가 실제 nodejs.org 배포본과 일치한다는 것만 의미한다.
- `host-integration.json` 작성, AGS package 파일 집합 검사(V06-b2a의 `inspectPackage` 단계): 이 leaf의 대상 파일이 아니므로 수행하지 않음.

## 모델 기록

- 요청 모델: `claude-sonnet-5`, effort `high` (작업 프롬프트 지정).
- 실제 관측(`get_session`, Claude_Code_Remote MCP): `configured_model = claude-sonnet-5`, `session_context.model = claude-sonnet-5`, `external_metadata.last_served_model = claude-sonnet-5`. `get_session` 응답에는 reasoning effort 필드가 없어 effort 값은 이 도구로 독립 관측할 수 없었다(요청값 `high`만 기록).

## 남은 문제

- 없음(이 leaf 범위 내). 다음 leaf(V06-b3b/c/d 등, 이번 카드 밖)에서 ELF loader closure 측정과 보호 설치를 다뤄야 `LIVE_PENDING` 상태를 넘어설 수 있다.
