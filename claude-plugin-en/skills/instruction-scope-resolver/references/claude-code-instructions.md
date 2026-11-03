# Claude Code 지침 파일 확인

Claude Code는 `AGENTS.md`를 직접 읽지 않고 `CLAUDE.md` 계층을 읽는다. 저장소가 `AGENTS.md`를 쓰면 `CLAUDE.md`의 `@AGENTS.md` import로 연결됐는지 확인한다. 근거: [Claude Code memory 문서](https://code.claude.com/docs/en/memory).

## 확인할 위치

탐색은 `workspaceRoot` 내부의 허용된 `instructionRoots` 안으로만 한정한다. 시스템·조직 정책과 사용자 전역 지침(`~/.claude/CLAUDE.md`, `~/.claude/rules/**/*.md` 등)은 파일 시스템에서 직접 탐색하지 않으며, 호출자가 이미 제공한 참조만 `externalPolicyRefs`로 기록한다. 허용된 root 안에서 파일이 없으면 없다고 기록한다.

1. 허용된 `instructionRoots` 안의 작업 디렉터리와 상위 디렉터리에 있는 `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/**/*.md`
2. 대상 경로가 허용된 `instructionRoots`의 하위 디렉터리에 있으면 그 경로까지의 `CLAUDE.md`·`CLAUDE.local.md`. 이 파일들은 시작할 때가 아니라 해당 디렉터리의 파일을 읽을 때 로드된다.
3. `paths` frontmatter가 있는 rule은 대상 경로가 glob과 맞을 때만 적용한다.

## 해석 규칙

- 파일끼리 덮어쓰지 않고 모두 이어 붙여 컨텍스트에 넣는다. 루트 쪽 파일이 먼저, 대상 경로에 가까운 파일이 나중에 온다. 같은 디렉터리에서는 `CLAUDE.local.md`가 `CLAUDE.md` 뒤에 온다.
- `@path` import는 import한 파일 기준 상대 경로로 풀고, 최대 네 단계까지 따라간다. 코드 스팬과 코드 블록 안의 `@path`는 import가 아니다. 허용된 `instructionRoots` 밖을 가리키는 `@path` import나 외부 symlink·junction은 따라가지 않고 확인 한계로 기록한다.
- `claudeMdExcludes` 설정에 걸린 파일은 로드되지 않는다. 설정을 읽을 수 없으면 제외 여부를 모른다고 기록한다.
- HTML 블록 주석은 컨텍스트에 들어가지 않으므로 규칙으로 취급하지 않는다.
- 두 파일의 지시가 충돌해도 Claude Code가 자동으로 해소하지 않는다. 더 가까운 파일이 이긴다고 단정하지 말고 [conflict-classification.md](conflict-classification.md)에 따라 `unresolvedConflicts`에 남긴다.

## 기록

- 확인한 파일마다 경로, 존재 여부, 로드 시점(시작 시·하위 디렉터리 접근 시·paths 일치 시)을 `findings`에 적는다.
- 허용된 `instructionRoots` 밖의 전역·조직 경로를 탐색하지 않은 것은 미완료(`ANALYSIS_REQUIRED`)나 `BLOCKED` 사유가 아니다. 허용된 root 안의 확인 한계만 기록하되, 그 지침이 작업 권한이나 완료 조건을 바꿀 수 있으면 `NEEDS_INPUT`으로 반환한다.
