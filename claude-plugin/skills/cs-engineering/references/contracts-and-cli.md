# 계약과 CLI

## 역할
에이전트는 사실 확인·규칙 선택·제약 도출·근거 해석을 수행한다. 이 CLI는 그 판단을
자동으로 생성하지 않는다. 에이전트가 만든 보고서의 구조, 교차 참조, 동결 조건과
실제 파일 digest를 검증한다. `READY`는 구현 준비 상태이고 제품의 검증 통과가 아니다.

## 파일 흐름
`request.json → constraints.json → task.json + policy.json + binding.json →
 candidate.json + 실제 검증 근거 → review.json → check-bundle`

| 파일 | 핵심 내용 |
| --- | --- |
| request | 목표, 출처 파일, 관측한 운영 사실, 출처 묶음 digest |
| constraints | 선택 규칙, 사실/가정, 불변조건/설계 선택, 실패 판별 기준과 검증 의무 |
| task | AGS가 동결한 기존 TaskEnvelope.v1. 이 팩은 임의 필드를 추가하지 않는다. |
| policy | observe/enforce, draft 허용 여부, 정책 ID/버전 |
| binding | request·constraints·task·정책·지식 팩의 digest와 필수 의무 ID |
| candidate | 범위 설명과 정렬된 대상 파일의 원시 SHA-256 |
| review | 조건별 판정, 의무별 실행 상태, 같은 후보의 근거, 재계산되는 종합 판정 |

`contracts/*.schema.json`이 각 필드의 정본이다. 모든 객체는 정의되지 않은 필드를
거부한다. 같은 종류의 ID 중복, 없는 참조, 필수 조건의 검증 누락도 거부한다.
사용자 사실과 확인되지 않은 가정의 ID는 서로 충돌해서는 안 된다.

## digest 규칙
원시 파일 참조의 `digest`는 **파일의 실제 bytes**에 대한 `sha256:<64hex>`다.
JSON 객체의 `requestDigest`, `taskDigest`, `constraintReportDigest`, `policyDigest`,
`candidateDigest`는 키를 정렬한 UTF-8 canonical JSON의 digest다. 배열 순서는 보존한다.
두 종류를 혼용하지 않는다. JSON 형식/공백 변경은 원시 파일 digest에 영향을 준다.
`knowledgePackDigest`는 `assets/knowledge-lock.json` 객체의 canonical digest이며
그 안에 카드·참고 자료·출처·계약 파일의 원시 digest가 결속된다.

이 canonical 형식은 이 패키지의 Node 구현 계약이다. 임의 언어의 JSON 출력이나
범용 JCS 구현과 같다고 가정하지 말고 `hashJson()`을 사용하라. NaN·Infinity·비JSON값은 거부한다.
TaskEnvelope 자체의 유효성과 정책의 권한은 기존 AGS/호스트가 먼저 검증해야 한다.

## 명령
경로는 모두 `--root` 아래 상대 경로다. `..`, 절대경로, symlink, Windows 장치명,
특수 파일, 상한을 넘는 파일을 허용하지 않는다. 기본 파일 상한은 1 MiB다.
이 CLI는 후보 코드를 import하거나 실행하지 않고 URL도 가져오지 않는다.

```text
node <SKILL_DIR>/scripts/validate.mjs self-check
node <SKILL_DIR>/scripts/validate.mjs validate-request --root <WORK> --input request.json
node <SKILL_DIR>/scripts/validate.mjs validate-constraints --root <WORK> --input constraints.json --request request.json
node <SKILL_DIR>/scripts/validate.mjs validate-review --root <WORK> --input review.json --constraint constraints.json --candidate candidate.json
node <SKILL_DIR>/scripts/validate.mjs check-bundle --root <WORK> --binding binding.json --task task.json --policy policy.json --review review.json --candidate candidate.json
```

`validate-review`는 JSON 사이의 일관성만 확인한다. 원시 근거 파일은 `check-bundle`에서
읽는다. 구조 일치만 확인한 결과를 원시 근거 확인 완료로 보고하지 않는다.
`check-bundle`의 `canProceedUnderSuppliedPolicy`는 제출된 정책에 따른 계산값이다.
작업 승인 또는 신뢰할 수 있는 호스트의 정책 발급 증명이 아니다.

종료 코드: 0=해당 검사 완료, 2=입력/참조/무결성 오류, 3=FAIL, 4=BLOCKED.
observe여도 보고서가 FAIL/BLOCKED이면 해당 종료 코드를 유지한다. 관찰 모드는
오류를 PASS로 바꾸는 모드가 아니라 상위 호스트의 진행 정책을 분리하는 모드다.
`provider-result`는 보고서를 AGS ProviderResult.v1 형태로 감싼다.

## 검증 상태
`SATISFIED`에는 동결된 방법·환경의 실행 PASS와 연결된 원시 근거가 필요하다.
필수 조건에 대응하는 의무가 NOT_RUN/UNSUPPORTED이면 UNKNOWN으로 기록하고 BLOCKED다.
FAIL을 UNVERIFIED로 감추지 않는다. 필수 조건의 NOT_APPLICABLE은 기존 계약에서는
BLOCKED이며 사후 삭제 대신 승인된 재계약을 거친다. 권고의 실패는 필수 실패와 구분한다.

## 신뢰 경계
검증기는 없는 파일, 바뀐 bytes, 다른 후보, 잘못된 연결을 찾는다. 근거 파일 자체가
정직하게 생성됐는지, 검토자의 신원이 진짜인지, 테스트가 요구 의미를 충분히
검증하는지는 전문 검토·호스트 실행 관측·독립 감사의 책임이다.
공격자가 루트와 모든 입력을 함께 바꿀 수 있는 동일 OS 권한의 상황을 격리하지 않는다.
`ags-adapter.mjs`는 trustedContext의 고정 digest와 대조하지만 그 context를 인증하지 않는다.

## AGS/독립 실행
AGS 트리의 `runtime/schema-validation.mjs`가 있으면 그 Ajv2020을 사용한다. 존재하지만
불러올 수 없으면 실패한다. 몰래 축소 검증기로 우회하지 않는다.
독립 배포에서는 번들에 포함된 **제한된 closed-schema subset 검사기**를 사용한다.
이 검사기는 이 팩이 실제 쓰는 키워드만 지원하며 미지원 키워드는 거부한다.
범용 JSON Schema 엔진으로 소개하거나 다른 스키마를 임의 로딩하지 않는다.
