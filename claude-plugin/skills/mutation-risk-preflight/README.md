# mutation-risk-preflight

삭제, 배포, 게시, migration, 권한·결제·전역 설정 변경 전에 대상과 승인, 영향 범위, 복구 근거를 확인하는 Codex 스킬입니다. 실행하려는 행동과 대상의 digest를 만들고, 실제 실행 직전에 같은 intent인지 다시 검증할 수 있습니다.

이 스킬은 mutation을 수행하지 않습니다. READY는 사전점검 항목이 충족됐다는 뜻이며 사용자 승인이나 실행 권한을 새로 부여하지 않습니다. 변경을 마친 뒤의 완료·병합·릴리스 판단은 고정된 최종 결과를 대상으로 독립 감사자가 따로 수행해야 합니다.

## 요구 사항

- Node.js 22 이상
- pnpm 10

Agent Governance Suite와 MCP는 직접 실행에 필요하지 않습니다. suite의 TaskEnvelope.v1은 contracts/upstream/에 고정 snapshot으로 들어 있으며 checksum을 확인한 뒤 사용합니다.

## 직접 실행

~~~powershell
pnpm install --frozen-lockfile
node scripts/evaluate-preflight.mjs --input intent.json > report.json
~~~

실행 직전 재검증 입력은 report, 현재 intent, verificationTime을 담은 JSON입니다.

~~~powershell
node scripts/verify-preflight-receipt.mjs --input verification.json
~~~

두 CLI 모두 stdin 입력을 지원하고 stdout에는 JSON만 씁니다. READY 또는 유효한 receipt는 종료 코드 0, 나머지는 종료 코드 2입니다.

## 판정 범위

- READY: 대상, 범위, 권한, 필요한 승인, 현재 fingerprint와 복구 근거가 일치합니다.
- NEEDS_INPUT: 현재 상태 근거가 부족합니다.
- NEEDS_APPROVAL: 승인이 없거나 만료됐거나 현재 작업과 맞지 않습니다.
- NEEDS_REDESIGN: 복구나 영향 범위를 다시 설계해야 합니다.
- BLOCKED: 대상이 광범위하거나 scope·authorization과 충돌합니다.

C:\\, filesystem root, UNC share root, ~, glob과 해석되지 않은 환경변수는 READY가 될 수 없습니다.

## 검증

~~~powershell
pnpm lint
pnpm test
~~~

테스트는 실제 mutation API나 filesystem 변경 함수를 호출하지 않는 불변조건, Windows 경로, receipt 변조·연장과 모든 invalidation 입력의 변경, upstream checksum과 독립 실행을 확인합니다.

## 라이선스

MIT
