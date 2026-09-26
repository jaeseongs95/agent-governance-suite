# V06-b3b-r6 설치 lineage 원시 근거 전달

V06-b3b-r6(spec r51 c9bd668b…d526)의 verification 근거다. r5b가 새 Linux host에 한 첫 설치(boot 701c96a7)의 원시 기록을 전달하고, 현재 보호 root·manifest를 그 기록과 읽기 전용으로 다시 대조한다. 설치·재설치·삭제, `/usr`·`/root` 쓰기, 제품 코드·테스트 변경은 하지 않았다.

- writer: `cse_01PRna2jKCs5EdTv8Rwv3j83`(r5a·r5b·r5에 이어 단일 writer), AREA V06_B3B_R6_CLAUDE_CLOUD
- branch: `claude/v3x-v06-b3b-r6-lineage-transfer`, base 7e3e6fd8
- r6 턴: T0 2026-09-26T22:36:34Z, boot 3532114c-8a82-42f0-a1cc-c30217ed6d5b(btime 1790462181). 사후 관측이다.

## 주장 범위

- 주장한다: r5b 설치 기록과 scratch 원본이 byte 단위로 같다. 현재 설치 root·bin/node·manifest의 dev·ino·소유·mode·nlink·bytes·sha, inventory 248행, 파일 sha 180개가 r5b 기록과 같다. installer blob은 8bb6e689·4866e455·7e3e6fd8에서 c7b3414e로 같다.
- 주장하지 않는다: 설치 lineage ACCEPT, host 동일성, V06-b3b 완료, V06-b3c 착수, 운영 host 자격. lineage와 근거 정확성은 df73d3b5가 따로 판정한다.
- 이전 32a825d9 root(구 VM)의 사후 verify나 r3 근거를 새 설치 lineage로 쓰지 않는다. r1-live·r3-live는 읽지도 바꾸지도 않았다.

## 파일

| 파일 | 내용 |
|---|---|
| `survival.txt` | 1절 생존·identity 점검 원시 출력 |
| `git-cite.txt` | 7e3e6fd8의 원시 파일 blob 목록, installer blob, r3-live 비조상 |
| `transfer-table.md` | 2절 원시 항목 대조표, host·boot 결속, ACCEPT용 근거와 부족 항목 |
| `errata.md` | r5-live 정오표(I-1, I-3, I-4, I-5) |
| `raw/install.stdout` | 설치 stdout 원본(1b432df3…e937), git에 없던 것 |
| `raw/dpkg-pre-full.txt.gz`, `raw/dpkg-post.txt.gz` | dpkg --verify 원본(풀면 ec0ee1d2…6f07, b6fbf490…616) |
| `secret-scan.txt` | 비밀 검사 결과 |
| `HANDOFF-draft.ko.md` | handoff 초안 |
| `SHA256SUMS` | 이 디렉터리 파일 |

`survival.txt`의 첫 findmnt 명령 exit는 0이지만 UUID 칸이 비어 있다. fs UUID는 미관측이다.

## 공백 정규화

`git diff --check`를 통과시키려고 두 출력 파일의 줄 끝 공백과 끝 빈 줄만 지웠다. 내용 변경은 없다.
- `survival.txt`: lsblk 출력 13–19행의 줄 끝 공백, 끝 빈 줄. 정규화 전 sha256 ba7de69df78c9cab9470388b2281a1514b7f655f902f69d2fba984f68895d8c9
- `git-cite.txt`: 끝 빈 줄. 정규화 전 sha256 d2c18ef98b4846d9c4c18adbcd21e9c974e0ea4ba0dcaec764a46c3de3910229

## 비밀 제거

- `raw/`에 넣은 원본은 가리지 않았다. 비밀 패턴 검사에서 걸린 줄은 모두 파일 경로 이름(예: `systemd-ask-password`, `webproxy`)이라 오탐이다(`secret-scan.txt`). 가린 줄이 없으므로 원본 hash로 그대로 재계산할 수 있다.
