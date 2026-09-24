# F01 — FlowMarshal A2 same-user 신뢰 프로필

상태: **계약 동결**. `host-integration.v1.schema.json`의 `$defs`와 `F01.test.mjs`는 F02/F03 구현의 입력이다. 이 변경은 A2 verifier, 서버 선택, 운영 pin, 제품 수용이나 live 관측을 활성화하지 않는다. 기존 `host-integration.json`은 패키지 진입점과 파일 해시만 광고하며 프로필 가용성 증거가 아니다.

## 두 프로필의 권위

| 항목 | 보호 VM (`vm-protected-v1`) | A2 (`flowmarshal-same-user-v1`) |
|---|---|---|
| `assuranceTier` | `strong` — 보호 설치, 별도 worker 주체와 접근 검사가 실제 확인된 경우에만 | `same-user` — FM과 AGS가 같은 OS 사용자 경계에 있음 |
| receipt domain | `vm-provider-terminal-to-governance` | `fm-same-user-provider-terminal-to-governance-v1` |
| dispatch domain | `ags-vm-dispatch-registration-v1` | `ags-fm-same-user-dispatch-registration-v1` |
| model class | operator가 검증 host build와 관측 model ID에 고정한 exact 표 | FM producer가 서명한 **주장**. AGS가 provider 원자료를 독립 확인한 값이 아님 |
| actor | operator pin의 installation ID에서 유도한 producer principal | FM producer가 서명한 **주장**. 인간·개별 worker 신원이나 독립성을 뜻하지 않음 |
| key/pin/state namespace | `vm-protected-v1` | `flowmarshal-same-user-v1` |

A2의 서명은 선택한 FM producer가 그 내용을 냈고 현재 호출에 결속됐음을 검사하는 수단이다. 같은 사용자에게 FM 원장, Claude transcript, producer key 및 A2 설정을 조작할 능력이 있으면 원래 관측의 진실성을 보장할 수 없다. 같은 사용자의 별도 프로세스도 OS 격리로 취급하지 않는다. AGS는 FM 원장이나 Claude transcript를 직접 열어 재해석하지 않고, FM의 typed 관측과 검증된 서명 주장만 받는다. 보호 VM의 운영 근거를 A2 fixture나 같은 사용자 서명으로 대체하지 않는다.

## 서버 선택과 고정

AGS 서버는 시작할 때 서버 로컬 설정의 `serverProfileSelection` **하나**를 명시적으로 읽어 고정한다. `source`는 `server-local-operator-config`이며 서버가 관리하는 설정 출처여야 한다. A2는 같은 사용자 보호 수준만 주장하므로 이 이름이 OS 보호를 뜻하지 않는다. 요청 JSON, `_hostAttestation`, MCP control RPC, 임의 환경 변수, argv, cwd, 패키지 manifest, 설치 상태는 선택값이나 `assuranceTier`를 바꿀 수 없다. 선택 또는 pin이 없으면 경로를 거부한다. A2와 보호 VM 사이 자동 fallback은 없다. 변경은 새 서버 인스턴스를 명시적으로 시작하고 기존 예약을 폐기해야 한다.

`freezeIdentity`는 `sha256:` + AGS `canonicalJson`의 UTF-8 bytes에 대한 소문자 SHA-256이다. 해시 입력은 `freezeIdentity` 자체를 뺀 정확한 서버 선택 객체(`source`, 완전한 `profile`, `pinSetDigest`, `resourceBindingDigest`)다. `resourceBindingDigest`는 실제 자원을 가리키는 `{keyLocation, pinLocation, stateLocation}` 객체의 같은 방식 SHA-256이다. 이 세 값은 서버가 해석한 정규 절대 위치이며 선택 profile의 자원과 일치해야 한다. 시작 시 각 digest와 실제 자원을 대조하고 선택 객체를 인스턴스 수명 동안 고정한다. key·pin·state는 profile의 논리 namespace별로 분리하며 기존 보호 VM의 OS 경로 계약을 이 문서가 바꾸지는 않는다. A2 key를 VM pin에 등록하거나 VM key를 A2 pin에 등록하지 않는다. `keyId`가 같아도 namespace가 다르면 다른 키이며 교차 조회는 실패한다. nonce, reservation, challenge, observation claim 및 workflow receipt의 저장 공간도 profile별로 분리한다. 다른 namespace의 기존 상태는 복사하거나 재해석하지 않는다. 실제 경로 소유권·권한 검사와 저장소 구현은 후속 leaf에서 입증한다.

보호 VM의 `strong`은 스키마 값 또는 보호 파일의 존재만으로 성립하지 않는다. 기존 `VmModelPolicy.installed()`는 V03-j의 실제 worker 관측이 없어서 `null`을 반환한다. 보호 설치·worker 접근·key/pin 권위·현재 요청 결속을 확인하기 전에는 보호 VM을 선택했더라도 strict admission이 닫혀 있어야 한다. A2가 설치된 보호 경로를 발견해 `strong`으로 승격하는 것도 금지한다.

## 서명, 현재 호출, 반환값 결속

F02 verifier의 입력인 FM typed producer receipt와 dispatch registration은 각자의 A2 domain에 `profileId=flowmarshal-same-user-v1`과 `freezeIdentity`를 **서명 대상 body 안**에 넣는다. 서버는 선택한 pair, A2 namespace에서 조회한 pin/key, 실제 예약된 호출 ID·tool·unsigned input digest, task/run/stage revision과 재생 방지 상태를 서로 비교한 후에만 관측을 제공한다. VM domain의 서명이 유효해도 A2 verifier는 거부하며 그 반대도 같다. 요청 필드의 profile 값은 기대값을 만드는 입력이 아니다. 서로 다른 profile의 receipt, key, pin, nonce, reservation, state, workflow receipt를 섞은 경우에는 nonce나 효과를 소비하기 전에 거부한다.

검증된 profile pair는 AGS가 투영하는 `executionContext` 및 해당 plan/stage의 workflow receipt에 그대로 결속한다. 모델·effort는 FM typed terminal 주장, `modelClass`와 `actorId`는 위 표의 FM 서명 주장 출처로 표시한다. strict service가 요구하는 이 필드를 요청 JSON이나 legacy CLI의 self-report로 채우지 않는다. `executionContext`·workflow receipt의 profile pair가 현재 서버 선택이나 해당 run의 저장 pair와 다르거나 빠지면 거부한다. 기존 범용 `ExecutionContextV1`과 `WorkflowReceiptV1`에 이 필드를 강제로 추가해 기존 경로를 바꾸는 것은 F01 범위가 아니다. F02가 A2 제품 투영·영속 경계를 구현할 때 profile 결속을 실제 schema와 store에 연결한다.

`F01.test.mjs`는 JSON Schema의 고정 profile·선택·binding 정의와 교차 domain/key/pin/state/receipt 예시의 거부를 검사한다. 이는 계약 fixture PASS이며 제품 verifier, 운영 설치, live host, FM 원장 진실성 또는 보호 VM strong의 PASS가 아니다.
