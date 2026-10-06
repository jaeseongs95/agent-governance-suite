# 관측하지 못했거나 제한이 있는 항목 (claude-final-1)

## 환경
- **environment ID:** unknown. 관측 출처가 없다. `CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE=cloud_default`와 session ID만 관측했다.
- **PID 1의 고아 프로세스 회수:** unknown. `/process_api --firecracker-init`이 PID 1이지만 회수 동작은 시험하지 않았다. 시작 snapshot에 zombie 행은 0개다.
- **이 세션의 실제 모델·effort:** unknown. 하위 세션은 stream-json init 기준 `claude-sonnet-5-5`, hook 관측 effort `high`(CLI `--effort high`)다.
- **Cloud provisioning·setup 로그:** 세션 안에 접근 경로가 없다.

## 실행 편차
- **seq 07 vitest:** 브리프 argv(`pnpm test -- --reporter…`)는 pnpm 11이 `--`를 그대로 넘겨 vitest가 reporter 인자를 무시했다. 결과(916/5/0)는 보존했다. 사례 ID는 `--`를 뺀 seq 08 1회 재실행으로 얻었다. 같은 입력의 반복은 아니다.
- **C2 R24 1차(run-TASK-REPO-INVENTORY-3):** 준비 스크립트의 template이 `evidence: []`여서 `MISSING_EVIDENCE`로 실패했다. 제품 결함이 아니라 입력 결함이다. 실패는 그대로 보존했다(run은 running rev 0으로 남음). evidence 항목 하나를 추가한 R24B로 1회 다시 실행해 passed를 얻었다.
- **F1B 재실행:** F1의 `check-stage-bundle` 실제 실행을 프로세스 수준으로 증명하려고 strace(execve, openat)를 걸고 같은 형태의 입력으로 1회 더 실행했다.

## 미충족 또는 관측 불가
- **plan에서 bootstrap 25 선택:** 관측되지 않았다. F1 plan은 phaseOrder 67 stage 하나만 선택했다. 25는 입력 바인딩 출처 `bootstrap:cs-constraint-report`로만 나타난다.
- **R24B finalize에서 inventory.json 재읽기:** strace에서 관측되지 않았다. 06:00:44 record 때만 읽었다. CS stage(F1B)는 record와 finalize 모두에서 다시 읽었다.
- **NEG 거절 지점:** finalize는 `check-stage-bundle` 실행 전에 outputFile digest 검사(`INTEGRITY_FAILED`)에서 거절했다. NEG run에는 strace를 걸지 않았다.
- **하위 세션 신원:** 두 하위 세션 모두 부모 세션과 같은 session_id(`15064980-…`)를 보고했다. child 2에서 `CLAUDE_CODE_SESSION_ID`를 unset해도 바뀌지 않았다. 출처는 확인하지 못했다. isolated config의 transcript 파일 하나에 두 세션이 함께 기록됐다. actorId(`claude-code:session-8276…`)는 이 session ID에서 나왔다.
- **MCP 실행 경로:** `claude mcp list`와 strace 모두 설치 캐시가 아니라 `readFromFolder` 복사본(`$ST/claude-clean/mkt/claude-plugin`)의 server와 hook을 실행했다. 두 경로의 파일 463개는 해시가 모두 같다.
- **인증 출처:** `auth status`는 loggedIn=true, authMethod=oauth_token이다. isolated config에 credential 파일은 없다. CLI가 컨테이너 런타임에서 인증을 해석했다. 정확한 출처 변수는 공개 기록에 남기지 않는다.

## 기존 근거 결속 / 다른 담당
- `runtime:check`, `skills:context-check`: `cs280-claude-cloud/20261006T033701Z/08`, `13`에 결속했다(제품 bytes 변경 0).
- `validate:official`: 담당자가 따로 있다(Codex Cloud `01a10ee6`). 실행하지 않았다.

## Transcript
- 이 세션 transcript(`~/.claude/projects/-home-user-repo/*.jsonl`)는 동결 cutoff 시점까지의 사본을 redaction 후 `session-transcript/`에 넣었다. cutoff 뒤의 기록(redaction, MANIFEST, commit, push)은 들어 있지 않다. 그 원 로그는 `worklog-append-1/`에 한 번만 추가한다.
- 하위 세션 transcript: `C2/child-transcripts/`(isolated config의 projects 사본)와 `C2/child*-stream.jsonl`(stream-json stdout).
- system prompt와 harness가 주입한 context는 jsonl에 그대로 기록되지 않는 부분이 있다. 그 부분은 제공되지 않는다.

## 제외한 것
- MCP SQLite DB와 trust DB 원본, HMAC key: 비밀 키가 들어 있을 수 있어 넣지 않았다. 대신 `C2/mcp-db-extract*.json`에 ID, state, digest, actor만 추출했다.
- `claude-clean/` 복사본과 설치 캐시: 파일 목록과 sha256만 넣었다(`B/*.sha256`, `C1/installcache.sha256`).
- pnpm store, node_modules, corepack 캐시.
- 런타임 비밀값 대조 목록: repo 밖 임시 파일에만 두었고 사용 직후 삭제했다.
