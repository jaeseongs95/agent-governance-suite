# AGS3-D-0028: 구형 MCP 키 전환 결과

AGY 1.5.2 Linux CLI에서 실제 구형 패키지를 설치한 뒤 같은 이름의 새 패키지로
갱신하고 정상 호출·재등록 복구를 확인했다. **원래 보고된 App의 두 서버 동시
노출과 옛 서버 프로세스 정리는 아직 판정하지 못했다.** 물리적인 옛 schema
파일 잔류를 현재 서버 중복으로 간주하지 않는다. D28 전체 수용 완료가 아니다.

## 대상과 수행 범위

- 구형: `6c247e606646d7853d0403fd952a7cd327721991`, 3.0.0-rc.1,
  MCP 키 `agent-governance-suite`.
- 후보 제품: `d826183e47891dc977416ef8182b3656d86e3fb0`, MCP 키 `ags`.
  manifest.name은 두 판 모두 `agent-governance-suite`다.
- 원 실행기: `faf8a7b4`, SHA256
  `99cd1d3476f7e154b90c09ec3310ce3e29062e94b3ff4af03fdd68fff3246dd1`.
- 수집기 수리: `fd43e50b650389e3eed0543266b2825503df3509`, SHA256
  `bc89bc87baf9f361d88298065e111a628bf01373335043c82865754a85e19a53`.
  새 수집기로 모델을 다시 실행하지 않았다. 제품 소스·배포 번들 변경은 0개다.
- TEST default revision:
  `7bf339f7487d6039723cdbad41a91e170722e5d9298057ac9a979058c1a5ab89`.
- 작업 디렉터리:
  `/home/mcpops/ags-tests/ags38-01a14016-20261107/d28-migration-bd0680ac-01a14016`.

구형 서버도 시작할 때 DB를 여므로 공개 환경변수 6개로 old/new 상태를 각각
새 절대경로에 격리했다([사전 사례](antigravity-migration-test-plan.md)). 자기 상태
경로에 workflow/continuity/board/trust DB가 생성된 것을 파일명·크기로 확인했다.
에이전트가 공유 기본 DB·기존 grant·인증 파일을 직접 열지 않았다. 정상 AGY의 기존
로그인 내부 사용은 유지했고 HOME은 바꾸지 않았다.

## 실제 갱신·복구

공식 validate/install → 구형 native 1회 → 같은 이름 install → 새 native 1회 →
잘못된 후보 install → 공식 uninstall/install → 복구 native 1회 → uninstall 순서다.
각 native는 새 프로젝트, 내부 120초·외부 150초 상한이며 동시 실행은 1개였다.
추가 모델 재시도는 없다. 아래 응답은 모델의 설명이 아닌 자기 tool output JSON이다.

실제 launcher는 아래 실행을 setsid/nohup으로 시작했고 실행기 안에서 단일 flock을
획득했다. `execution.exit`가 실제 실행기 종료 코드이며 launcher 종료 코드와 별개다.

```sh
PATH=/home/mcpops/.local/bin:/home/mcpops/ags-tests/tester-7452-20261028-r01/runtime/node-v24.22.1-linux-x64/bin:$PATH \
/usr/bin/python3 /home/mcpops/ags-tests/ags38-01a14016-20261107/d28-migration-bd0680ac-01a14016/antigravity-migration-faf8a7b4.py \
  /home/mcpops/ags-tests/ags38-01a14016-20261107/d28-migration-bd0680ac-01a14016
```

| 회차 | 실제 namespace | 자기 conversation / step | native exit | 실제 응답 |
| --- | --- | --- | --- | --- |
| 구형 | `agent-governance-suite_agent-governance-suite` | `55fabf6e-1d80-4d87-81ed-abd7741a9e8d` / 2 | 0 (47.090초) | ok true, 스킬26, UNAVAILABLE/local-tree |
| 갱신 | `agent-governance-suite_ags` | `f8bedede-aa20-41f8-aa83-089996733cf6` / 4 | 0 (62.080초) | ok true, 스킬26, COMPLETE/host |
| 재등록 복구 | `agent-governance-suite_ags` | `ea1f727e-e1b6-4097-946e-67466777a750` / 4 | 0 | ok true, 스킬26, COMPLETE/host |

각 회차는 `get_skill_inventory {}` DONE 1개다. 새 판과 복구 응답의 원 bytes
SHA256은 `61c6b679333d934e523c9fde449cb564c74fe99e945bff0306cf910dc066468c`,
215658 bytes로 같다. 구형은
`9ce33bd204040bddfbfa0bd907d3844ffba0992d2e2734584ea593449d0c1ccc`, 206705 bytes다.

갱신 뒤 저장한 공식 plugin 목록과 설치 descriptor는 해당 플러그인의 `ags`
단일 등록을 나타낸다. 이는 플러그인 범위의 등록 근거이며 App 화면·global MCP
전체 활성 연결 수를 대신하지 않는다. 새 CLI cache의 32개 schema 이름은 후보
server.ts의 공개 도구 이름과 대조했다. 전체 도구를 실제로 각각 호출하지 않았다.

## cache·프로세스 경계

[공식 MCP 문서](https://antigravity.google/docs/mcp)의 lazy loading 계약은
CLI cache를 `~/.gemini/antigravity-cli/mcp/<serverName>/`, App/IDE cache를
`~/.gemini/antigravity/mcp/<serverName>/`로 구분한다. 초기 실행기가 App 경로만
검사한 것은 수집기 오류다. 그 경로 4개 부재를 전체 cache 부재로 해석하지 않는다.

실제 CLI 경로에는 시험 중 수정된 옛 namespace schema31개와 새 namespace
schema32개가 종료 뒤 함께 남았다. 최초 CLI cache baseline을 기록하지 못했으므로
최초 상태나 폴더 전체 소유를 추정하지 않았으며 삭제하지 않았다. 옛 파일 잔류와
옛 서버의 현재 등록·실행·도구 노출은 서로 다른 사실이다. 잔류만으로 제품 FAIL이나
App 두 서버 재현을 주장하지 않는다.

소유 AGY PGID `3065612`/`3066064`/`3066430`은 모두 종료됐다. 실행기의 자손
관측에서는 server.mjs PID를 포착하지 못했다. 따라서 서버 프로세스가 정확히
하나였거나 옛 서버 전부가 종료됐다는 결론은 없다. 임의 process kill·OS 재시작은 0회다.
별도 읽기 전용 process metadata 조회도 `/proc` 접근 권한 오류(exit1)로 중단됐다.
이를 제품 실패로 세거나 권한을 높여 다시 조회하지 않았다.

## 원 실패와 수집기 수리

원 harness exit1은 그대로 보존한다. 두 원인은 AGS 제품 실패와 분리한다.

1. `version:false`인 후보를 install 자체가 거부할 것으로 예상했지만 실제 install은
   exit0로 기존 설치를 교체했다. 이후 공식 strict validate는 exit1로
   `invalid value for string field version: false. The loader skips this plugin`을
   반환했다. 설치 전 validate를 먼저 성공시켜야 한다. 이를 AGS 결함으로 등록하지 않는다.
2. 초기 수집기는 init의 최상위 conversation_id를 놓쳤으며 MCP DONE에 본문이
   없을 때 정확한 step output을 읽지 않았다. stdout 원 bytes를 저장하지 않아 완전한
   stream 재해석도 불가능해졌다. 자기 격리 board의 session_id/cwd 등 식별 metadata로 자기 UUID를
   복구한 뒤 그 UUID의 정확한 output.txt에서 위 응답을 회수했다. 타 UUID 탐색은 없다.

수리한 수집기는 자기 stdout를 먼저 보존하고, 최상위 conversation_id 및 tool의
conversation_id/step_index로 정확한 응답 파일을 결속한다. DONE만으로 성공하지 않는다.
TEST에서 D13 담당자가 제공한 깨끗한 실제 init/DONE 필드와 이번 자기 inventory
artifact double로 모델·설치 없이 검사했다. 원 parser의 필드 손실 RED, 수리 GREEN,
누락 output 거부, malformed JSON 기록을 확인했다. 이는 수집기 검증이며 native 재실행이 아니다.

첫 offline 검사는 fixture에 step_type이 없어 exit1이었다. 그 입력과 판별 자료도
보존했다. 담당자가 같은 실제 D13 step에서 step_type=tool을 확인해 만든 v2로
검증했으며, 원 실패를 통과로 바꾸거나 parser를 느슨하게 만들지 않았다.

## 공식 전환 경로와 남은 검사

현재 확인된 공식 경로만 사용한다. 설치본을 보존하고 해당 사용자·호스트가 소유한
연결을 정상 종료한 뒤 `agy plugin validate <후보>` 성공 후
`agy plugin install <후보>`로 같은 이름을 교체한다. 복구는 보존한 정상 설치본에
대한 공식 uninstall/install이다. 실제 복구 native와 종료 뒤 plugin[] 원복은 확인했다.
[플러그인 관리 문서](https://antigravity.google/docs/plugins)는 이 관리 명령을 제공한다.

원 증상을 판정할 다음 최소 검사는 **같은 App의 공식 MCP 관리 화면에서 구형→후보
전환 전후의 정확 server 이름·연결 상태·도구 수와 소유 프로세스를 관측**하는 것이다.
App의 Restart/Delete 또는 CLI `/mcp` reload는 공식 기능이지만 이번 회차에서
실행하지 않았다. 새 installer·임의 cache 삭제·다른 프로세스 종료는 추가하지 않는다.
PC 설치, App UI 두 서버 재현/해소, hot reload, 해당 프로세스 수용은 미실시다.

## 원 operation과 종료

| 근거 | 전체 operation ID | 실제 결과 |
| --- | --- | --- |
| 최초 launcher | `18854cd2ba968435b71e0a7ee73b02ad1e7e3d095155d2f8` | launcher0; 실제 harness1 별도 |
| 원 회차 결과 | `92a23de5f1e0641778808d2269615e2278781fa74b647c09` | harness1/모델3/등록 원복 |
| 종료·원복 | `995cf9d404f9080232021de0311af58d7dae263cce22c134` | 조회0; PGID3개0/plugin[]/target부재/lockfree |
| 자기 응답 회수 | `f6e43d164aca1c88c204101d9214de5d9e3d40e013fbf8ab` | 0; 실제 JSON3개 회수 |
| 실제 CLI cache | `977756c1d3c4ae27bb833b4f681c523d4a34280c2313d344` | 0; schema31/32 잔류 메타데이터 |
| 공식 등록·schema 이름 대조 | `352abb1aacce48a6787227ec8ddba51c3613ab39ee9ed979` | 0; 플러그인 old0/ags1·31/32 exact names |
| invalid strict validate | `54ff9bc20b624dd4f068d28f63b08e4839563a602e67ee37` | wrapper0/validator1 |
| 첫 offline fixture | `40e402fe0f45715195e03d343375ae7fc445fb85b50f930e` | 1; 필드 누락 입력 보존 |
| offline field v2 | `da3ff769e7ca347dc375d32a402213cf295329239716f2e0` | 0; 모델0/설치0, 수집기4사례 |
| 추가 process metadata | `ecdc95c31f284f83a4fbb5c9c5154486bb9d9a00f3bd426e` | 1; OS permission 오류, 서버 수 미확정 유지 |

추가 source/static 검사는 Python AST 구문과 git diff 검사뿐이며 로컬 제품시험은
0회다. CI는 이 전용 브랜치 push에 자동 실행되지 않았고 수동 CI는 미실시다.
TEST 슬롯은 종료·원복 확인 뒤 D15 담당에게 반환했다. 원 자료는 작업 루트의
`execution/`, `parser-proof-v2/`, `final-cleanup.json`에 보존한다. 인증·DB 본문을
제외한 공개 근거만 별도 회수한다.

공개 근거 묶음(다운로드 operation
`2b6741cad60a00638b991ed96d2582548c004eaad7aba392`)은 132422 bytes,
SHA256 `231256f27db2be43ca186a2f39ad950f9af14c43a4cfe05f9c3bc4fe15d3d96e`다.
로컬 `D:/codex/build/ags-01a14016-v380-agy-migration-evidence/public-evidence/`에서
manifest의 파일 34개를 각각 bytes/hash로 재검증했다. DB·token/key/cert 본문·인증 설정·
원시 대화는 묶음에 없다.

## 3.9.0 처리

- **캐시**: 새 대화의 SessionStart hook(`antigravity-connector/scripts/legacy-server-key-cleanup.mjs`)이
  이 플러그인의 옛 namespace `<plugin.json name>_agent-governance-suite` 폴더를 두 cache root
  (`~/.gemini/antigravity/mcp/`, `~/.gemini/antigravity-cli/mcp/`)에서 찾아, 같은 root의
  `ags-legacy-server-key-backup/<namespace>-<시각>/`으로 옮긴다(같은 디스크 rename, 반대 rename으로 복구).
  폴더 안 항목이 모두 agy가 쓰는 형태(`<도구>.json`의 `name`이 파일 이름과 같음, 일반 파일 `instructions.md`)일
  때만 옮기고, 그 밖의 항목·심볼릭 링크·읽기 실패는 그대로 두고 stderr 보고에 이유를 적는다. 설치 위치가
  `~/.gemini` 아래가 아니거나 현재 `mcp_config.json`이 아직 옛 키를 쓰면 아무것도 하지 않는다.
  같은 이름의 전역 서버(`agent-governance-suite`)·다른 플러그인 폴더는 건드리지 않는다.
- **배치 근거**: TEST Linux CLI cache에서 옛 namespace 폴더는 `<도구>.json` 31개(`name`·`description`·
  `parameters`)와 `instructions.md`를 가졌다(2026-11-07, 읽기 전용 목록 조회). 공식
  [MCP 문서](https://antigravity.google/docs/mcp)도 같은 두 종류를 적는다.
- **프로세스**: hook은 다른 프로세스를 끝내지 않는다. 옛 키 서버는 옛 설정을 읽은 앱이 띄운 것이고, 새 설정에는
  옛 키가 없어 앱을 다시 시작하면 다시 뜨지 않는다. 공식 문서와 이 저장소 시험에서 앱 재시작 뒤에도 옛 키 서버가
  남는다는 근거는 찾지 못했다. README 업데이트 절에 "앱을 다시 시작한다"를 적었다.
- **미확인**: 옛 cache 폴더가 남는 것만으로 App MCP 화면에 서버가 둘로 보이는지는 아직 App에서 재현하지 못했다.
