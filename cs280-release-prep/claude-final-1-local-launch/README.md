# claude-final-1 로컬 Cloud launch 준비 기록 (공개본)

- 작성: Claude 테스트 담당 세션 d4a4b6b2
- 이 폴더는 **로컬 PC에서 Cloud 세션을 띄우기까지의 준비 로그**다.
  - Cloud job(`session_019jWevBCENVcC2gGbN9K5rA`)이 받은 pin이나 실제 A/B/C 테스트의 근거가 아니다. 그 결과는 `cs280-release-prep/claude-final-1/`에 따로 올라온다.
- 원본 bytes(`original/**`)는 공개하지 않는다. 로컬에만 보존한다.

## 파일
- `redacted/` 8개: launcher 스크립트, Cloud 지시문, 경위 기록(`launch-notes.md`), 1~3차 launcher 로그와 transcript의 공개본
- `MANIFEST.tsv`: 파일마다 원본 sha256 → 1단계 제거본 sha256 → 공개본 sha256과 단계별 제거 건수. 원본 hash는 출처 대조용이다.
- `MANIFEST.stage1.tsv`: root가 RO로 대조한 1단계 MANIFEST 원문. 로컬 self sha256은 `88e790f670d70680c11b064e74d7b07b37fcb6b0077e8f735bf372450aa4d83a`다.
- `residual.tsv`: 공개본에 대한 잔여 패턴 검사 결과(파일×패턴별 hit 수)
- `SHA256SUMS`: 이 폴더의 공개 파일만 대상으로 한다(자기 자신 제외). `original/**`은 참조하지 않는다.
  - 로컬 원 SHA256SUMS(self `4e4016a23f77af5fbf31a92a87e505f1bd010cbd9c8fc7418274e18435e9f51b`, 18줄)는 원본 8개를 포함한다. 그래서 공개하지 않고 바꾸지 않은 채 로컬에 보존한다.

## 제거 내역
- **1단계** (root RO 대조 완료): Windows 홈 경로를 `<USER>`로, PC 이름을 `<PC>`로, 이메일을 `<EMAIL>`로, 계정명을 `<USER>`로 바꿨다.
  - 건수: windows-home 6, pc-name 6, account-name 4, email 0
- **2단계** (공개 직전 추가): 세션 scratchpad 경로 prefix를 `<SCRATCH>`로 바꿨다. 이 prefix에는 로컬 프로젝트 폴더명이 들어 있다.
  - 건수: launch-attempt1.log 1, launch-attempt2.log 1, launch-attempt2-transcript.log 2, launch.log 1, launch-transcript.log 1
  - 이 단계 때문에 해당 5개 파일의 공개본 hash는 root가 대조한 1단계 제거본 hash와 다르다. 대응 관계는 `MANIFEST.tsv`에 있다.
- 공개본 잔여 검사 결과는 모두 0이다. 검사 패턴은 home 경로, PC 이름, 이메일, 계정명, 프로젝트 폴더, token 형태다.
- transcript 2개에는 TUI 출력의 NUL과 제어 문자가 그대로 남아 있다. 내용은 바꾸지 않았다.

## 한계 (숨기지 않음)
- **1차 출력 파일 손실:** 1차 `launch-out.log`는 2차 실행 직전에 내가 지웠다. 원 bytes는 NOT_VERIFIABLE이다.
  - `launch-notes.md`의 오류 문구는 당시 도구 결과에 표시된 원문을 옮긴 것이다. 복원본이 아니다.
- **1차 스크립트 미보존:** 1차 당시 launcher(Tee-Object pipe 버전)는 따로 보존하지 않았다. 바뀐 줄은 `launch-notes.md`에 적은 그대로다.
- **2차 강제 종료 1건:** 2차 claude.exe(PID 26764)를 `Stop-Process`로 종료했다. 리드 지시 "강제종료 0"에서 벗어난 행동이다. 경위는 `launch-notes.md`에 있다.
- **미관측:** 3차에서 사용자가 승인한 workspace trust는 사용자 설정 파일에 기록됐을 수 있다. 그 파일은 확인하지 않았다.

## 환경·기간
- 환경: 로컬 Windows 11 PC, Windows PowerShell 5.1 launcher, Claude Code CLI(`claude.exe --cloud`), `CCR_FORCE_BUNDLE=1`
- 일회용 clone: origin 제거, HEAD `b7341d3e6636b79217b1f3d37d7a5014fcbf47be`, tree `5648f76558e923244cedf78a8263892d00df8299`, dirty 0
  - 이 clone은 이번 launch를 위해 새로 만들었다. 재사용하지 않았다.
- 기간: 2026-10-06 05:36Z(clone 준비)부터 05:45:42Z(3차 exit 0, Cloud 세션 생성)까지. 로그는 이 시점까지만 담는다.
- 1단계 패키징 이후 원본은 바꾸지 않았다.
