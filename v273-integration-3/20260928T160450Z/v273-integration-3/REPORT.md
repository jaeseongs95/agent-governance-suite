# AGS 2.7.3 통합 3단계 보고 (버전과 release notes)

지시: 총괄 ca8e3dc4. 2단계 통합(92b1a0d1) 위에 버전 2.7.3 준비 커밋과 release notes 커밋을 올리고, Linux에서 전체 검증했다. tag, release, main push는 하지 않았다.

## 판정: PASS (fast-forward push 완료)

| 대상 | SHA |
| --- | --- |
| 기준 `claude/v273-integration` | 92b1a0d147d280e511eaf5c23cbbf9d00ac790bf (fetch 후 일치) |
| `chore: prepare v2.7.3 release metadata and bundles` | 41958504b1807ec93b7ff0693b25a6a772365467 (tree 3053a762079f0b770f674a345dda87eb407ba571) |
| **`docs: add v2.7.3 release notes` (새 HEAD)** | **b6deb37120e82c75ea0e3ba90a07324adf885969 (tree 93e2b98ec4473591a5df155b474853a263953aba)** |

환경: Linux cloud 컨테이너, Node.js v24.21.0, pnpm 11.19.0.

## 1. 버전 2.7.2 → 2.7.3

`git diff d5c5932c 8763cef2 -- <파일>`로 2.7.1→2.7.2 때 바뀐 줄을 확인하고, 같은 줄만 바꿨다. 결과는 `logs/checks/version-bump.diff`와 `version-bump-dist.diff`에 있다.

| 파일:줄 | 변경 |
| --- | --- |
| `.agents/plugins/marketplace.json:12` | `"ref": "v2.7.3"` |
| `.codex-plugin/plugin.json:4` | `"version": "2.7.3"` |
| `package.json:3` | `"version": "2.7.3"` |
| `release/version.json:2` | `"version": "2.7.3"` (필드는 version 하나뿐이며 날짜·해시 필드 없음. 2.7.2 때와 같은 방식) |
| `mcp-server/src/plugin-info.ts:3` | `version: "2.7.3"` |
| `README.md:17`, `:47` | 현재 공개 릴리스 문장, 설치 `--ref v2.7.3` |
| `README.en.md:17`, `:47` | 같은 두 줄(영어판) |
| `docs/roadmap.md:4` | "현재 공개 릴리스는 `v2.7.3`이다." 문서 기준일(2026년 9월 21일)은 2.7.2 때도 바꾸지 않았으므로 그대로 뒀다 |
| `claude-plugin/.claude-plugin/plugin.json:3` | `pnpm claude:build` 생성 결과 |
| `mcp-server/dist/server.mjs:19736`, `claude-plugin/mcp-server/dist/server.mjs:19736` | `pnpm build`, `pnpm claude:build` 생성 결과. 바뀐 줄은 `PLUGIN_INFO.version` 한 줄뿐이다 |

`claude-overlay/.claude-plugin/plugin.json`(`0.0.0` 자리표시)과 `.claude-plugin/marketplace.json`에는 버전 문자열이 없다. 2.7.2 때도 바뀌지 않았다.

### 남은 `2.7.2` (`logs/checks/git-grep-2.7.2.log`)

| 파일 | 건수 | 성격 |
| --- | --- | --- |
| `docs/release-notes-v2.7.2.md` | 2 | 과거 release notes |
| `docs/release-notes-v2.7.3.md` | 2 | 이전 버전 동작 설명("2.7.2는 …", "2.7.2에서 제외") |
| `docs/session-message-lifecycle.md` | 3 | 이력 문장: 2.7.2의 미해제 동작, 2.7.2의 빈 wake 차단, 이관 실패 때 남는 2.7.2 모양 |
| `tests/session-messaging/message-retention.test.ts` | 2 | v2.7.2 영수증 호환 시험 이름과 주석 |
| `tests/session-messaging/wake-liveness.test.mjs` | 2 | v2.7.2 latch 이관 시험 이름 |

모두 과거 기록이나 이전 버전 호환 시험이다. 현재 버전을 가리키는 곳은 남아 있지 않다. 현재 `2.7.3` 목록은 `git-grep-2.7.3.log`에 있다(`scripts/check-skill-context-optimization.mjs:16`의 intake revision 이름 포함).

## 2. release notes (`docs/release-notes-v2.7.3.md`)

2.7.2와 같은 한국어 산문 형식으로 썼다. 총괄 지시에 따라 `## 동작 변화(호환성)`, `## 알려진 한계` 절을 더했다. 다른 문서에는 release notes 목록이나 링크가 없다(`git grep release-notes`는 notes 파일 자신만 나온다). 따라서 함께 갱신할 문서는 없다. 사본은 `logs/checks/release-notes-v2.7.3.md`에 있다.

근거:

- **wake**:
  - 통합본 `docs/session-message-lifecycle.md`의 퇴역·autoWake·세대 식별·이관 절. wake 후보가 추가했고 wake-audit, wake-fix, wake-reaudit가 확인했다.
  - wake-reaudit REPORT의 F1(퇴역·현재 marker 혼합)과 F2(누적 상한 문구).
  - hook 코드 `mcp-server/src/session-message-hook.ts:206,211`의 `blocksEmptyWakePrompt`.
- **Q**:
  - 같은 문서의 영수증 표와 용량 거절·ACK 문단.
  - msgqueue-audit REPORT 6절의 C1–C3 결과와 msgqueue 구현 REPORT 4절.
- **intake**:
  - intake 구현·fix·reinforce evidence, intake-reaudit REPORT의 R-1, F-4, F-5 판정.
  - g2r2 REPORT: p7 candidate 3/3에서 첫 도구 호출이 orchestrator. p5는 두 arm 모두 0/3. case·arm당 3회.
- Windows와 실제 host 결과 자리에는 `TODO(총괄): Windows 로컬 검증 결과` 한 줄만 남겼다.
- 표현 원칙:
  - 발신자 상한은 공정성 장치이며 인증된 principal이나 할당량 보안 경계가 아니라고 적었다.
  - 외부 스킬 저장소 링크는 없다.
  - 제품 이름은 호스트별 동작을 설명하는 곳에만 썼다(2.7.2 notes와 같은 방식).

### 링크와 anchor (`logs/checks/link-check.log`, intake 감사의 `link-check.mjs`, 범위 92b1a0d1..HEAD)

| 링크 | 결과 |
| --- | --- |
| `session-message-lifecycle.md#미관측-알림-퇴역과-자동-깨우기-신호` | OK |
| `session-message-lifecycle.md` | OK |
| `../skills/orchestrator/SKILL.md#공통-접수선택-기준` | OK |
| `../README.md#설치` | OK |

- 도구는 `broken=6`으로 끝났다. 6건은 모두 `docs/roadmap.md`에 원래 있던 `codex://threads/…` 링크다. 도구가 custom scheme을 상대 경로로 잘못 판정한 것이며, 이번 변경과 무관하다. roadmap에서 바꾼 줄은 버전 문장 하나다.
- EXTERNAL 항목은 저장소 자기 링크와 번들 안의 제3자 코드 주석뿐이다.

## 3. 검증

명령별 stdout, stderr와 종료 코드는 `logs/full/`에 있다.

| # | 명령 | 종료 코드 | 결과 |
| --- | --- | --- | --- |
| 01 | `pnpm install --frozen-lockfile` | 0 | PASS |
| 02 | `pnpm bundle:check` | 0 | PASS |
| 03 | `pnpm claude:drift` | 0 | PASS (`claude-plugin: fresh`) |
| 04 | `pnpm lint` | 0 | PASS |
| 05 | `pnpm build` | 0 | PASS |
| 06 | `pnpm test` | 0 | PASS: 파일 61 통과·1 skip, 테스트 857 통과·2 skip(previous-broker, env 없을 때 skip) |
| 07 | `pnpm runtime:check` | 0 | PASS |
| 08 | `pnpm validate:all` | 0 | PASS |
| 09 | `pnpm validate:official` | 1 | FAIL_UNRELATED(환경): Codex validator `validate_plugin.py` 없음(ENOENT) |
| 10 | `pnpm claude:build` | 0 | PASS |
| 11 | `pnpm claude:check` | 0 | PASS |
| 12 | `git diff --check` | 0 | PASS |
| 13 | `pnpm source:check` | 0 | PASS |
| 14 | `pnpm source:verify` | 1 | NOT_VERIFIABLE: 오류는 삭제된 `ponytail` 원격 저장소 clone 인증 실패 1건뿐이다 |
| 15 | `git status --porcelain` | 0 | 출력 0 byte |

### init-smoke (`logs/checks/init-smoke.log`)

9경우(배치 3 × profile 3) 모두 결과가 같다.

- instructions sha256 `474cdcdb93a26a3bed0c58cc03313b3b47e7c19c654702476cb202efc43a0b75`, 3548 byte
- intake 1회, 도구 28개, 제품명 없음

1·2단계와 같다. 버전 문자열은 `PLUGIN_INFO`(서버 정보)에만 있고 instructions에는 들어가지 않는다.

## NOT_RUN

- `validate:official`의 실제 검사: 컨테이너에 Codex validator가 없다.
- `source:verify`의 `ponytail` 원격 확인: 저장소가 삭제됐다(NOT_VERIFIABLE).
- previous-broker, Q·wake 감사 테스트와 mutant 재실행: 이번 단계의 지시 목록에 없다. 2단계 이후 바뀐 코드는 버전 문자열뿐이다.
- Windows × Node.js 24, 실제 host wake 주입·관측, 설치 캐시와 marketplace 설치: 총괄의 로컬 검증 범위다(release notes의 TODO 줄).
- tag, GitHub Release, main 반영: 금지 범위다.

## 가린 값

토큰 패턴(`ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `AKIA`, PRIVATE KEY 줄, Authorization Bearer), 이메일 주소와 IPv4 주소는 발견되지 않았다. `env`·`printenv` 출력은 남기지 않았다. 다음을 바꾼 뒤 `SHA256SUMS`를 만들었다.

| 대상 | 치환 | 파일 수 | 횟수 |
| --- | --- | --- | --- |
| 사용자 이름이 들어간 컨테이너 홈 경로 | `[REDACTED-HOME]` | 3 | 3 |
| root 계정 홈 경로 | `[REDACTED-HOME]` | 1 | 2 |
| GitHub 계정 이름(URL 소유자) | `[REDACTED-ACCOUNT]` | 4 | 18 |
