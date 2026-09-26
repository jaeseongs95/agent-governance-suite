# V06-b3b-r6 원시 근거 전달·대조표

- 기준 commit: 7e3e6fd8(r5 통합). 원시 파일의 git blob id는 `git-cite.txt`의 `ls-tree` 출력에 있다. 아래 경로는 `docs/implementation-3x/evidence/v06-b3/install/` 기준이다.
- scratch 재계산: r6 턴(boot 3532114c-8a82-42f0-a1cc-c30217ed6d5b, 2026-09-26T22:36Z~). 사후 관측이며 설치 lineage 증거가 아니다.
- 구분: **[설치]**는 r5b 설치 사건(boot 701c96a7, 11:32–11:35Z) 당시의 원시 기록이다. **[r5a]**는 설치 전 준비 기록이다. **[결합]**은 r5 결합 판정 문서(r5-live)이고, 원시 근거가 아니다.
- 판정 표기: 일치 / 불일치 / 부분 / 미관측. 이 표는 근거가 정확한지만 다룬다. lineage ACCEPT/BLOCKED는 df73d3b5가 판정한다.

## A. 원시 항목 대조

| # | 명세 항목 | git 위치 (7e3e6fd8) | scratch 원본 · r6 재계산 sha256 | 판정 |
|---|---|---|---|---|
| 1 | 설치 명령·exit·stdout/stderr·시각 [설치] | `r5b-live/install.txt` 2절(11:33:49–57Z, exit 0), `r5b-live/driver.mjs.txt` | `/root/r5a/r5b-run/driver.mjs` 38905e19…bff8 = git 사본. `install.stdout` 1b432df3…e937(install.txt:29 기록과 같음), `install.stderr` e3b0c442(0 B) | 일치. stdout 원본은 git에 없어 `r6-live/raw/install.stdout`로 전달 |
| 2 | CLI 형식 거절 [설치] | `r5b-live/install.txt` 1절(exit 1, `--parent-manifest` 필수) | 없음(터미널 출력만 기록) | 일치. 설치는 모듈 API 실행이지 CLI 실행이 아니다 |
| 3 | source(0724bb2b, 1620개)·host-integration 648dddda [r5a→설치] | `r5a-live/source.txt`, `r5b-live/pre-install.txt` 67–90행 | `/root/r5a/src`(재계산하지 않음, r5b 직전 기록을 인용) | 일치(기록 간) |
| 4 | 서명 archive·keyring·SHASUMS [r5a→설치] | `r5a-live/k1-node.txt`·`pins.txt`, `r5b-live/pre-install.txt` 27–66행 | pubring.kbx 140f2ad5…5932, SHASUMS256.txt f4104280…07f6, .sig 865f22b0…5a89, archive fd8e59d5…b2d6, node/bin/node 7fde7b8a…df4c | 일치(archive·keyring·node가 기록과 같다) |
| 5 | 계약 pin V03-i·v2·V06-c [r5a→설치] | `r5a-live/pins.txt`(V03-i 0c5bfc70, v2 contractId, V06-c 648dddda) | 해당 없음 | 부분: v2 contractId와 V06-c는 설치 출력 `releaseIdInputs`(install.txt:23)에 있다. V03-i manifest hash는 r5b 설치 직전 재계산 행이 없고, source 전체가 0724bb2b와 blob 단위로 같다는 기록으로만 이어진다 |
| 6 | installer blob [설치] | `r5b-live/pre-install.txt` 91–97행 | git 재확인: 8bb6e689·4866e455·7e3e6fd8에서 install c7b3414e, release 5fc2427e, stage 755c6f0b(git-cite.txt) | 일치 |
| 7 | mount 사전검사 [설치] | `r5b-live/pre-install.txt` 98–116행(단일 ext4 /dev/vda 254:0, private, mountinfo ca88d4a2) | r6 턴 mountinfo `/` 행이 같은 형식(survival.txt) | 일치. ca88d4a2는 공통 이미지 값이라 host 구별 근거가 아니다 |
| 8 | root 소유·umask 022·group/other 비쓰기 입력 [설치] | `r5b-live/pre-install.txt` 1–12행(id·umask 0022), 36행(archive root:root 644), 67–90행(source 검사) | 없음 | 일치(기록 간) |
| 9 | 설치 전 빈 경로 [설치] | `r5b-live/pre-install.txt` 117–140행(subtree 부재, manifest ABSENT, `/root/b3bf` 부재) | 없음 | 일치 |
| 10 | 생성 manifest [설치] | `r5b-live/manifest.txt`(e78cb508…2428, 248줄), `manifest-trace.txt` c79f71c5 | `/root/r5a-out/manifest.txt` e78cb508, `cmp` 동일. `r5b-run/manifest-trace.txt` c79f71c5 = git 사본 | 일치 |
| 11 | inventory·digest [설치] | `r5b-live/inventory.tsv`(a4ab95ea), `installed-sha256.txt`(180줄) | r6 재생성 inventory a4ab95ea, diff 없음. `sha256sum -c` 180개 통과 | 일치 |
| 12 | 원본 strace [설치] | `r5b-live/b1-supplement/raw/strace.txt.gz`(풀면 07597bba) | `/root/r5a/r5b-run/strace.txt` 07597bba…7428 | 일치 |
| 13 | 설치 후 release ID·bin/node·package 집합 [설치] | `r5b-live/install.txt`:23(32a825d9, node ino 524293, packageFileCount 179, createdCount 248), `post-install.txt` 35–140행(verify OK, v24.21.0) | r6: node 7fde7b8a, ino 524293, dir 68·file 180 | 일치 |
| 14 | 열린 identity와 bytes [설치] | `install.txt`:23 `nodeIdentity`·`fdSha256`, `b1-supplement/strace-excerpt.txt` | 없음 | 일치(기록). 적재 bytes는 root 신뢰 가정 아래의 추론(r5b RAW-NOTE 한계 1) |
| 15 | nobody 거절·mount 교체 거절 [설치] | `r5b-live/reject-tests.txt`(nobody 14/14, mount 3건 거절, 1건 판정 불가 후 대체 시험) | 없음 | 일치(기록) |
| 16 | 검증-사용 사이 불변 [설치] | `post-install.txt` 141–170행, `reject-tests.txt` 127행 이후, `dpkg-verify.txt` | dpkg 원본 두 개(`dpkg-pre-full.txt` ec0ee1d2…6f07, `dpkg-post.txt` b6fbf490…616)는 git에 없어 `r6-live/raw/*.gz`로 전달. 두 파일은 1행(머리말 시각)만 다르다 | 일치 |
| 17 | 기록마다 manifest 결속(F1) [설치] | `post-install.txt` 8–29행, `manifest-trace.txt` | 없음 | 미관측(부분): 기록마다 fstat을 재지 않았다 |

## B. 현재 보호 root 생존·identity (1절, survival.txt)

| 대상 | r5b 기록 | r6 관측 | 판정 |
|---|---|---|---|
| 설치 root | ino 524291, root:root 755, nlink 4, dev 65024(inventory.tsv, install.txt) | 같음, ctime 1790422435 | 일치. root의 ctime은 r5b에 따로 기록되지 않았다(inventory에 ctime 열 없음) |
| bin/node | ino 524293, 555, nlink 1, 126595440 B, ctime 1790422435.204 (install.txt:23) | 같음, sha 7fde7b8a | 일치 |
| manifest | ino 1671184, 600, nlink 1, 58663 B, mtime 11:33:56 = 1790422436, sha e78cb508, 248줄 (post-install.txt:10) | 같음, ctime 1790422436 | 일치. ctime은 r5b 기록에 없고 mtime과 같다 |
| inventory 전체 | dir 68, file 180, 248행 | diff 없음(sort 뒤 sha a4ab95ea) | 일치 |
| installed-sha256 | 180개 | `-c` 180개 통과 | 일치 |
| 설치 뒤 변경 | 없음 | root 아래 11:34:00 이후 변경 0, 모든 ctime이 1790422435.198–1790422436.135 | 일치 |

ino와 개수만으로 PASS를 주지 않았다. dev·소유·mode·nlink·bytes·sha·ctime을 함께 대조했다. 그러나 이 대조는 모두 같은 fs 안의 사후 관측이다. 과거 설치 host와 지금 host가 같다는 증거는 아니다.

## C. host·boot 결속

| 항목 | 값 | 판정 |
|---|---|---|
| 설치 boot | 701c96a7-937e-47dd-9a3d-cdfdb92380fc, btime 1790422227 (r5b 기록) | 기록 |
| r6 boot | 3532114c-8a82-42f0-a1cc-c30217ed6d5b, btime 1790462181 | 설치 boot와 다름(예상된 관측) |
| hostname | r5b 원시 자료는 `vm`만 있다. r6 관측 `vm` | 공통값, 구별 근거 아님 |
| machine-id | r5b 원시 자료에 없다(r5 턴 사후 값 0d0af05e…). r6 관측 0d0af05ee8fd4dc29275718f2ce4dff1 | 공통값(구 VM도 같음), 구별 근거 아님 |
| fs UUID | r5b 기록 없음. r6: findmnt UUID 빈 값, blkid·lsblk에 UUID 없음, `/dev/disk/by-uuid` 없음, dumpe2fs 출력 없음 | 미관측(현재도 얻지 못함) |
| release ID | 32a825d9…8edd | 구 VM root 이름과 같아 구별 불가. dev/ino·manifest·boot로만 결속 |

## D. ACCEPT에 쓸 수 있는 원시 근거와 부족한 항목

- 쓸 수 있는 근거: 설치 boot 하나 안의 사전검사→설치→검증→거절 기록(A 1·3·4·6–16), scratch 원본과 git 사본의 byte 일치(driver, manifest, manifest-trace, strace, stdout), 현재 root·manifest identity가 설치 기록과 같음(B), installer blob 동일(A 6).
- 부족한 항목(미관측):
  1. host 동일성: hostname·machine-id가 공통값이고 fs UUID를 설치 때와 지금 모두 얻지 못했다. r5a→r5b→r6 연속성의 근거는 디스크 위 scratch·manifest·root의 identity 유지뿐이다.
  2. 기록마다 manifest 결속의 fstat(F1).
  3. 적재 bytes: root 신뢰 가정 아래의 추론.
  4. V03-i pin의 설치 직전 직접 재계산 행(A 5).
  5. 설치 root·manifest의 설치 시점 ctime 기록(B).
