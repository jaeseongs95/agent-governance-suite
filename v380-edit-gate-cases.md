# AGS3-D-0005 편집 관문 검증 계획

- 기준: `a281139387af096e696f8d50cc089ad09e9291fc`, `codex/ags38-edit-gate`.
- 원 요구: 셸·스크립트로 바꾼 제품 파일도 workflow 없이 세 번째 파일 변경을 거부하는 기존 관문에서 센다.
- 공개 경계: 호스트 `PreToolUse` → `adaptHostInput` → `handleContinuityHook` → 실제 `SqliteContinuityStore`의 기존 관문. 테스트 호스트 입력은 합성이고 실제 호스트 실행 증거가 아니다.
- 원인: 어댑터는 편집 도구만 대상을 만들며 Codex matcher와 AGY runner도 shell을 continuity에 보내지 않는다. Claude matcher는 이미 Bash/PowerShell을 전달한다.
- 도구: 기존 Vitest, `node scripts/run-tests.mjs tests/mcp/ags38-edit-gate.test.ts`; TEST에서만 실행. 로컬 제품 시험 금지. 로컬은 tsc/lint/구문 검사만 허용.
- red: test-only SHA, green: 후속 fix SHA. 같은 테스트 파일·명령·환경을 사용한다. import/환경 실패를 결함 재현으로 세지 않는다.
- 실제 결과: 아래 동작 시험 전부 NOT_RUN. root TEST 실행 후 원시 결과와 exact SHA를 결속한다.

## 경계와 불변조건

1. 도구 이름 대신 직접 읽을 수 있는 파일쓰기 대상이 기존 관문에 들어가야 한다. 읽기 전용 셸과 단순 문자열 안 `>`는 편집이 아니다.
2. 파일 경로를 중복 제거하며, 기존 편집 도구·같은 파일 재편집·workflow 허용·관측된 child 정책을 바꾸지 않는다.
3. 임의 프로그램 실행, 동적 경로, 함수·alias·eval은 문자열만으로 실제 파일쓰기 집합을 알 수 없다. 제한된 구문 인식을 실제 filesystem write mediation으로 보고하지 않는다. 이 범위는 원 AC의 미충족으로 유지한다.
4. CS 적용 검토: 새로운 병렬 상태·캐시·I/O 자원 소유를 만들지 않는다. 기존 연속성 저장소의 파일 동일성/관문 집계 계약을 재사용하며 별도 임의 세 파일 집계기를 만들지 않는다. 일반 CS 카드의 그래프·순서·메모이제이션 의무는 이 변경에 해당하지 않는다.

## engineering-test-plan

공통 전제: Git 체크아웃 안의 합성 제품 경로를 사용하고 파일을 만들지 않는다. OS temp·사용자 note 면제는 기존 환경을 따른다. 관문은 실제 in-memory SQLite 연속성 저장소를 사용하며 호스트 실행·OS 권한 경계는 모의한다. 각 사례는 새 저장소로 시작한다.

| ID | 입력·절차 | 기대 결과·통과 기준 | 실제 |
| --- | --- | --- | --- |
| EG01 | Codex `exec_command.cmd`에 서로 다른 세 literal output redirect를 넣어 PreToolUse 실행 | 세 절대 경로가 추출되고 한 호출 전체를 사전 deny | NOT_RUN |
| EG02 | Claude `Bash.command`에서 세 파일 heredoc output redirect, heredoc 본문에는 가짜 `>` 포함 | 본문을 세지 않고 실제 redirect 세 경로만 추출, 사전 deny | NOT_RUN |
| EG03 | AGY의 canonical `Bash.CommandLine`에 세 output redirect | EG01과 같은 기존 관문 deny | NOT_RUN |
| EG04 | PowerShell `Set-Content -LiteralPath`, `Add-Content -Path`, `Out-File -FilePath`로 서로 다른 세 파일 | 세 대상 추출 및 사전 deny | NOT_RUN |
| EG05 | `printf 'a > fake.ts'`, `cat src/a.ts`, `git status --short`, 주석 안 redirect | editTargets 없음, 반복해도 다음 첫 파일 허용 | NOT_RUN |
| EG06 | 같은 파일 두 번 redirect 후 두 번째 고유 파일, 그다음 세 번째 고유 파일 | 앞선 두 파일 허용, 세 번째만 deny; 파일 도구와 같은 window | NOT_RUN |
| EG07 | 기존 `Write`/`apply_patch` 두 파일 뒤 shell redirect 세 번째 파일 | 공통 관문에서 deny | NOT_RUN |
| EG08 | 관측된 child의 두 file edit 뒤 직접 shell write 세 번째 파일 | 기존 parent window 집계 정책 유지, 추가 child 금지 없음 | NOT_RUN |
| EG09 | shell read-only와 PostToolUse | 편집 대상으로 분류하지 않음 | NOT_RUN |
| EG10 | 같은 공개 경로에서 활성 workflow의 writeTargets 안 세 shell 파일쓰기 | 기존 workflow scope 허용, scope 밖은 기존 관문 적용 | NOT_RUN |
| EG11 | `/dev/null`, fd duplication, 변수·command substitution 경로 | null sink·fd는 제품 파일 아님; 동적 경로를 가짜 literal 파일로 주장하지 않음 | NOT_RUN |
| EG12 | TEST 실제 Codex/Claude/AGY에서 raw native shell 호출·쓰기 전후 파일 확인, 세 파일 heredoc와 read-only 대조 | native hooks가 실제 실행 전 deny하여 파일 변화 0, 읽기 허용. 합성 adapter 통과로 대체하지 않음 | NOT_RUN |
| EG13 | 임의 Python/Node 스크립트, 변수·함수·alias로 세 파일 쓰기 | 현재 host write mediation 부재를 드러내는 별도 수용 공백. 이 시험 성공을 예측하지 않음 | NOT_RUN / 원 AC 공백 |

## engineering-test-proof / result

- 로컬 제품 red/green: NOT_RUN (금지 환경).
- TEST red/green/native: NOT_RUN (root 배정).
- test-only assertion 실패만 올바른 red이며 runner/환경 오류는 별도 기록한다.
- 공개 hook 등록까지 확인해야 하므로 adapter-only green은 EG12 통과가 아니다.
