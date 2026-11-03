# AGS 국제화(i18n) 설계

## 1. 목표와 범위

사용자 원문:

- 「그리고 AGS 혹시 영문도 지원해? 확인해줄래? 없으면 기능 추가해주고 릴리즈 발행해줘.」
- 「i18n 국제화 규격으로 설계해줘.」
- 「내가 나중에 mcp에다가 관리자 페이지 붙일거거든? 그것도 고려해줄래?」
- 「관리자페이지 뿐만 아니라 AGS에서 뿌려주는 모든 메시지에 i18n이 적용되어야돼.」

3.2.1 기준 현황: AGS에는 언어 설정이 없다(`mcp-server/src`, `runtime`, `scripts`, `hooks`, `claude-overlay`, `antigravity-connector`에서 locale 처리 0건, `localeCompare`만 있음). 서버 오류와 도구 설명은 영어, 스킬·접수 안내·hook 문장은 한국어로 섞여 있다.

### 1.1 대상: AGS가 내보내는 모든 문장

| 표면 | 지금 위치 | 지금 언어 | 받는 쪽 |
|---|---|---|---|
| MCP `instructions` | `server.ts` `SKILL_INTAKE_SERVER_INSTRUCTIONS`(앞뒤 문장 + `skills/orchestrator/SKILL.md` 접수 블록), `SESSION_MESSAGE_SERVER_INSTRUCTIONS` | 한국어 | 에이전트 |
| 도구 설명·입력 필드 설명 | `server.ts` `description` 35곳, `contracts/*.schema.json`의 `description` | 영어(1곳 한국어) | 에이전트 |
| 도구 결과·오류 문장 | `throw new` / `failure(` 약 463곳 | 영어 + code | 에이전트, 사용자 |
| 저장 후 다시 보이는 문장 | `workflow-service.ts` `LATE_ADOPTION_LABEL` 등 | 한국어 | 에이전트, 관리자 페이지 |
| hook 문장 | `continuity-service.ts`(편집 관문, 단계 확인, checkpoint 안내), `continuity-hook.ts`, `session-message-hook.ts`, `peer-wait-policy.ts`, `claude-overlay/hooks/skill-trigger-hook.mjs` | 한국어·영어 혼재 | 사용자 화면, 에이전트 |
| 호스트가 직접 읽는 정적 문장 | `hooks.json` `statusMessage`, `.codex-plugin`·`.gemini-plugin`·`plugin.json`의 설명·`suggestedPrompts`, `.claude-plugin/marketplace.json` | 영어·한국어 혼재 | 호스트 UI |
| 스킬 | `skills/*/SKILL.md`(frontmatter `description` 포함), `references/`, `agents/openai.yaml` | 한국어(ponytail만 영어) | 에이전트 |
| 스킬 스크립트 출력 | recovery-strategy-selector, codex-token-usage-analyzer, mutation-risk-preflight, evaluation-validity-auditor, independent-audit-gate, workspace-convention-profiler | 한국어 | 에이전트, 사용자 |
| CLI 출력 | `runtime/engineering-practices/cli.mjs`, session-message CLI, `check-for-updates` | 영어 | 사용자, 에이전트 |
| 관리자 페이지(예정) | 없음 | — | 사용자 |

### 1.2 번역하지 않는 것

- 사람이나 에이전트가 쓴 내용: 세션 메시지 본문, `goal`, `acceptanceCriteria`, 결과 요약, 사용자 원문. AGS는 이것을 그대로 저장하고 그대로 보여 준다.
- 기계 식별자: 오류 `code`, capability, 스킬 이름, 도구 이름, schema 필드 이름, 상태 값. 모든 locale에서 같다.
- `korean-prose-editor`의 기능 대상 언어. 설명·안내 문장은 번역하지만 편집 대상은 한국어 그대로다.
- 저장소 문서 `docs/`. 실행 중에 내보내는 문장이 아니다. 영어 사용자 입구는 지금처럼 `README.en.md`가 맡는다.
- stderr 진단. 지금 code와 JSON만 낸다. 문장을 새로 넣게 되면 카탈로그를 거친다.

## 2. 따르는 규격

| 영역 | 규격 | AGS에서 쓰는 방식 |
|---|---|---|
| 언어 태그 | BCP 47(RFC 5646) | 모든 locale 값. `Intl.getCanonicalLocales`로 정규화한다. |
| locale 고르기 | RFC 4647 Lookup | 요청 목록을 앞에서부터, 각 태그는 뒤 subtag를 하나씩 잘라 가며 지원 목록과 맞춘다(`en-US` → `en`). |
| 메시지 문법 | ICU MessageFormat | 자리표시 `{name}`, `{n, plural, …}`, `{x, select, …}`만 쓴다. 복수 규칙은 CLDR(`Intl.PluralRules`)을 따른다. |
| 지역 데이터 | Unicode CLDR | Node 24 공식 빌드의 full ICU(`Intl`)로 날짜·숫자·복수를 처리한다. |
| HTTP 협상(관리자 페이지) | RFC 9110 `Accept-Language`, `Content-Language` | 요청마다 협상하고 응답에 `Content-Language`를 붙인다. |

메시지 실행기는 FormatJS `intl-messageformat`(BSD-3-Clause)을 쓴다. ICU MessageFormat을 그대로 해석하고, 관리자 페이지 화면도 같은 문법(FormatJS 계열)으로 같은 카탈로그를 렌더링할 수 있다. Unicode MessageFormat 2.0과 TC39 `Intl.MessageFormat`이 Node에 들어오면 실행기만 바꾼다. 카탈로그 문법을 위 세 형식으로 제한하는 것도 그때 옮기기 쉽게 하려는 것이다.

## 3. 원칙

1. **기계 계약은 언어와 무관하다.** 문장을 내보내는 모든 응답은 `code`, `messageKey`, `params`를 함께 낸다. `message`는 표시용이다. 에이전트 지침·시험·관리자 페이지는 `code`로 판단하고 문장을 비교하지 않는다.
2. **저장은 key와 params로, 렌더링은 내보낼 때 한다.** DB에 렌더링된 문장을 저장하지 않는다. 그래야 관리자 페이지가 보는 사람의 언어로 다시 그릴 수 있다. 이미 저장된 한국어 문장(`LATE_ADOPTION_LABEL` 등)은 읽을 때 알려진 문장을 key로 대응시킨다.
3. **카탈로그는 한 벌이다.** MCP 서버, hook, CLI, 스킬 스크립트, 패키지 빌드, 관리자 페이지가 같은 `locales/`와 같은 `runtime/i18n` 모듈을 쓴다. 표면마다 사본을 두지 않는다.
4. **출시 locale은 빠진 키가 없어야 한다.** CI가 출시 locale(처음에는 `ko`, `en`)의 키 완비를 강제한다. 실행 중 fallback은 안전망일 뿐 번역 누락을 덮는 수단이 아니다.
5. **번역은 원문 판(版)에 묶인다.** 번역 항목마다 원문 digest를 기록한다. 원문이 바뀌었는데 번역이 그대로면 CI가 실패한다.

## 4. locale 결정

### 4.1 프로세스 단위(MCP 서버, hook, CLI, 스킬 스크립트)

모든 프로세스가 `runtime/i18n`의 같은 함수로 다음 순서에 따라 정한다.

1. 환경 변수 `AGENT_GOVERNANCE_LOCALE`: BCP 47 태그 목록(쉼표 구분, 예 `en-US,ko`).
2. AGS 사용자 설정: `<AGENT_GOVERNANCE_SHARED_STATE_DIR>/settings.json`의 `locale`. 관리자 페이지가 바꾸는 값이 이것이다.
3. 설치 패키지의 기본 locale: 패키지 빌드가 적는 `release/locale.json`의 `locale`. 그 패키지의 스킬·manifest 언어와 같다.
4. 근(root) locale `en`.

1~3의 각 값은 RFC 4647 Lookup으로 지원 locale과 맞춘다. 맞는 것이 없으면 다음 단계로 간다. 잘못된 태그는 그 단계만 건너뛰고, 건너뛴 사실을 `code`(`LOCALE_INVALID`)로 진단에 남긴다.

- hook은 호출마다 새 프로세스라 설정 변경이 바로 반영된다.
- MCP 서버는 `instructions`와 도구 목록을 initialize 때 보내므로 시작할 때 한 번 정한다. 바꾸려면 AGS 프로세스를 다시 시작한다. 관리자 페이지는 이 사실을 화면에 표시한다.
- 키 단위 fallback: 정한 locale → 그 언어의 상위 태그 → `en`. 출시 locale은 4번 원칙 때문에 이 경로를 타지 않는다.

### 4.2 정적 문장과 실행 중 문장

호스트는 플러그인 폴더의 `skills/`, `hooks.json`, manifest를 그대로 읽는다. 세 호스트(Claude Code, Codex, Antigravity) 모두 이 파일들에 locale별 변형을 고르는 기능이 없다. 그래서 정적 문장의 언어는 설치한 패키지가 정하고, 1·2번 설정은 실행 중 렌더링하는 문장에만 적용된다. 서버 `instructions`의 접수 블록은 설치된 `skills/orchestrator/SKILL.md`에서 읽으므로 정적 문장에 속한다(스킬과 같은 원본이라는 지금 원칙을 유지한다).

설정과 패키지 언어가 다르면 두 언어가 섞인다. 관리자 페이지와 `check_for_updates` 결과에 "패키지 언어"와 "표시 언어"를 따로 보여 준다.

### 4.3 요청 단위

- MCP: 요청마다 locale을 실어 보내는 표준 필드는 확인하지 못했다(미확인, 구현 때 MCP 규격에서 확인). 확인되기 전까지는 도구 입력에 locale 인자를 추가하지 않는다. 도구 결과는 프로세스 locale을 따른다.
- 관리자 페이지 HTTP: 사용자가 고른 값 → `Accept-Language` → 프로세스 locale → `en`. 응답에 `Content-Language`를 붙인다.

## 5. 카탈로그

### 5.1 파일

```text
locales/
  catalog.json            # 출시 locale, 각 domain의 원문 locale
  en/server.json          # domain별 파일, 값은 ICU MessageFormat 문자열
  en/hooks.json
  en/cli.json
  en/manifest.json
  en/skill-scripts.json
  en/admin.json           # 관리자 페이지가 생길 때 추가
  ko/...                  # 같은 구성
  ko/translations.lock.json   # 번역 키 → 원문 문자열 sha256
  en/translations.lock.json
```

- domain을 나누는 이유는 관리자 페이지가 필요한 domain만 불러오고, 번역 검토를 표면별로 나눌 수 있게 하려는 것이다.
- 원문 locale은 domain별로 `catalog.json`에 적는다. 지금 영어로 쓰인 서버 오류·도구 설명은 원문이 `en`이고, 한국어로 쓰고 다듬은 hook 문장·접수 안내는 원문이 `ko`다. 원문을 억지로 한 언어로 맞추지 않는다. 지금 문장의 뜻과 다듬은 결과를 보존하기 위해서다.

### 5.2 키

- 형식: `<domain>.<영역>.<이름>`. 예: `hooks.editGate.denied`, `server.tool.startWorkflow.description`, `server.error.INVALID_INPUT.startWorkflowRequiredArtifacts`.
- 오류 키는 `code`와 별개다. 한 `code`를 여러 문장이 쓰기 때문이다(예: `INVALID_INPUT`).
- 입력 schema 설명은 파일을 고치지 않고 내보낼 때 바꾼다. 키는 `server.schema.<$id>#<JSON Pointer>`다. 원문은 schema 파일의 영어 `description`이다. 그래서 `CONTENT_LOCK.json`이 잠근 engineering 계약 schema를 건드리지 않는다.

### 5.3 형식 안전

- `scripts/build-i18n.mjs`가 원문 locale 카탈로그를 ICU 파서로 읽어 `mcp-server/src/i18n/keys.generated.ts`(키 union과 키별 params 형)를 만든다. `t(key, params)`에 없는 키나 틀린 params를 넘기면 `tsc`가 실패한다.
- 문장을 내보내는 함수(오류 생성자, hook 응답, 도구 설명 등록)는 문자열이 아니라 `MessageRef { key, params }`만 받는다.
- CI 검사(프로세스를 띄우지 않음):
  - 출시 locale마다 키 집합이 원문 domain과 같다(빠진 키, 남는 키 0).
  - 모든 값이 ICU로 파싱되고, 자리표시 이름 집합이 원문과 같다.
  - `translations.lock.json`의 원문 digest가 지금 원문과 같다(번역 stale 0).
  - 태그가 정규형이다.
  - `mcp-server/src`, `claude-overlay/hooks`, `antigravity-connector/hooks`에서 주석 밖 한글 문자열 리터럴이 0이다. 영어 문장 리터럴은 위 형 제약으로 막는다.

## 6. 표면별 적용

| 표면 | 렌더링 시점 | 방식 |
|---|---|---|
| MCP `instructions` | 서버 시작 | 앞뒤 문장과 세션 메시지 안내는 `server` 카탈로그. 접수 블록은 설치된 `skills/orchestrator/SKILL.md`(4.2). |
| 도구 설명·입력 필드 설명 | 서버 시작(`tools/list`) | `server.tool.*`, `server.schema.*` 키로 바꿔 내보낸다. |
| 도구 결과·오류 | 호출마다 | `WorkflowContractError(code, MessageRef, details)`. 결과에 `code`, `messageKey`, `params`, `message`, `locale`을 넣는다. 지금 오류 응답의 기존 필드는 그대로 둔다. |
| 저장 후 다시 보이는 문장 | 읽을 때 | 저장은 key·params. 기존 행의 알려진 한국어 문장은 읽을 때 key로 대응. |
| hook 문장 | hook 호출마다 | `continuity-service.ts`가 문자열 대신 `MessageRef`를 돌려주고 hook 진입점이 렌더링한다. 지금도 모든 한국어가 이 한 경로로 나가므로 이전이 단순하다. `skill-trigger-hook.mjs`도 같은 모듈을 쓴다. |
| 정적 문장(`statusMessage`, manifest) | 패키지 빌드 | `manifest` 카탈로그로 locale별 패키지를 렌더링한다. |
| 스킬 | 패키지 빌드 | 7장. |
| 스킬 스크립트·CLI | 실행마다 | `runtime/i18n` 번들(의존성 포함, `scripts/runtime-bundles.mjs`로 생성)을 import한다. 스킬 폴더에 `node_modules`가 없어도 돈다. |
| 세션 메시지 | 전달마다 | 봉투 문장(BEGIN/END 경고, ACK 안내)만 카탈로그. 본문은 그대로. |
| 관리자 페이지 | 요청마다 | 9장. |

## 7. 스킬 번역과 잠금

### 7.1 배치

- `skills/`는 원문 그대로 둔다. 스킬마다 원문 locale을 `skills/registry.json`에 적는다(지금 기준 ponytail은 `en`, 나머지는 `ko`).
- 번역은 `locales/<tag>/skills/<스킬>/<같은 상대 경로>`에 둔다. 대상은 `SKILL.md`(frontmatter `description` 포함), `README.md`, `references/**/*.md`, `agents/openai.yaml`, 프롬프트 양식 같은 문장 파일이다. 스크립트·JSON·SQLite 같은 비문장 파일은 복제하지 않는다.
- locale L 패키지의 각 문장 파일은 `locales/L/skills/…`에 번역이 있으면 그것, 원문 locale이 L이면 원문을 쓴다. 둘 다 아니면 빌드가 실패한다.
- 그래서 `ko` 패키지에는 ponytail 한국어 번역이, `en` 패키지에는 나머지 25개 스킬의 영어 번역이 들어간다.

### 7.2 잠금

| 잠금 | 지금 | 바꾸는 점 |
|---|---|---|
| `skills/source-lock.json` | 스킬 폴더별 `integratedChecksum` | locale별 `translations.<tag>.integratedChecksum`과 번역 기준 `sourceChecksum`을 더한다. 원문이 바뀌면 `sourceChecksum`이 어긋나 CI가 실패한다. ponytail의 upstream checksum은 원문에만 적용한다. |
| `scripts/check-skill-context-optimization.mjs` | 파일별 sha256 고정, navigation 표식·분량 검사 | locale별 고정 표를 둔다. 구조 검사(표식, 참조 조건, 분량)는 모든 locale 결과물에 똑같이 돌린다. |
| `runtime/engineering-practices/CONTENT_LOCK.json` | 49개 파일 digest | 번역 파일을 같은 방식으로 추가한다. |
| `build-claude-plugin.mjs` `COMMON_POLICY_INVARIANTS` | 한국어 문장 대조 | locale별 불변 문장 집합. |
| `claude-overlay/adaptations/*.json`, `antigravity-connector/adaptations/*.json` | 한국어 `find`/`replace` | locale별 adaptation. 번역 파일에 적용한다. |

### 7.3 의미 검토

스킬과 도구 설명은 에이전트 행동을 바꾸는 프롬프트다. 번역마다 원문과의 의미 대응을 독립 검토자가 확인하고, 검토 결과를 번역 커밋에 남긴다. 해시와 구조 검사는 의미 보존을 증명하지 못한다. 실호스트에서 en 패키지로 대표 흐름(편집 관문, workflow 시작·기록, 단계 확인)을 돌려 행동이 같은지 본다.

## 8. 패키지와 배포

- 플러그인 식별자는 모든 locale에서 `agent-governance-suite`로 같다. 스킬 이름(`agent-governance-suite:ponytail`), MCP 서버 이름, 상태 DB가 locale과 무관하게 유지되고, 언어를 바꾸려면 다른 locale 패키지로 다시 설치하면 된다. 저장 데이터가 언어와 무관하므로(3장 2번) 상태는 그대로 쓴다.
- 기존 설치 경로(`claude-plugin/`, 저장소 루트의 Codex 플러그인, agy zip)는 `ko` 패키지로 유지해 지금 사용자의 동작을 바꾸지 않는다.
- `en` 배포:
  - agy: release asset `agent-governance-suite-antigravity-<tag>-en.zip`을 같은 workflow가 만든다. 기존 zip 이름은 `ko`로 유지한다.
  - Claude Code, Codex: 같은 식별자를 다른 원본에서 배포하는 방법(별도 marketplace 파일, 생성 branch, 하위 경로 지정 등)이 각 호스트에서 되는지 확인하지 못했다(미확인). 구현 첫 단계에서 실제 호스트로 확인하고, 되지 않으면 그 사실과 대안을 보고한 뒤 정한다.
- 패키지 빌드는 `release/locale.json`을 적는다(4.1의 3번).
- README: `README.en.md`의 설치 안내를 `en` 패키지로 바꾼다.

## 9. 관리자 페이지와의 연계

- 같은 `runtime/i18n` 모듈과 `locales/`를 쓴다. 화면 문장은 `admin` domain에 둔다.
- API의 모든 메시지 객체는 `{ code, messageKey, params, message, locale }`이다. 화면은 `message`를 그대로 쓰거나 자기 locale로 `messageKey`·`params`를 다시 렌더링한다.
- 저장 데이터는 key·params와 UTC ISO 8601 시각만 갖는다. 날짜·숫자 표시는 협상한 locale로 `Intl`이 한다.
- 표시 언어 설정 화면은 `settings.json`의 `locale`을 바꾼다. hook에는 바로, MCP 서버에는 재시작 뒤 적용된다는 것을 같이 보여 준다.
- 처음 출시 locale에 오른쪽→왼쪽 언어는 없다. 화면은 CSS 논리 속성(`margin-inline-start` 등)으로 만들어 나중에 추가할 수 있게 한다.

## 10. 시험

- 카탈로그 검사(5.3)와 형 검사는 CI에서 돈다.
- 지금 한국어 문장을 그대로 비교하는 시험(약 153개 파일)은 `code`·`messageKey` 비교로 바꾼다. 표면마다 대표 문장 하나씩만 locale별로 렌더링 결과를 확인한다.
- locale 결정 시험: 환경 변수, 설정 파일, 패키지 기본값, 근 locale 순서와 잘못된 태그 건너뛰기, RFC 4647 잘라내기.
- 패키지 검사: locale마다 `build-claude-plugin.mjs --check`, agy 묶음 검사, 스킬 잠금 검사.
- 실호스트: Linux 시험 서버에서 `en` 패키지로 Claude Code, Codex, agy를 설치해 `instructions`, 편집 관문 거부, 단계 확인 문장이 영어로 나오는지 본다. `ko` 패키지는 지금과 같은 문장이 나오는지 본다.

## 11. 단계

1. 기반: `runtime/i18n`(locale 결정, 실행기, 카탈로그 적재), `locales/catalog.json`, 키 형 생성, CI 검사. Claude Code·Codex의 locale별 배포 방법 확인.
2. 실행 중 문장 이전: hook, `instructions` 앞뒤 문장, 세션 메시지 안내, 도구 설명·schema 설명, 오류 약 463곳, 저장 문장, CLI, 스킬 스크립트. `ko`, `en` 모두.
3. 스킬 번역: 25개 스킬 `en`, ponytail `ko`, locale별 잠금, 의미 검토.
4. 패키지: locale별 빌드, release workflow, README.
5. 시험·실호스트 확인·발행.

각 단계는 AGS workflow로 기록한다.

## 12. 남은 확인

- MCP 규격의 요청 단위 locale 필드 유무(4.3).
- Claude Code·Codex에서 같은 플러그인 식별자를 locale별 원본으로 배포하는 방법(8장).
- `intl-messageformat` 도입 공급망 기록(`docs/supply-chain.md` 절차).
- 번역 분량: 스킬 문장 파일 135개(한글 포함 줄 약 3,200), 도구 설명 35곳, 오류 문장 약 463곳, hook 문장 약 12종, 스킬 스크립트 약 300줄.
