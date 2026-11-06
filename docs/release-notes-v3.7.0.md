# AGS 3.7.0 릴리스 노트

3.7.0은 웹·데스크톱·모바일 UI/UX 설계를 맡는 전문 스킬 `ui-ux-design`을 더하고, 한국어·영어 README를 설치·턴별 동작·한계 중심으로 다시 썼다. 사용자 원문은 「이 브랜치 봐보고 문제 없으면 메인에 반영해줘.」(브랜치 `codex/ui-ux-specialist-20261106`), 「UI/UX 설계 스킬 릴리즈해.」다.

호환성:

- 전문 스킬이 23개에서 24개가 됐다. `skills/registry.json`, `skills/source-lock.json`, `scripts/fixtures/registry-contract.3.0.json`에 `ui-ux-design` 0.1.0이 늘었다.
- MCP 서버·hook 실행 코드는 3.6.0과 같다. 바뀐 것은 판 번호 문자열뿐이다(`mcp-server/src/plugin-info.ts`).
- 이전 판의 3.7.0·3.8.0 계획(상주 서비스, PostgreSQL 저장소)은 3.8.0·3.9.0으로 옮긴다. 4.0.0 계획은 그대로다.

## 새 전문 스킬 `ui-ux-design`

- 사용자 흐름, 화면·상호작용, 접근성, 상태·오류 처리, 대량 목록 표시를 설계하거나 점검한다. 대상은 웹·데스크톱·모바일이다.
- 입력·출력 계약은 `ui-ux-design-request.v1`, `ui-ux-design-report.v1` schema다. 스킬 descriptor, classification, 참고 자료(설계 절차, 출력 계약, AGS 역할 경계)를 함께 둔다.
- Claude(한·영), Codex(한·영), agy 패키지에 같은 스킬이 들어간다.
- 스킬 문맥 최적화 검사(`scripts/check-skill-context-optimization.mjs`)는 고정된 26개 스킬 snapshot에 이 스킬을 넣지 않고 `POST_SNAPSHOT_SPECIALISTS`로 따로 둔다. snapshot 이후에 생긴 스킬이기 때문이다.

## README 개편

- `README.md`, `README.en.md`, `codex-plugin-en/README.md`를 설치, 턴마다 하는 일, 구성 요소, 전문 스킬 표(출처·버전·하는 일), 한계, 문제 해결 순서로 다시 썼다.

## 검증

후보 커밋은 아래에 적는다.

### 이번에 고치지 않은 것

- 열린 결함은 운영 장부 프로젝트 `AGS3`에 있다. 이번 판에 새로 등록한 것은 AGS3-D-0029(session-board 참고 문서가 없앤 `_sessionBinding` 훅 방식을 설명함), AGS3-D-0030(세션이 자기 역할을 인지하고 담당 세션에 맡기도록 이끄는 장치가 없음)이다.
- `ui-ux-design`의 실제 설계 품질 평가는 하지 않았다. 계약·등록·schema 시험만 있다.
