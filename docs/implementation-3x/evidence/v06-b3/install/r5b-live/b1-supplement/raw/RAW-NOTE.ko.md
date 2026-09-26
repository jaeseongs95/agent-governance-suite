# r5b 원본 strace 제출

- **근거**: 총괄 GO `claude-main-r5b-option-b-go-to-devlead-20260926-01`. df73d3b5 delta 감사(b209874c)가 BLOCKED를 냈다. strace 발췌의 부재 주장을 독립 검증하려면 원본이 필요해 원본을 제출한다.
- **선확인**: 2026-09-26T12:54:53.082235147Z, boot `363d8210-5248-4c43-918a-dfd62fb4b52e`, uid 0. 설치 boot `701c96a7`과 다른 사후 boot다.

## 원본

- 경로: `/root/r5a/r5b-run/strace.txt` (root:root 644, ino 1681503)
- 크기 20723437 bytes, 45331줄
- sha256 `07597bba5d2930bfc1045c44286c27b2ec29bf8f59f0825237f5dffc52b67428`
- 이 hash는 설치 당시 commit 51295a25의 `r5b-live/install.txt:31`에 이미 기록돼 있다.
- 명령: `strace -f -y -s 256 -e trace=openat,mkdir,chmod,fchmod,unlink,unlinkat,rmdir,rename,renameat2,write` (install.txt:20)

## 제출 형식

원본이 5 MiB를 넘어 `gzip -9n -c`로 압축해 `strace.txt.gz`로 넣었다.

- `strace.txt.gz` sha256: `8f0d670c1adfca5c3fe6c4919c5d0f29b985b9ee1fdc728f470d4ea562bf653f` (4170975 bytes)
- `gzip -dc strace.txt.gz | sha256sum` 결과는 `07597bba5d2930bfc1045c44286c27b2ec29bf8f59f0825237f5dffc52b67428`이고 45331줄이다. 원본과 같다.
- 비밀 검사 결과는 `secret-scan.txt`에 있다. 고신뢰 형식은 0건이고, 일반어 315줄은 모두 경로 이름이거나 공개 archive·repo 데이터다.
- gz라서 `git diff --check`에 원본 줄이 걸리지 않는다.

## 완료 범위의 한계

1. 적재된 bytes는 root 신뢰 가정 아래의 추론이다. strace는 openat의 경로·flag·fd만 기록하고 읽은 bytes는 기록하지 않았다. 모듈 내용이 설치 전 blob과 같다는 결속은 다음 근거를 합친 것이다: 설치 직전 hash-object, root 전용 경로 사슬, 설치 전 ctime 유지.
2. `strace -f`는 설치 프로세스 트리(pid 2219와 그 thread·자식 2220-2229)만 기록했다. 같은 시각의 다른 프로세스 동작은 기록되지 않았다.
3. read·stat·access·execve는 기록 대상이 아니었다. 이 syscall들이 없다는 주장은 하지 않는다.

## r6 신뢰 가정 후보

- sudo 그룹 계정 `ubuntu`(uid 1000, 로그인 셸 /bin/bash)
- 로그인 셸 계정 `claude`(uid 999), `postgres`(uid 102)
- 설치 시점에 이 계정들로 실행 중인 프로세스는 기록하지 않았다(pre-install.txt의 목록은 root 프로세스만 담았다). 사후 boot 관측은 observed-post.txt에 있다.

## 작업 방식

서브에이전트는 쓰지 않았다. 원본 복사와 정해진 pattern 검사만 하는 좁은 읽기 작업이고, 판정은 df73d3b5 delta 감사가 한다.
