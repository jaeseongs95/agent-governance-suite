# P5: workflow 이력과 모델 적용 기록 연결

## 이번 변경 범위

`codex/v250-model-routing-integration`의 `8305da8405bf4610101019bd461e262c8f3e8f5a`에서 이어 구현했다. 전체 v2.5.0 릴리스 완료를 뜻하지 않는다.

- **A14 / P5**: `openModelRoutingService(path, workflowStore)`가 기존 `ModelRoutingServiceCore`에 실제 이력 조회기를 연결한다. 현재 Convergence Root와 부모 Root의 proposal/lease actor, workflow bootstrap/stage의 관측 actor, 실제 예약된 라우팅 dispatch의 actor/session을 보수적으로 제외한다. 모델 종류나 임의의 actor 문자열에서 session을 추측하지 않는다. 선택안만 만들고 dispatch를 예약하지 않은 대상은 실행 참여로 세지 않는다.
- **A10 / §9.1–9.2**: 서버 시작점은 `RoutingAwareWorkflowService`를 사용한다. 기존 `recordStageResult`를 호출하기 전에 `ags-model-record:` artifact/evidence를 저장된 v2 record/decision/request와 대조한다. task/run/stage/revision, consumed lease, candidate, selected target, digest를 검사한다. v1 스키마를 확장하거나 기존 receipt/root/frame을 재작성하지 않는다.
- **A08–A09**: passed 단계가 참조하는 고위험 배정은 모델/추론/실행 모드의 admitted observation과 성공 terminal outcome을 요구한다. 일반 미관측 기록과 실패 기록은 진단 자료로 보존할 수 있다. 이 검사는 기존 trusted execution gate를 대체하지 않는다.
- **A14 채택 시 재검사**: 독립 감사 기록을 채택할 때 참여 이력을 다시 읽는다. 해당 감사의 자기 dispatch 한 건만 제외하며, 이후 다른 구현에 참여했다면 차단한다. ancestor/receipt 누락·순환·크기 초과를 빈 이력으로 취급하지 않는다.

## 연결 계약

workflow bridge를 사용하는 v2 binding의 `attemptId`는 해당 run을 시작한 **소비된 `leaseId`**다. `revision`은 현재 workflow receipt revision이며 `stageId`는 현재 ready 단계다. `candidateDigest`는 그 lease의 target-set digest 또는 동결된 proposal frame에 명시된 target/candidate digest여야 한다. `inputDigest`는 기존 assignment request에 고정한 값을 보존한다. 이를 task envelope digest로 임의 치환하지 않는다.

`output.artifacts`의 `schemaId`는 `https://skill-suite.local/contracts/model-application-record.v2.schema.json`, `locator`는 `ags-model-record:<64자리 hex>`, `digest`는 저장된 `recordDigest`, `targetDigest`는 그 record의 `candidateDigest`다. `evidence`에 같은 URI를 넣을 경우 같은 artifact ID/URI의 artifact도 필요하다. URI를 파일 경로로 열거나 외부에서 내려받지 않는다.

서버는 `StageResult.v1`에 v2 객체를 직접 넣지 않는다. 기록을 `verified: true`로 참조해도 모델 실행의 암호학적 증명이 되지 않는다. 기존 workflow gate는 여전히 별도의 trusted execution observation을 요구한다. 동일 OS 사용자에 대한 격리, 작업 전체의 exactly-once 실행, 실제 벤더 계정 검증을 주장하지 않는다.

기존 `WorkflowService`와 v1 router의 동작은 변경하지 않는다. production entrypoint에서 additive subclass를 연결하며, 라우팅 URI/schema를 참조하지 않는 단계는 기존 구현으로 그대로 전달한다. routing 저장소 초기화가 실패해도 기존 단계는 동작하며 새 routing reference만 `BINDING_REQUIRED`로 거부된다.

## 실행한 검증

Linux / Node 22.16.0에서 해당 HEAD의 CI가 보관한 잠긴 의존성으로 실행했다.

- 신규 workflow bridge 테스트 30개 포함 라우팅 관련 132개 통과.
- 전체 TypeScript `--noEmit`, 변경 파일 ESLint 통과.
- build, bundle freshness, Claude 생성/일치 검사, SourceLock 검사 통과.
- 실제 SQLite workflow DB 재열기, guarded lease/run 흐름과 기존 strict gate 보존을 검사했다.
- lineage 순환/누락/parent traversal 일부는 명시적 fixture이며 live host 관측이 아니다.

전체 회귀/CI 상태는 이번 변경 기능 검사와 별도로 보고한다. 독립 감사나 실제 유료 계정 호출은 실행하지 않았다.

## 남은 계획

P3의 실호스트 capability/관측 hook, P5의 broker capability publication 및 peer 자동 송수신, P6의 실측 telemetry 수집, P7의 최종 릴리스 판정·독립 감사·설치 캐시 및 A22 live 계정 검증은 이번 범위에 포함하지 않았다. 버전은 2.4.0을 유지한다.
