# change-scope-guardian

작업을 시작하기 전의 Git 상태와 현재 변경을 비교해 범위 밖 수정과 기존 변경 침범을 찾는 Codex 스킬입니다. 파일을 되돌리거나 수정하지 않으며 경로, 상태와 checksum만 다룹니다.

## 요구 사항

- Node.js 22 이상
- Git
- pnpm 11 이상과 `pnpm install`로 설치한 런타임 의존성

## 직접 실행

첫 변경 전에 baseline을 만듭니다.

```powershell
node scripts/capture-workspace-baseline.mjs request.json > baseline.json
```

구현 뒤에는 저장소, task envelope, baseline과 외부에서 동결해 둔 `baselineArtifactDigest`를 담은 요청을 검증합니다. 이 digest가 없거나 baseline의 값과 다르면 비교하지 않습니다.

```powershell
node scripts/compare-change-scope.mjs verify-request.json > report.json
```

저장된 baseline이나 report의 checksum과 판정 일관성은 다음 명령으로 확인합니다. 입력 JSON은 `artifact`와 신뢰 경계 밖에서 동결한 `expectedArtifactDigest`를 담아야 합니다. artifact 안의 checksum을 읽어서 같은 입력에 복사하는 방식은 변조를 막지 못합니다.

```powershell
node scripts/validate-report.mjs report.json
```

입력 파일을 생략하면 stdin에서 JSON을 읽습니다. 두 명령 모두 저장소와 파일을 변경하지 않습니다.

## 개발

```powershell
pnpm test
pnpm validate
```

`integration/skill-descriptor.json`은 추후 Agent Governance Suite 편입에만 사용합니다. 이 디렉터리를 제거해도 직접 실행과 테스트는 동작합니다.
