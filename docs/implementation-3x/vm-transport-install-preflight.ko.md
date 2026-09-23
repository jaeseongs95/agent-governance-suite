# VM transport 설치 preflight

V03-g의 `scripts/qualification/vm-transport-preflight.mjs`는 실제 설치 호스트에서 읽기 전용으로 실행한다. 관리자 설치, key/pin 변경, 유료 모델 호출, `CoreOperations` 실행은 하지 않는다. Windows와 Linux에서 각각 실행하고 결과를 분리한다.

## 입력과 실행

| 항목 | Windows | Linux |
| --- | --- | --- |
| VM producer key | `C:\ProgramData\flowmarshal\ags-producer-key.json` | `/etc/flowmarshal/ags-producer-key.json` |
| AGS operator policy | `C:\ProgramData\agent-governance-suite\vm-operator-policy.json` | `/etc/agent-governance-suite/vm-operator-policy.json` |
| 설치 후보 | `--vm-entry`, `--ags-entry`에 절대 경로의 `.exe`/`.com` 실행 launcher | 실행 bit가 있는 설치 launcher |
| exact 모델 조회 | `--observed-model`에 제품 관측의 정확한 모델 ID | 동일 |

고정 key/pin 경로는 인자로 바꿀 수 없다. 운영자가 별도 절차로 설치한 뒤 **VM control-plane 런타임 주체**로 실행한다. 출력의 `runtimePrincipal` SID/UID를 실제 서비스 주체와 대조한다. AGS 프로세스의 별도 pin 접근은 이후 제품 실행에서 확인한다. key 원문이나 private key를 콘솔·티켓·Git에 복사하지 않는다.

Windows PowerShell:

```powershell
node scripts/qualification/vm-transport-preflight.mjs --vm-entry 'C:\Program Files\FlowMarshal\<installed-launcher>.exe' --ags-entry 'C:\Program Files\AgentGovernanceSuite\<installed-launcher>.exe' --observed-model '<exact-product-observation>'
```

Linux shell:

```sh
node scripts/qualification/vm-transport-preflight.mjs --vm-entry /opt/flowmarshal/<installed-launcher> --ags-entry /opt/agent-governance-suite/<installed-launcher> --observed-model '<exact-product-observation>'
```

실제 경로와 ID를 대입한다. 인자가 없으면 JSON `BLOCKED_CONTRACT` 보고서를 낸다. 종료 코드 1은 선행 조건 부족, 2는 CLI 형식 오류다. JSON에 secret 원문은 없지만 설치 ID·key ID·runtime SID/UID가 포함될 수 있으므로 보관 위치를 제한한다.

## 판정 범위

스크립트는 key/pin·설치 후보와 각 부모 경로의 존재, regular file/디렉터리 형식, symlink·Windows reparse 여부, owner와 ACL/POSIX mode, 검사 중 변경 여부를 확인한다. 보호된 JSON은 1 MiB와 초과 판별용 1 byte까지만 읽는다. VM Ed25519 key의 공개키가 active pin과 일치하는지, installation/key/host ID 및 정책 버전이 일치하는지, pin build digest와 요청한 exact 모델 ID가 정책에서 `verified`인지 검사한다.

설치 후보의 보호된 경로와 현재 런타임 주체의 실행 권한을 확인하지만 **설치된 제품 build의 측정값과 실제 모델 관측은 확인하지 않는다.** Windows 후보의 소유자는 SYSTEM·Administrators·TrustedInstaller만 허용하고 실행 허용·거부 ACL을 확인한다. Linux 후보는 실행 bit와 현재 주체의 `X_OK`를 확인한다. 해석기나 wrapper를 launcher로 지정한 경우 제품 패키지 build의 별도 측정이 여전히 필요하다. `--observed-model`은 정책 조회용 입력일 뿐이다. `READY_FOR_QUALIFICATION`은 다음 제품 검증을 시작할 사전 조건만 충족한다는 뜻이며, `qualification.hostSupported`는 `unknown`, `qualification.observed`는 `false`다. `BLOCKED_CONTRACT`의 `missingInputs`는 파일·설치 후보·exact 모델 입력을 분리한다. `osExecution`은 다른 OS에서 별도 실행해야 함을 표시한다. 테스트 주입 경로는 `synthetic-fixture`와 `FIXTURE_ONLY`로 표시하며 운영 준비나 관측 근거가 아니다.

## V03-h/f 실제 qualification 인계

1. Windows와 Linux 각각의 설치 VM·AGS commit/build, 설치 방법, VM host identity와 build digest의 운영자 측정·정책 버전, key/pin 보호·회전·철회 근거를 확보한다. 정책의 `verified` 표로 설치 build 측정을 대체하지 않는다.
2. 각 OS에서 preflight JSON과 실행 주체를 기록한다. `BLOCKED_CONTRACT`이면 누락 입력을 해결한 뒤 다시 실행한다. secret 내용은 기록하지 않는다.
3. 실제 VM `CoreOperations` prepared dispatch로 AGS 제품 stdio에 `vm/hello` → `vm/reserve_dispatch` → 예약 ID의 `tools/call`을 실행한다. AGS pending ledger·SDK JSON-RPC request ID·signed receipt·nonce claim을 독립 대조한다.
4. A/B 선점·sideband 복제, 다른 call/session/instance, epoch/restart, stage/null attempt, 인증 실패·pin 철회, Core crash/restart의 effect-unknown 및 명시적 no-effect, 동시 producer/claim을 분리 검증한다. 실제 Windows/Linux 제품 결과와 합성 fixture 결과를 별도 표기한다.

이 preflight 성공은 V03-f 종단 간 검증이나 V05 native admission 완료를 뜻하지 않는다.
