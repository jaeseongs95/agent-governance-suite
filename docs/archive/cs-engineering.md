# CS Engineering — AGS 2.8.0 릴리스 후보 통합 상태

이 문서는 현재 후보의 구현 범위다. 원 설계는 cs-engineering-design.ko.md에 입력 bytes 그대로 보존했다. 설계의 모든 기능을 구현한 것으로 읽지 않는다. 기준 main은 f39501efe5dfe51d83af9afddf39dec7b7e26b01 / 2.7.7이고, 최신 공개 태그 v2.7.7은 ba85fdcf245b9910674d88fffdd125f6f0454027을 가리킨다. 새 독립 브랜치 codex/cs-engineering-2x만 변경했다. 공개 릴리스·사용자 설치 상태는 별개다.

## 구현 범위

| 경로 | 현재 구현 |
| --- | --- |
| 발견·등록 | implicit invocation 메타데이터, registry의 bootstrap25/workflow67, compact query 노출, README 두 표, internal source-lock |
| 선택·지식 | 요청 목적·동작 기반 적용 지침, 필요한 분야만 로딩, 동결 팩 0.1.0의 핵심5분야20규칙과 draft5분야20규칙 분리 |
| task-contract·인계 | READY 보고서·출처·검증 계획을 기존 계약 절차에 전달하는 지침과 handoff CLI의 실물 접근·digest·의무 ID 재검사 |
| 선택된 리뷰 단계 | 기존 StageResult/ProviderResult artifact의 CsStageBundle.v1 참조를 실제 CLI로 검증; signed taskDigest와 동일 task·후보·report·원시 근거 대조 |
| 완료·재개 | 기록한 manifest/file digest를 stage 기록과 finalize 시 재검사; SQLite 재시작에서 stage artifact pin 보존 회귀 |
| 계약·배포 | 기존 TaskEnvelope.v1/plan wrapper와 실행 보안 유지, 새 스킬 내부 stage manifest 스키마, 공용 Ajv 사용, node_modules 없는 CLI/MCP 번들 |
| 검증 자산 | 입력 독립 회귀, AGS 통합 회귀, 실제 MCP tool 호출의 합성 observation fixture, Node24 전체 회귀와 생성물 검사 |

스킬 배포 버전은 0.2.0이다. 지식팩 버전·rule digest·knowledge lock은 입력의 0.1.0을 그대로 유지한다. 새 stage manifest는 실행 인계 계약으로 분리하고 기존 지식팩 lock의 항목에 사후 편입하지 않았다. 전체 스킬 파일은 source-lock으로 별도 고정한다.

리뷰의 FAIL/BLOCKED는 기존 상태 매핑에서 non-passing이다. 공급된 observe policy도 NOT_RUN을 PASS로 바꾸지 않는다. 직접 check-bundle의 canProceedUnderSuppliedPolicy는 공급 정책에 따른 로컬 평가이며 운영 정책의 권한이나 MCP 완료 승인을 발급하지 않는다.

## 남는 경계

1. 새 1.1 plan wrapper, signed plan·expected plan 재구성·lease·guarded start·resume의 CS binding 전파는 NOT_IMPLEMENTED다. 현재 taskDigest만 기존 서명에 들어간다. 전체 CS binding은 기록한 stage의 artifact 참조에서 처음 고정된다.
2. 서버가 전 작업의 CS 적용성을 판정하거나 CS를 필수 선택하는 정책, ponytail의 조건부 required input과 의미적 수신 증명은 NOT_IMPLEMENTED다. 비CS 작업에는 기존 계획과 보안·감사 순서를 유지한다.
3. acceptance 기준과 CS 의무 집합을 서버가 우회 불가로 일치시키는 정책, 후보 변경을 CS 통제 frame의 재계약·epoch로 자동 연결하는 기능은 NOT_IMPLEMENTED다. 선택된 CS stage의 최종 raw-file 검사가 전면적 acceptance gate를 대신하지 않는다.
4. 공급 정책의 권한, 테스트 실행 내용의 진실성, 리뷰어 독립성은 이 validator가 증명하지 않는다. 기존 보안·수용 근거·독립 감사 책임은 그대로 남는다.
5. 사용자 실호스트 설치·자동 선택·호출, Windows/Node24, A/B/C 품질·비용 평가, 구현자와 분리된 SOURCE 감사는 NOT_RUN이다. 전체 스킬 선택 실패 분석은 이 작업 범위가 아니다.

상세 호출 형식과 인계 절차는 skills/cs-engineering/references/ags-2x-integration.md를 따른다. 오래된 wrapper가 unknown field를 거절하면 필드를 삭제해 약한 경로로 재시도하지 않는다.

## 호환성과 다음 선택

기준 main/2.7.7에서 새 전문 기능이 추가되므로 2.8.0 minor 후보를 제안한다. Node >=24와 pnpm11.19.0, Registry2.0, SourceLock3.0 및 기존 TaskEnvelope1.0을 유지한다. 기존 wire 상태·오류 코드·DB migration·승인 권한을 확장하지 않는다. 다른 2.x commit에 자동 적용 가능한 patch라고 주장하지 않는다.

parent는 현재 선택된 stage 검증을 가진 제한적 2.8.0 후보를 검토하거나, 별도 승인 범위에서 opt-in1.1 wrapper·모든 생명주기 pin 전파를 설계할 수 있다. 전 작업 적용성·강제 정책은 별도 선택이다. 현재 후보에 3.0 설계를 자동 적용하지 않았다.

최종 검증의 명령·환경·원시 실패·보정·재실행·source pin은 검토 ZIP의 evidence와 source-manifest에 보존한다. 입력 보고서의 Node22/Python3.13/SQLite3.46 PASS는 이번 후보 결과로 재사용하지 않았다. 합성 TLS/STDIO/메시징 fixture는 운영 호스트 연결과 구분한다.
