# AGS3 D0007·D0013 경계 회귀 사례

- 기준: `a281139387af096e696f8d50cc089ad09e9291fc`, branch `codex/ags38-core-boundary`.
- 소유: provider semantics·host discovery. acceptance 스킬 구현은 별도 작성자 소유이며 통합 전까지 직접 변경하지 않는다.
- 수준: 실제 gateway/inventory 파일 읽기 + 호스트 CLI stdout 대체. 실제 호스트 목록 조회·모델 호출·설치·bundle clean-room은 root TEST 담당이 별도 수행한다.
- 실행: TEST 또는 CI에서 `pnpm exec vitest run tests/mcp/ags38-core-boundary.test.ts`. 로컬 제품 시험 금지로 이 작업 사본에서는 실행하지 않는다.

| 사례 | 요구·공개 진입점 | 입력·전제 | 절차 | 기대·통과 기준 | 실제 결과 |
|---|---|---|---|---|---|
| CB-01 | D0007 `assertProviderSemantics`의 배포 import 경계 | security skill scripts를 사용할 수 없는 번들 환경 | 기존 esbuild로 공개 모듈을 번들하며 해당 skill script 경로만 거부 | core 번들 성공, skill script 부재가 core를 깨지 않음 | NOT_RUN |
| CB-02 | D0013 `RuntimeSkillClassificationGateway.inventory()` | 설치 root의 manifest·SKILL.md·classification.json과 host CLI 설치/활성 기록이 일치 | 기본 gateway의 observer로 Claude CLI JSON을 읽고 inventory 조회 | host discovery COMPLETE, 실제 스킬 설치/활성/지원 true | NOT_RUN |
| CB-03 | 같은 진입점, 비활성 host 설치 | CB-02에서 CLI enabled=false | inventory 재조회 | 설치 true, 활성 false. registry 활성화로 덮어쓰지 않음 | NOT_RUN |
| CB-04 | 같은 진입점, 관측 실패 | CLI throw·잘못된 JSON·지원되지 않은 host | 각각 inventory 조회 | UNAVAILABLE와 HOST_DISCOVERY_UNAVAILABLE. 오류 비밀을 노출하지 않음 | NOT_RUN |
| CB-05 | 같은 진입점, 경로·버전 변경 | CLI installPath가 다른 root이거나 설치 버전 불일치 | inventory 조회 | 현재 실행 tree를 실제 설치된 것으로 주장하지 않음 | NOT_RUN |
| CB-06 | 같은 진입점, freshness | 같은 관측 내용으로 연속 조회·실제 enablement 변경 | inventory 재조회 | 동일 의미의 revision 안정, 활성 변경은 inventory digest 변경 | NOT_RUN |

RED는 이 사례 그대로 test-only SHA를 TEST에서 실행해 회수한다. import 오류 자체가 원결함인 CB-01 외에는 runner/import 부재를 유효 RED로 세지 않는다. GREEN은 같은 테스트 파일 digest·명령으로 fix SHA를 실행한다. fixture가 대체한 host CLI 실행은 실호스트 통과 근거가 아니다.
