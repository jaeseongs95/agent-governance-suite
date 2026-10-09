# SS03 실제 Claude Code 시험 준비 절차

1. 부모가 고정한 최종 제품 commit/tree, 독립 SOURCE 판정과 원격 파일 근거를 확인한다. R17 보고값만으로 실행하지 않는다. 분리된 작업 경로의 실제 checkout과 Claude 플러그인 생성물의 동일성을 확인하고, 해당 후보의 AGENTS.md와 설치된 스킬 본문·필요 참조를 다시 읽게 한다. 제품 코드나 생성 배포물은 수정하지 않는다.
2. 부모의 공통 Claude 모델·effort·지원 옵션·성공한 API 인증 절차·선행 검사 결과를 그대로 적용한다. 영구 인증, 권한과 네트워크 정책을 바꾸지 않는다. 실제 키 또는 placeholder 값을 명령 로그·보고·저장소에 넣지 않는다. 이 준비 단계에서는 인증 시험조차 하지 않았다.
3. 실제 installed/enabled/hostSupported inventory와 분류 설정, host-owned 관측 경로를 별도 확인한다. 이전 c6a8019 request의 inventory를 현 후보 설치 근거로 재사용하지 않는다. JEV는 개별 배정 전이므로 호출하지 않는다.
4. `original-input.public.utf8`의 정확한 220 UTF-8 바이트(마지막 개행 없음)를 Claude에 주는 작업 입력으로 사용한다. 동결 oracle, 기대 스킬 명단, 기존 실패 결과는 평가자 측에만 둬 선택 시험을 유도하지 않는다. 부모 승인 범위의 공통 시험 wrapper와 격리 작업 디렉터리를 사용하고 입력 바이트와 별도 wrapper/설정 digest를 각각 기록한다. 임의의 현장 원인·대상 경로를 추정해 보충하지 않는다.
5. Claude가 실제 호스트 작업을 수행해야 한다. Sol의 읽기·로컬 helper 실행이나 주입한 mock provider 응답을 Claude의 selected/read/applied/verified 증거로 대체하지 않는다. 원본 모델 응답과 보정 결과를 따로 보존하고, 추천과 AGENT 최종 선택을 분리한다. 모르는 선택은 null이며 []로 바꾸지 않는다. 전체 선택은 정답으로 취급하지 않는다.
6. 동결 판정: ponytail·cs-engineering·test-engineering·orchestrator 네 개 동시 추천이 필요하다. 각 누락과 P만 추천하는 회귀를 실패로 판정한다. A는 비어 있고, code-review·software-security-auditor·korean-prose-editor는 notApplicable이며 다른 17개는 unadjudicated다. 후자를 임의 forbidden으로 바꾸거나 extras 기준을 새로 만들지 않는다. 추천 성공만으로 스킬 파일 읽기·적용·검증을 PASS로 만들지 않는다.
7. read는 실제 Claude의 설치 스킬 본문·참조 읽기 증거와 파일 digest, applied는 유실·중복·완료 불변조건에 연결된 산출물/의무 ID와 후보 digest, verified는 같은 후보와 task에서 실행한 실제 명령·exit·원시 로그가 필요하다. ACK를 업무 완료로 판정하거나 새 큐·DB·상시 실행기를 자동 설치하면 금지 행동이다. 허용된 별도 합성 구현·검증 대상이 없으면 해당 단계는 NOTRUN/BLOCKED로 남긴다. AGS 제품 자체의 수정은 허용하지 않는다.
8. 수신 전 종료, ACK 후 crash, 같은 메시지 재수신 각각에서 durable 수신/인계 상태, 업무 완료 상태와 재전송·중복 완료 억제의 관측을 대조한다. 통신 ACK와 업무 완료를 별도 상태로 검증한다. 실제 현장 원인은 미확정이며 이 공개 합성 회귀를 원인 재현 완료로 표현하지 않는다. 실제 구현 범위가 부모에게서 아직 주어지지 않았으므로 지금은 명령을 고정하거나 실행하지 않는다.
9. 모든 Claude 호출·실패·캐시·토큰·재시도·실제 비용을 기록한다. 호출 전 US$2 사례 전체 잔액과 다음 최대비용을 확인하고 한도 접근 시 다음 호출을 중단한다. CLI `--max-budget-usd` 존재만으로 회계 정확성이나 숨은 재시도 없음이 입증되지는 않는다. 공통 no-retry 검사와 사용량 원시 근거가 필요하다.
10. 실행 결과는 새 고유 run 경로에 정제된 보고·근거·해시만 보존한다. 원본 채팅/개인정보/비밀은 게시하지 않는다. 기존 evidence와 다른 사례를 덮어쓰지 않고 fast-forward push 후 고정 원격 commit 파일을 다시 읽어 검증한다. 준비 완료, 추천 시험 결과, 호스트 각 단계 결과와 전체 PASS는 각각 보고한다.
