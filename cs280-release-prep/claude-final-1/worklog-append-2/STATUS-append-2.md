# STATUS append-2
- cutoff: `cutoff.txt` 참고. 새 테스트, 제품 재시험, 설치 재실행은 하지 않았다.
- 기존 payload, 두 SHA256SUMS, append-1 STATUS의 "push FAIL(403)" 기록은 바꾸지 않았다. 그 기록은 당시 상태로 맞다.

## 게시 경로의 연결
1. 최초 push(seq 43, 로컬 commit `eff886e8…`, parent `c46f20c`): **FAIL 403**. 저장소가 세션 허용 범위 밖이었다.
2. append-1 로컬 commit `64b469d3…`: push하지 않았다(후속 지시 1).
3. 사용자 지정으로 저장소를 연결했다(`add_repo`, access=push). 자세한 내용은 `source-connection.md`.
4. 사용자 지시 "push 해": 원격 tip `ed429f2` 위에 cherry-pick으로 다시 만들었다(seq 47–48). force, amend, rebase는 쓰지 않았다.
   - `9f5e850f666846f2cb2d4565cb4eef63f5764562` (tree `4a7dbab5…`, parent `ed429f2e…`) 136개 추가
   - `e456736916b28104fb0f90eeb026088daef8fb54` (tree `39ea5fc3…`, parent `9f5e850f…`) 32개 추가
   - 범위: 168개 모두 A, 폴더 밖 0개, 폴더 내용은 로컬 commit과 같다(seq 49 `FOLDER_IDENTICAL_TO_LOCAL`)
5. push(seq 50): **PASS** `ed429f2..e456736  HEAD -> evidence`. ls-remote 전(seq 45) `ed429f2…`, 후(seq 51) `e4567369…`.

## source repo
- cutoff 시점: HEAD `b7341d3e…`, tree `5648f765…`, dirty 0 (`source-state-at-cutoff.txt`)
