# 로컬 Cloud launch 준비 기록 (claude-final-1, d4a4b6b2)

이 폴더는 **로컬 PC에서 Cloud 세션을 띄우기까지의 준비 로그**다. Cloud job 결과와는 별개다. 1·2차 시도에서는 Cloud 세션이 만들어지지 않았다(ListAgents 05:39Z·05:41Z에 새 cloud 항목 없음). 3차에서 `session_019jWevBCENVcC2gGbN9K5rA`가 만들어졌다.

## 준비 (05:36Z 전후)
- 일회용 clone: `<SCRATCH>/cs280final/repo`
  - `git -c core.autocrlf=false clone -q --no-local --no-checkout <ags-evidence>/repo repo`
  - `git config core.autocrlf false`
  - `git bundle verify <private>/candidate-after-4ba4755.bundle`
  - `git fetch <bundle> refs/heads/codex/release-candidate-2.8.0:refs/heads/claude/cs280-release-final`
  - `git checkout claude/cs280-release-final`, `git remote remove origin`
  - 그 밖의 로컬 branch는 `git branch -D`로 지웠다. 일회용 clone 안의 일이다.
- 관측값
  - HEAD `b7341d3e6636b79217b1f3d37d7a5014fcbf47be`, tree `5648f76558e923244cedf78a8263892d00df8299`
  - dirty 0, remotes 0, commits 318, shallow false, base 4ba4 조상
  - base→final `git diff --binary --full-index` sha256 `9f7117cd88cfc5c71b6eef06d52f8f584cf87630cb785b0c15a0089848d1062a`
- 지시문 `cloud-prompt-final.md` sha256 `bd4f03a302d5a65793f12e8c975d19b6b955a0d697c59b4cefb92610fa92e1f0`

## 1차 (05:37:57Z)
- 실행: PowerShell 도구로 `Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList -NoProfile,-ExecutionPolicy,Bypass,-File,launch-cloud.ps1`(pid 35036)
- 당시 스크립트는 `& claude.exe --cloud $arg 2>&1 | Tee-Object -FilePath launch-out.log`였다. 2차 전에 이 줄을 Start-Transcript 방식으로 고쳤다. 1차 당시 스크립트 파일은 따로 보존하지 않았고, 바뀐 줄은 이 문서에 적은 그대로다.
- 결과: claude.exe가 바로 exit 1로 정상 종료했다. 메시지는 `Error: --cloud requires an interactive terminal. Non-interactive invocations (piped stdout, --init-only, --sdk-url) run locally and would silently ignore --cloud. Drop --cloud, or run from a TTY.`
- launcher 기록은 `launch-attempt1.log`(exit 1)에 있다. Cloud 세션은 0이다.
- **원본 손실:** 1차 `launch-out.log`는 2차 실행 직전에 내가 `Remove-Item`으로 지웠다. 위 오류 문구는 그 파일이 지워지기 전 PowerShell 도구 결과에 표시된 원문을 옮긴 것이다. 원 bytes는 NOT_VERIFIABLE이다.

## 2차 (05:38:49Z)
- 실행: 같은 Hidden 방식(pid 7792). pipe를 빼고 Start-Transcript를 썼다.
- 자식 프로세스: conhost.exe 31800, claude.exe 26764(05:38:50 시작).
- 05:39Z와 05:40Z에 확인했을 때도 살아 있었다. ListAgents에는 새 cloud 세션이 없었다.
- **종료 (지시 이탈):** 05:40:55Z에 PowerShell 도구로 아래 명령을 실행했다.

  ```powershell
  $c = Get-CimInstance Win32_Process -Filter "ProcessId=26764"
  "target: ..."
  if ($c -and $c.ParentProcessId -eq 7792) { Stop-Process -Id 26764 -Confirm:$false }
  ```

  - 출력은 `target: 26764 claude.exe parent 7792`였다.
  - 이것은 강제 종료(Stop-Process)다. 리드 브리프 `2c9a9614`의 "강제종료 0" 지시에서 벗어난 행동이다. 대상은 내가 띄운 launcher의 자식 claude.exe 한 개뿐이었다.
  - launcher 기록 종료 코드는 `exit -1 end 2026-10-06T05:40:55.1075623Z`다(`launch-attempt2.log`).
  - transcript(`launch-attempt2-transcript.log`)에서 대기 화면이 workspace trust 확인("Quick safety check ... > No, exit")이었음을 사후에 확인했다.
  - 다른 프로세스에 대한 영향은 관측 범위에서 없다. 관측 범위는 부모 PID 확인과 단일 PID 종료다.
  - Cloud 세션은 0이다.
- 이후 원칙: 정상 종료만 한다.

## 3차 (05:41:04Z)
- 실행: 같은 스크립트를 `-WindowStyle Normal`로 띄웠다(launcher pid 22052, claude.exe 9364).
- 사용자가 workspace trust를 확인했다.
- 05:45:42Z exit 0: `Created cloud session: CS 2.8.0 최종 후보 Claude Cloud 검증`, `session_019jWevBCENVcC2gGbN9K5rA`
- 기록은 `launch.log`, `launch-transcript.log`에 있다.

## 변경 범위 (관측 범위)
- launcher는 해당 process 안에서만 `CLAUDECODE`와 `CLAUDE_CODE_*` 8개를 unset하고 `CCR_FORCE_BUNDLE=1`을 설정했다.
- 다음은 바꾸지 않았다(내 명령 기준).
  - source: 원 후보 worktree와 private repo
  - 키
  - 전역·프로젝트 settings와 permissions
  - 운영 장부
- **미관측:** 3차에서 사용자가 승인한 workspace trust는 Claude Code가 사용자 설정(예: `~/.claude.json`의 프로젝트 trust 항목)에 기록했을 수 있다. 나는 그 파일을 읽거나 확인하지 않았다.
