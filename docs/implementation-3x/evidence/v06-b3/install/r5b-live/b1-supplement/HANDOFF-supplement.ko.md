# TASK_V06-b3b-r5b B1 보완 handoff

- **근거**: 총괄 GO `claude-main-r5b-b1-supplement-go-to-devlead-20260926-01`. 통합 감사 df73d3b5가 FAIL(근거 보완형)을 냈고, 그중 B1을 보완한다.
- **B1**: 설치 driver가 installer·release·stage 모듈을 `/home/user/agent-governance-suite/scripts/qualification/`에서 import했다. 그런데 그 경로 사슬의 owner·mode·ctime, 비root 주체, 적재 근거가 원시 근거에 없었다.
- **범위**: 읽기 전용 보완이다. 재설치, `/usr`·`/root` 쓰기, installer·설치 node 실행을 하지 않았다. 새 파일은 이 하위 디렉터리에만 두고, 기존 r5b-live 파일은 바꾸지 않았다.
- **writer**: `cse_01PRna2jKCs5EdTv8Rwv3j83`(AREA 1910c26e)
- **boot**: 이번 관측은 `46235632-74ef-405f-af23-c9c001a2fd9b`(12:12:05Z~)에서 했다. 설치 boot `701c96a7`과 다르다.

## 설치 주장 (정정 표기)

installer 모듈(c7b3414e = 8bb6e689 = 4866e455) API 1회 실행, 진입점 driver 38905e19.
CLI를 실행했다고 주장하지 않는다. CLI는 `--parent-manifest` 없이 인수 검사 단계에서 exit 1로 거절됐다(install.txt 1절).

driver 출력에는 CLI의 limitations 필드가 없다. CLI가 내는 네 제한은 r5b 결과에 그대로 적용된다.
- candidate-host-only
- not-production-host-qualified
- no-fresh-disk-or-secure-erase-claim
- no-loader-closure-measurement

## 당시 근거 (설치 boot 701c96a7, strace.txt sha256 07597bba…7428, strace-excerpt.txt)

- 설치 node pid 2219가 연 코드 파일은 네 개뿐이다. 각각 1회, `O_RDONLY|O_CLOEXEC`로 열었다.
  - `/root/r5a/r5b-run/driver.mjs`
  - `…/scripts/qualification/v06-b3-linux-install.mjs`
  - `…/scripts/qualification/v06-b3-linux-release.mjs`
  - `…/scripts/qualification/v06-b2a-windows-stage.mjs`
- 2219가 연 공유 라이브러리는 node DT_NEEDED 6개와 정확히 같다.
- 다음 openat은 0건이다: `node_modules`, `/etc/ld.so.preload`, 세 모듈 밖의 `/home` 파일.
  - access·stat·read·execve는 strace 기록 대상이 아니었다.
- 자식 프로세스는 gpgv(2226), tar(2227), xz(2228), 검증 node `--version`(2229)이다. 각자의 시스템 라이브러리만 열었다.
- 설치 대상 openat 851건은 모두 pid 2219다.

## 사후 관측 (boot 46235632, observed-post.txt, 보조 근거)

- 경로 사슬 6개(`/`, `/home`, `/home/user`, repo, `scripts`, `scripts/qualification`)는 모두 root:root 755다. g/o 쓰기와 sticky bit는 없다.
  - `ls -ld`에 `+` 표시가 없고, listxattr에서 posix_acl도 없다. getfacl·getfattr은 설치돼 있지 않다.
- 모듈 3개는 모두 root:root 644, nlink 1이다. ctime은 2026-09-25 09:59:03Z로 대조 시각 11:32:15Z보다 앞선다.
  - blob은 c7b3414e, 5fc2427e, 755c6f0b로 모두 일치한다.
  - driver sha256은 38905e19로 일치한다.
- 경로 사슬 디렉터리의 ctime도 대조 시각보다 앞선다.
  - 예외: `/`는 현재 boot 시각이다. 설치 시점 값은 pre-install.txt에 있다.
  - `scripts/qualification`의 ctime 11:30:47은 branch 전환 시각이다.
- 계정: uid 0은 root 하나이고 root 그룹 구성원은 없다. 로그인 셸이 있는 비root 계정은 ubuntu(sudo 그룹), claude, postgres다.
- 프로세스: 현재 비root 프로세스는 uid 64321 `sbx-telemetry-collector` 1개다. ps 인수에서 비밀을 치환한 곳은 0건이다.
- `/etc/ld.so.preload`는 없다. protected_hardlinks는 1, protected_symlinks는 0이다.

## B1 결론

| 항목 | 판정 | 근거 |
|---|---|---|
| 경로 사슬 root 전용 | PASS | 6개 모두 root:root 755이고 g/o 쓰기·sticky·ACL이 없다. ctime이 설치 전이라 설치 뒤 owner·mode가 바뀐 흔적도 없다. |
| 모듈 ctime < 11:32:15Z | PASS | 세 모듈 모두 09-25 09:59:03Z이고 blob이 일치한다. |
| 주입 적재 없음 | PASS | pid 2219의 코드 open은 driver와 세 모듈뿐이고, 라이브러리는 DT_NEEDED와 같다. preload·node_modules 흔적이 없다. |

세 항목 모두 PASS이므로 delta 감사로 넘긴다. BLOCKED 권고 조건(FAIL 또는 UNKNOWN)에 해당하지 않는다.

한계: 경로 사슬의 권한은 사후 boot에서 관측했다. 설치 시점과 같다는 근거는 ctime이 설치 전이라는 점이다. 비root 프로세스의 설치 시점 목록은 원래 기록하지 않았다. 다만 경로 사슬이 root 전용이어서 비root 주체는 모듈을 바꿀 수 없다.

## 이어지는 알려진 사항

- F1: 기록마다의 manifestFile 결속은 fstat 없이 원시 근거(strace의 openat flag·경로, write 누적 크기, 디렉터리 mtime·birth)로 추론했다. root 신뢰 가정 안에서만 성립한다.
- CLI 첫 설치 복구 leaf는 r6 뒤에 둘 예정이다. r5a `r5b-inputs.txt` 4절의 실행 불가 명령은 r5a의 알려진 결함이다.
- 오케스트레이션: 이번 턴은 범위가 정해진 읽기 전용 관측이고, 판정은 df73d3b5 delta 감사가 한다. 그래서 서브에이전트를 쓰지 않았다.
