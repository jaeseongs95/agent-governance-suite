# AGS-D-0019: 루트 전용 도구 접근과 지속 신원 설계

기준 소스는 7a8aade829d30284499b1fbd21cb168c60e78f24이다. 90fbc3c7·7a8aade8의 합성 시험 성공은 보존하지만 근본 수정이나 실제 Claude 복구 근거로 사용하지 않는다. 이 문서는 사용자 감사 정리 #4342~#4347에 대한 구현 설계이며, 원래 수용 조건·원18 요구·전체 검증 계약을 대체하지 않는다. 설치는 HOLD, AGS-D-0019는 OPEN이다.

## 하나의 공통 정책

모든 AGS CallTool은 서비스·DB·브로커·외부 호출 전에 같은 gate를 지난다. bootstrap·조회 도구도 예외가 없다. 등록된 신뢰 adapter가 **현재 요청에 결속된 observed root 신원**을 반환할 때만 도구별 기존 검사로 진행한다. child·unknown·근거 없는 추론은 동일하게 BINDING_REQUIRED로 거절한다. 관측 실패는 MCP_UNAVAILABLE로 구분한다. root 통과가 workflow 승인·서명·권한·nonce 검사를 대체하지 않는다.

공통 계약은 SessionActorDecision의 root/child/unknown, AGS identityId/rootIdentityId, observed/inferred/unavailable 근거와 evidence reference다. 코어는 벤더 필드·actor 라벨·CLI 출력 형식을 읽지 않는다. adapter는 서버의 신뢰 composition에서만 설치하며, tool arguments로 선택하거나 구성하지 않는다. transport sessionId나 요청 metadata는 그 자체로 행위자 증명이 아니다. 새 호스트는 adapter를 등록하고 같은 코어 시험을 통과한다.

공통 gate의 미설정 기본값은 unknown이다. 따라서 신원 producer를 아직 연결하지 않은 현재 실행 entry는 도구를 모두 거절한다. 이 첫 소스 단위는 무권한 호출의 서비스 진입을 막지만 사용 가능한 전체 후계가 아니다. root를 임의 허용하여 이 공백을 숨기지 않는다.

## 임시 ID, 외부 ID, 권한은 서로 다르다

1. 첫 hook에서 AGS가 임시 identity ID를 발급한다. **첫 hook이라는 시점만으로 root 권한을 발급하지 않는다.** 어느 독립 실행/세션에 속한 첫 hook인지 입증할 owner context가 없으면 unknown 등록만 가능하다. app-server PID·최초 시각·cwd를 root context로 삼지 않는다.
2. adapter가 신뢰된 root 시작/연결 또는 parent-child 관계를 관측하면 그 근거 reference·producer version·generation과 신원을 결속한다. 자식이 독립적으로 나타난 것처럼 보이면 이벤트 유실/재개 가능성을 포함해 unknown으로 두며, 관측 순서만으로 다른 root의 자식으로 붙이지 않는다.
3. host session ID를 얻으면 안정된 내부 AGS ID는 유지하고 외부 표시 ID를 host ID로 승격한다. 이전 임시 ID는 alias로 유지해 진행 중인 workflow·메시지 참조를 끊지 않는다. session ID가 부모와 자식에게 공유될 수 있으므로 host session ID만으로 alias를 결속하지 않는다.
4. 이후 hook은 새 프로세스여도 같은 신뢰된 owner/actor binding과 generation을 검증하여 저장된 AGS identity를 조회한다. 단순 대화 토큰·role·PID·환경/지시문 복사·agent_id 누락은 이 조회의 근거가 될 수 없다.
5. child 관계는 sticky다. 누락 필드·완료·재개·새 PID로 root가 되지 않는다. 서로 상충된 root/parent/alias는 명시적 conflict이며 자동 병합하지 않는다.

신원 저장은 hook 프로세스 안의 Map으로 끝내지 않는다. 구현은 기존 workflow 상태 저장 경계 안에서 identity/alias와 근거 결속을 원자적으로 보존한다. 호스트 namespace·owner context·generation·actor correlation의 uniqueness와 compare-and-set으로 중복 전달, 동시 결속, 충돌을 구분한다. commit 전 실패는 전부 rollback, commit 뒤 응답 유실은 같은 ID로 재시도한다. 운영 DB 직접 수정이나 설치 시 schema migration은 이 소스 작업의 권한이 아니다. 실제 SQLite 두 연결·재개·failpoint 검증 전에는 이 저장 설계를 구현 완료라 하지 않는다.

## 호스트별 세 시점과 현재 근거의 한계

| adapter | 첫 hook의 임시 ID/루트 확정 | host ID 승격 | 후속 호출 연결 근거와 현재 미확인 |
| --- | --- | --- | --- |
| Codex | 신뢰 entry의 첫 hook에서 임시 ID를 발급한다. 문서의 시작 이벤트만 보고 root-only dispatch를 단정하지 않는다. | 실제 producer가 제공한 session ID와 root 시작 근거를 owner context에 결속한다. 자식 이벤트에서 부모 session ID가 올 수 있어 actor ID와 구분한다. | 실제 설치 producer의 start/input/tool 이벤트 수신과 자식 caller 표시를 채집해야 한다. thread API parent metadata/호출별 trusted channel은 후보이며 아직 연결 근거로 검증되지 않았다. |
| Claude Code | 신뢰 entry의 첫 hook에서 임시 ID를 발급한다. SessionStart·SubagentStart의 실제 지원과 root 시작 범위를 producer version에 결속한다. | session ID는 대화 별명이다. 자식은 별도 actor 식별 근거와 parent 관계가 함께 있어야 하며 부모 session alias를 자식 신원으로 대입하지 않는다. | 문서상 agent_id는 자식 표시 후보다. 실제 버전별 일반 tool hook에 표시가 있는지, 부모와 같은 연결에서 요청을 구분할 수 있는지는 미채집이다. 필드가 없으면 main으로 보정하지 않는다. |
| Gemini 및 추가 host | 동일 임시 ID 발급 절차를 사용한다. adapter가 root 구분 근거를 제공할 수 없으면 unknown이다. | 실제 session ID와 신뢰 actor 연결을 검증한 뒤에만 승격한다. | 공개 hook base schema의 session_id만으로 root/child 구분은 입증되지 않는다. 실제 producer version·자식 event/caller 표시 자료가 미제공이며 generic actor 규약을 발명하지 않는다. |

현재 Codex 공식 문서는 일반 session_id와 자식 이벤트의 부모 session ID를 구분하고 SubagentStart/Stop에 자식 필드를 제시한다. 이는 현재 설치 바이너리의 event dispatch 증거가 아니다. [OpenAI hooks](https://learn.chatgpt.com/docs/hooks)

Claude 공식 문서는 자식 식별 및 SubagentStart/Stop를 설명한다. Start는 재개에도 올 수 있고 Stop은 응답 완료로서 실제 자식 소멸을 보장하지 않는다. 따라서 Start++/Stop--로 권한을 여는 설계는 사용하지 않는다. [Claude hooks](https://code.claude.com/docs/en/hooks)

Gemini 공개 base schema의 session_id는 대화 식별 필드이며 actor/root 증명 필드로 정의되어 있지 않다. 이 사실로 자식 미지원이나 root임을 단정하지 않는다. [Gemini hooks](https://geminicli.com/docs/hooks/reference/)

세 host의 실제 producer/version-bound 세 시점 fixture는 현재 NOT_COLLECTED다. PATH CLI 버전은 desktop producer 버전으로 대체하지 않는다. 채집은 소유한 root와 기존 child의 허용 필드 존재·타입·비어 있음 구분·익명 correlation·producer/adapter SHA만 보존한다. prompt/tool_input/환경 전체/다른 세션 원문/transcript는 읽지 않는다.

## 호출자를 구분할 수 없는 경우

권장 경로는 host가 자식에게 AGS MCP 도구를 노출하지 않고 요청별 root 채널/식별 근거를 제공하는 것이다. 이 기능의 실제 지원이 확인되면 adapter가 사용한다. 공유 MCP 연결의 부모 session ID만으로는 root 전용을 강제할 수 없다.

대안인 자식 수 조회는 보조 근거다. complete snapshot인지 확인할 수 없거나 조회와 호출 사이 자식 생성이 가능하면 zero를 권한 근거로 쓰지 않는다. zero 전략을 쓰려면 producer가 child 생성과 root tool dispatch를 같은 경계에서 직렬화하고, child 재개/숨은 child/재부팅 뒤 복원까지 완전성을 보장해야 한다. 현재 이 보장은 확인되지 않았다. CLI 호출당 조회나 isConnected 표시는 그 보장을 만들지 못한다.

구분 불가 시 모든 host가 같은 unknown 거절을 받는다. root 도구가 함께 막히는 가용성 제약은 명시하고, 특정 host만 없음=main 예외로 풀지 않는다. 임시 ID는 호출자 구분 실패를 해결하는 인증 수단이 아니다.

## wake 소비자와 기존 분산 규칙

wake는 authorityEffect:none인 peer liveness 근거다. root 도구 사용권과 분리한다. observedBy 문자열을 신원/출처 판정에 사용하지 않는다. 신규 구조화 provenance normalization은 명시 버전으로 결속하고, 이전 signed receipt는 그 버전의 digest/서명 규칙으로만 검증한다. peer origin·target·nonce·서명·원 digest·시간 guard는 유지한다. 164의 equality만 제거하면 historical 206의 digest 재구성이 깨지므로 생산자 라벨 변경으로 봉합하지 않는다.

board/message/continuity/Antigravity의 별도 child deny 목록과 trust-service의 actor-specific 분기는 공통 gate 통합 뒤 영향 시험과 함께 정리한다. entry hook은 host 입력을 공통 계약으로 바꾸고 공통 정책을 호출하는 역할만 둔다. 현재 잔존 코드를 이 첫 gate 단위에서 해결했다고 주장하지 않는다.

## 자식의 직접 AGS 호출과 검증

별도 조사에서 자식의 직접 AGS 호출이 기능상 필수인 사례는 아직 발견하지 못했다. 자식은 결과와 실행 근거를 부모에게 반환하고 부모가 AGS에 제출한다. 독립 감사자의 판단/서명 주체와 실제 실행자 신원은 보존한다. 부모의 모델 관측을 자식이 실행했다는 관측으로 대체하지 않는다. 현재 source evidence inventory는 별도 clean 산출물에 고정한다.

검증 담당은 코어를 두 종류 이상의 fake adapter와 실제 MCP ListTools/CallTool로 시험한다. 모든 등록 도구의 child/unknown 거절과 부작용0, root 통과 뒤 도구별 기존 검증 유지, 요청 사이 root 권한 재사용 방지를 확인한다. 이것은 native adapter PASS가 아니다. adapter는 실제 version-bound 입력만으로 세 시점/자식/재개/유실을 검증한다. 28case 설계의 지속 저장·alias 경합·wake 서명 변조·실제 설치 POST를 유지한다.

다음 통합 조건은 root gate + 지속 identity/alias + 실제 호스트별 binding + 소비자 provenance를 같은 후계 source/normal GEN에 결속하는 것이다. 실제 host 증거가 없는 지원 범위는 UNKNOWN으로 제출하며, 전체 PASS나 설치 복구 완료로 보고하지 않는다.
