# AGS 직접 사용자 승인 출처 계약 (R18-ch)

이 문서는 R17 "AGS 최소 producer 계약"의 "서버에 기록된 사용자 승인 이벤트"가 무엇이어야 하는지 정한다. 스키마는 `contracts/user-approval-channel.v1.schema.json`, 조사 근거는 `docs/implementation-3x/evidence/R18-ch-approval-channel-survey.json`이다. 이 Task는 구현하지 않는다. 결과는 **BLOCKED_CONTRACT**다. 조사한 후보 중 아래 성질을 모두 채우는 것이 없다.

## 위협 모델

같은 OS 사용자로 도는 모든 로컬 프로세스(worker, caller, hook, 모델, peer)는 사용자 파일과 키를 읽고 사용자로 실행될 수 있다고 가정한다. 승인 출처는 이들 누구도 만들거나 바꾸거나 재생할 수 없어야 한다.

다음은 승인 출처가 아니다. 서버는 이것들로 승인 기록을 만들지 않는다.

- PID, 프로세스 이름·조상, turn hash
- 일반 hook 입력(UserPromptSubmit, PermissionRequest, Elicitation hook 포함)
- ACK, Stop 신호
- peer 메시지
- 모델이 중계하거나 요약한 사용자 응답(AskUserQuestion 포함)
- caller JSON, MCP 도구 인자, `approved=true` 같은 플래그
- needs-approval 단계 상태
- userApprovalRefs 문자열
- workspace 파일

## 출처가 갖춰야 할 성질

| ID | 성질 |
|---|---|
| P1 | AGS 서버가 암호 증명을 직접 검증한다. caller가 전한 결과를 믿지 않는다. |
| P2 | 서명 키를 같은 사용자 프로세스가 읽거나, 그 승인에 대한 새 사람 동작 없이 쓸 수 없다. |
| P3 | 사람은 결속 내용(runId·taskId·stage·revision·digest)을 같은 사용자 프로세스가 그리거나 바꿀 수 없는 화면에서 본다. |
| P4 | 서명 대상이 runId, taskId, stageId, assignmentId, approvalRevision, approvalDigest와 서버 challenge를 모두 결속한다. |
| P5 | 서버가 발급한 challenge는 기록을 쓰는 같은 transaction에서 한 번만 소비된다. 재사용·재생·만료는 거부한다. |
| P6 | 키 철회와 승인 철회를 서버가 기록하고, 기록·효과 전에 확인한다. |
| P7 | 검증 코드와 등록된 승인자 키 목록(trust anchor)을 같은 사용자 프로세스가 바꿀 수 없다. |

## 출처 종류와 증명 형식

스키마가 받는 출처 종류는 `out-of-band-signed-approver` 하나다. 별도 기기의 승인 앱이 결속 내용을 자기 화면에 보여 주고, 사람이 승인하면 그 기기 안의 키로 서명한다.

- 서명 대상(`statement`): `kind=ags-user-approval-statement`, `originKind`, `decision`(approve|deny), `binding`(runId, taskId, stageId, assignmentId, approvalRevision≥0, approvalDigest `sha256:<64 hex>`), `challenge`(issuedBy=`ags-server`, 43자 base64url nonce, issuedAt, expiresAt), `approver`(keyId, enrollmentRevision), `displayedFields`(결속 필드와 decision 전부).
- 증명(`proof`): `format=ed25519-jcs-v1`, `keyId`, `signature`(86자 base64url). 서명 입력은 `statement`의 RFC 8785 JCS 직렬화 bytes다.
- 알 수 없는 필드는 받지 않는다(`additionalProperties: false`). `approved`, `userApprovalRefs`, hook 판정 같은 필드는 스키마에서 거부된다.

## 검증 절차 (R18-a intake가 이 순서로 강제한다)

1. 서버가 승인 요청을 만들 때 binding과 challenge를 자기 저장소에 먼저 기록한다. 증명은 이 기록과 대조할 때만 의미가 있다.
2. 스키마 검증. 실패하면 거부한다.
3. `proof.keyId`를 서버가 보관한 승인자 등록부에서만 찾는다. 없거나 철회된 키면 거부한다. `proof.keyId`와 `statement.approver.keyId`가 같고, `statement.approver.enrollmentRevision`이 등록부의 현재 revision과 같아야 한다. 다르면 승인자를 잘못 귀속할 수 있으므로 거부한다.
4. JCS bytes에 대해 Ed25519 서명을 검증한다.
5. binding의 모든 필드와 challenge(nonce, issuedAt, expiresAt)가 1의 대기 요청에 저장된 값과 같아야 한다.
6. challenge가 만료되지 않았고 아직 소비되지 않았어야 한다. 소비와 승인 기록 쓰기는 같은 transaction이다.
7. 승인 철회 여부를 확인한 뒤 R17 `ags-workflow-approval-record`를 쓴다.

## 키·자격의 보관 주체

- 승인자 서명 키: 별도 기기 안. 같은 사용자 로컬 프로세스는 접근할 수 없어야 한다(P2).
- 승인자 공개키 등록부: AGS 서버가 보관한다. 그러나 현재 AGS 서버는 `ags-local-server`, `protectedPrincipal=false`로 같은 사용자 권한에서 돈다(`approved-role-source.ko.md:52`). 같은 사용자 프로세스가 등록부나 검증 코드를 바꿀 수 있으므로 P7을 채우지 못한다. 보호된 검증 principal이 생기기 전까지는 어떤 출처를 골라도 P7은 열려 있다.

## 반증 조건과 강제 지점

각 조건은 구현 전에 먼저 실패하는 테스트로 걸어야 한다. 스키마 fixture가 거부하는 것은 형식 위반(비권위 출처 종류, 결속 필드 누락, 증명 형식 위반, 추가 권한 필드)뿐이다. 아래 조건은 상태·암호 검증이 필요하므로 스키마 PASS를 그 거부 증거로 쓰지 않는다.

| 조건 | 강제 Task | 강제 지점 |
|---|---|---|
| `forgedSignature` | R18-a | 등록된 키로 JCS statement 서명 검증 |
| `crossRunReuse` | R18-a | binding 전 필드와 challenge 필드를 서버의 대기 요청과 대조 |
| `replay` | R18-a | challenge nonce를 기록 쓰기와 같은 transaction에서 소비 |
| `useAfterRevocation` | R18-a, R18-b | intake와 current read에서 승인·키 철회 확인 |
| `expiredChallenge` | R18-a | 서버 시계로 expiresAt 확인 |
| `unenrolledOrRevokedKey` | R18-a | keyId를 서버 등록부에서만 해석하고, proof·statement keyId 일치와 enrollmentRevision 일치를 확인 |
| `hookModelPeerEvent` | R18-a | 증명 envelope만 받고, hook·도구 인자·peer 메시지 경로로는 기록을 만들지 않음 |
| `trustAnchorTamper` | 미배정 | 보호된 검증 principal이 필요. R18-a 안에서는 채울 수 없음 |

## 조사 결과

| 후보 | 존재 | 판정 | 핵심 근거 |
|---|---|---|---|
| 별도 서명 승인 앱 | 부재 | ABSENT | AGS에 승인 앱·등록부·adapter가 없다(`mcp-server/src/index.ts:68`). 만들어도 P7이 남는다. |
| OS 수준 확인(Windows Hello, credential UI) | 존재 | FAILS_PROPERTIES | UserConsentVerifier는 호출 프로세스에 enum만 돌려준다(P1 실패). KeyCredentialManager 서명은 prompt에 승인 내용을 보여 주지 않는다(P3 실패). 키 범위는 UNKNOWN(P2). CredUI 자격 prompt는 입력한 자격을 호출 프로세스에 돌려주고, UAC secure desktop 동의는 권한 상승 결정일 뿐 AGS가 검증할 증명을 만들지 않는다(문서 분석, probe 없음). |
| 로컬 사용자 서명 키 | UNKNOWN(열거하지 않음) | FAILS_PROPERTIES | 파일 키는 같은 사용자가 읽는다(P2 실패). touch 토큰은 내용을 보여 주지 않는다(P3 실패). |
| Claude Code elicitation | 존재(2.1.283) | FAILS_PROPERTIES | Elicitation/ElicitationResult hook이 응답을 만들거나 바꾼다. 응답에 증명이 없다. live 관측은 NOT_RUN(비용 승인 대기). |
| Codex elicitation | 존재(0.155.1) | FAILS_PROPERTIES | app-server client가 응답할 수 있고 증명이 없다. guardian 자동 검토는 문자열상 mcp_tool_call 종류의 빈 폼 elicitation에만 해당한다. `openai/elicitationuserVerification`의 의미는 UNKNOWN. |

원시 근거와 probe sha256은 survey evidence에 있다. R18-a evidence(`74811c89`)는 조사 입력으로만 읽었고, host 관측은 이번에 다시 했다.

## 결과와 상향

- 판정: **BLOCKED_CONTRACT**. `R18-ch.test.mjs`는 후보 중 `SATISFIES_ALL_PROPERTIES`가 없으면 `USER_APPROVAL_CHANNEL_FROZEN`을 거부한다.
- 사용자·총괄이 고를 제품 선택
  1. 별도 기기 승인 앱과 보호된 검증 principal을 함께 새 Task로 만든다. 이 계약의 P1~P7을 그대로 쓴다.
  2. 같은 사용자 위협 모델을 낮춘 약한 보증 등급을 정식으로 정의한다. 이 경우 R17의 승인 기록이 그 등급을 드러내야 하며, 이 Task가 대신 정하지 않는다.
- R18-a는 위 선택이 정해질 때까지 BLOCKED_CONTRACT 그대로다. 이 Task 완료는 R18-a intake·저장 구현이나 live host 승인 완료가 아니다. 테스트 전용 기록 경로는 제품에 노출하지 않는다.
