# AGS3-D-0028 구형 MCP 키 전환 시험 계획

입력 핀은 구형 `6c247e606646d7853d0403fd952a7cd327721991`(3.0.0-rc.1,
`agent-governance-suite`)과 후보 `d826183e47891dc977416ef8182b3656d86e3fb0`
(`ags`)다. 두 플러그인의 manifest.name은 `agent-governance-suite`다.
구형 source의 `get_skill_inventory` 입력은 `{}`이고 현재도 같은 도구가 있다.

TEST Linux revision은 `7bf339f7487d6039723cdbad41a91e170722e5d9298057ac9a979058c1a5ab89`다.
실행 전 slot을 root와 조율하고 `테스트 서버 시험 방법.md` 6.4/6.6을 따른다.
AGY 모델 실행은 한 번에 하나, 실행마다 새 프로젝트, 내부 120초·외부 150초 상한이다.
`--continue`를 쓰지 않는다. PC·운영·다른 플러그인·기존 세션·인증은 대상이 아니다.

## 상태와 원복 전제

공식 `agy plugin list --json`에서 시험 대상 설치가 없고 최초 구/신 키 캐시가
없음을 기록한다. 존재하면 내용을 열거나 덮어쓰지 않고 충돌을 보고한다.
구형 서버는 시작할 때 저장소를 여므로 아래 지원된 공개 환경변수 6개를
old/new 각각 서로 다른 자기 TEST 절대경로에 지정한다. HOME과 인증 환경은 보존한다.

`AGENT_GOVERNANCE_DB_PATH`, `AGENT_GOVERNANCE_CONTINUITY_DB_PATH`,
`AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH`, `AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR`,
`AGENT_GOVERNANCE_SHARED_STATE_DIR`, `AGENT_GOVERNANCE_TRUST_DB_PATH`.

원복은 공식 `agy plugin uninstall agent-governance-suite`와 자기 실행 PGID 종료 확인이다.
캐시는 이번 시험에서 최초 생성한 정확 경로만 대상으로 하며 원자료를 보존한다.
기존 DB·권한·인증·다른 캐시 snapshot 또는 복원은 하지 않는다.

## 실행 전 사례와 독립 판정

| 사례 | 전제·입력·절차 | 예상 결과·실패 기준 | 실제 |
| --- | --- | --- | --- |
| MG01 원경로 | 구형 패키지를 공식 validate/install하고 새 프로젝트에서 구 서버의 `get_skill_inventory {}`를 호출한다. | 설치가 실제 old key를 선언하고 native discovery/자기 tool schema 또는 호출이 old 경로를 증명한다. 단순 파일 생성은 native 재현이 아니다. 미노출·호출 실패는 원오류 보존. | NOT_RUN |
| MG02 같은 이름 갱신 | MG01 뒤 후보를 `agy plugin install <후보>`로 덮어 설치한다. 새 프로젝트에서 공개 discovery와 `get_skill_inventory {}`를 확인한다. | 등록 old key 0·ags 1, 후보가 광고하는 도구 집합과 native 노출 도구가 일치, 실제 호출 DONE 및 비오류 응답. 옛 캐시 잔류·옛 프로세스 잔류·실제 서버 중복을 별도 기록한다. | NOT_RUN |
| MG03 공식 재등록 | 원경로가 실패한 경우 official uninstall→validate/install로 대조한다. | 같은 키·도구·실호출 oracle을 만족해야 한다. 새 설치 PASS만으로 MG02를 PASS로 바꾸지 않는다. 실행 중 옛 앱의 hot reload는 새 세션 성공과 구분한다. | NOT_RUN |
| MG04 실패·복구 | 정상 설치의 공개 파일 hash/등록을 기록하고 잘못된 후보를 공식 validate/install에 전달한다. 정상 후보로 복구한다. | 잘못된 후보가 성공하지 않고, 기존 상태 보존 여부·원오류를 기록한다. 복구 뒤 ags 1·old 0·정상 도구 호출. 복구용 무제한 retry나 프로세스 전체 kill은 없다. | NOT_RUN |
| MG05 종료 | 각 모델·소유 자손 terminal 확인, 자기 설치만 공식 제거하고 전후 목록 비교. | 최초 plugin 목록과 같고 자기 프로세스 0. 캐시 정리 지원 여부와 최종 자기 cache 자료 위치를 분리한다. 원인 불명 종료는 cleanup PASS가 아니다. | NOT_RUN |

MG01/02는 설치 패키지·native 호스트 통합 수준이다. mock 목록·manifest identity·fresh
설치 성공이 캐시와 프로세스 정리 또는 App 화면에서 서버 하나를 증명하지 않는다.
실제 중복이 재현되면 같은 oracle로 수리 전후를 대조한다. 재현되지 않거나 공급자
소유 경계를 수리할 공식 API가 없으면 그 범위는 미확인/미해결로 보존한다.

## 공식 관리 계약 확인

- AGY 1.5.2 상위 help: plugin install/uninstall/list/enable/disable/validate는 있고
  별도 update 명령은 없다. `plugin install --help`는 사용하지 않는다.
- [플러그인 공식 문서](https://antigravity.google/docs/plugins)는 같은 플러그인 관리,
  설치 위치와 uninstall의 registry 정리를 설명한다.
- [MCP 공식 문서](https://antigravity.google/docs/mcp)는 App의 Restart/Disable/Delete와
  CLI `/mcp`의 reload를 설명한다. CLI 새 세션과 이미 실행 중인 App의 갱신은 별도다.
- [빌드 공식 문서](https://antigravity.google/docs/build-plugins)의 표준 manifest와
  MCP namespace를 따른다. cache purge나 임의 process kill 계약은 확인하지 못했다.

읽기 전용 help operation `768bdbefb33913c70a425ee9e21eb25de966fc2cb52e2201`,
초기 plugin[]·정확 캐시4경로 부재 operation
`b094f5ca3976e24fccce1ab8464c8c5b0b2378b967d41f0f`는 각각 exit 0이다.
이 조회는 설치·모델·migration 실행이 아니다.
