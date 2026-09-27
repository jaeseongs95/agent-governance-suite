# V06-b2a-r1 Windows 새 package epoch staging 관측

`epoch-9542e833/`은 2026-09-27 04:01Z에 Windows x64 일반 사용자 token으로 `scripts/qualification/v06-b2a-windows-stage.mjs`를 실행해 만든 새 epoch 결과다. 상태 `PREPARED`는 사용자 쓰기 가능 격리 staging의 한 시점 검사 결과이며 보호 설치, DLL/loader closure, 운영 host 적격성을 뜻하지 않는다. 기존 `v06-b2a/prepared.json`(manifest `c512498a…`, release `d742360a…`)은 과거 epoch 기록으로 보존하며, 현재 producer의 `verifyPreparedEvidence`는 이를 `stale package epoch`로 거절한다.

## epoch 결속

- source base: `codex/v260-semantic-decision-layer` 통합 commit `ffec7c91dfae2389e8b95f47616644e0b6729f96`, tree `2a5de4fc5d0f1ca192f5b27bad5583acbb8ef396`, `pnpm bundle:check` exit 0.
- AGS `host-integration.json` SHA-256 `9542e833bab74614eb5196b37702f082f567381bc16cf84df1171917d2405fed`, artifact 180개. staging package의 정확한 파일 181개(manifest 포함)와 각 SHA-256은 `epoch.json`의 `packageFiles`에 있다.
- producer: staging 실행 시점의 script SHA-256과 `git diff HEAD` digest를 `epoch.json`의 `producer`에 기록했다. 최종 commit은 인계 문서에 기록한다.
- release ID(V06-b1 규칙 재계산): `0812f2e76ecf8acbbef71415fead36363db3e39f26938e11cf2fa5f1365f8231`, `intendedInstallRoot` `C:\ProgramData\agent-governance-suite\protected-runtime\0812f2e7…8231`.

## Node 원자료 재검증

V06-b2a가 받은 공식 입력 네 개를 새 입력 폴더로 복사해 hash를 대조한 뒤 원 bytes로 다시 검증했다. 과거 `prepared.json`의 hash 일치만으로 검증을 생략하지 않았다.

- `node-v24.19.0-win-x64.zip` `57f71ab3…4c73`, `SHASUMS256.txt` `be0629ee…31c0`, `SHASUMS256.txt.sig` `801534e2…e630`, keyring `610b8d24…ee00`(release-keys commit `481637f8…`).
- `gpgv-status.txt`는 staging 출력에서 다시 실행한 `gpgv --status-fd 1` 원출력이다. `VALIDSIG 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`.
- 도구 pin: `C:/Program Files/Git/usr/bin/gpgv.exe` `f4d13204…427b`, `C:/Windows/System32/tar.exe` `4e598a8c…e379`. 추출 `node.exe` `3602f2bb…0237`, `--version` `v24.19.0`.

## 폐기한 초안

HOLD 전에 오래된 manifest `0a8b7b87…`(`contracts/user-approval-channel.v1.schema.json` 누락)로 한 번 staging했다. 그 출력(`%TEMP%\ags-v06-b2a-r1-stage-20260927T0355Z`)은 지우지 않았지만 증거로 쓰지 않으며 저장소에 넣지 않았다.

## 한계

staging 경로와 입력 폴더는 사용자 쓰기 가능하므로 후속 V06-b2b는 이 JSON을 신뢰 anchor로 쓰지 말고, `epoch.json`에 고정한 경로·hash로 반입한 bytes를 신뢰 경로에서 독립 재검증해야 한다.
