# instruction-scope-resolver

지정한 경로에 적용되는 `AGENTS.md`와 `AGENTS.override.md`의 chain을 확인하는 독립 Codex 스킬입니다. 같은 디렉터리의 비어 있지 않은 override 대체 여부, 경로 정규화와 파일 checksum은 Node.js 스크립트가 계산합니다. 이 단계의 판정은 `ANALYSIS_REQUIRED`이며, 자연어 규칙의 활성·대체·충돌 여부는 원문 위치를 확인한 에이전트가 별도로 판정해야 합니다.

## 요구 환경

- Node.js 22 이상
- pnpm 10

## 직접 실행

요청은 stdin 또는 `--input <json-file>`로 전달합니다. 결과와 오류는 JSON으로 stdout에만 반환됩니다.

```bash
pnpm install --frozen-lockfile
node scripts/resolve-instruction-files.mjs < request.json
node scripts/resolve-instruction-files.mjs --input request.json
```

요청에는 `workspaceRoot`, 하나 이상의 `targets`, caller가 읽도록 허용한 `instructionRoots`와 `externalPolicyRefs`를 넣습니다. 존재하지 않는 예정 경로는 해당 target에 `mayNotExist: true`를 명시해야 합니다.

스크립트는 지침 파일을 수정하지 않습니다. 시스템·개발자·사용자 지침을 파일 시스템에서 찾지 않으며, 허용된 instruction root 밖의 파일도 읽지 않습니다.

## 검증

```bash
pnpm test
pnpm validate
python C:/path/to/skill-creator/scripts/quick_validate.py .
```

테스트는 실제 임시 workspace에서 root·nested·override·다중 대상·예정 경로·외부 탈출을 검사합니다. Windows 경로 비교는 드라이브 문자 대소문자와 구분자 경계를 별도로 검증합니다.

## Agent Governance Suite 편입

`integration/skill-descriptor.json`은 `instruction-scope-resolution` capability, bootstrap phase와 산출물 계약을 선언합니다. 독립 실행에는 MCP나 suite 패키지가 필요하지 않습니다. suite에는 검증을 마친 clean tag를 import해야 합니다.

## 라이선스

[MIT License](LICENSE)를 적용합니다.
