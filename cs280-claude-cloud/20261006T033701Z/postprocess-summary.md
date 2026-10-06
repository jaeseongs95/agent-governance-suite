# 후처리 요약

원 로그는 `postprocess-raw/`에 있다. 이 요약이 원 로그를 대신하지 않는다.

1. **첫 공개 커밋:** `32f81188e60867e37c0e69a416e20fab450f80c1`. original-E 41파일과 `SHA256SUMS.original`, `REDACTION.md`를 담았고 이미 `evidence`에 non-force로 push되어 있다.
2. **이번 보완 방식:** 이미 push된 커밋을 amend하면 force push가 필요하다. 그래서 그 위에 보완 커밋 하나를 더 쌓는 방식을 택했다.
3. **추가한 원자료(raw-new):**
   - `scratchpad/`: `run.sh`, `env.sh`, `redact.py`, `residual.txt`, `07-runner.out`, `07.pid`, `wrap.sh`, `residual.sh`
   - `postprocess-raw/`: seq 01~07의 원 로그. cutoff는 `2026-10-06T04:20:44Z`다.
4. **redaction 규칙 확장:** http(s) URL의 query와 200자 이상 base64 블록(표지로 교체) 규칙을 추가했다. 확장한 규칙을 original-E와 raw-new에 모두 적용했다.
   - original-E에서 바뀐 것은 0건이다.
   - raw-new의 교체 내역은 `REDACTION.md`에 있다.
5. **잔여 검사:** control 파일을 뺀 64개 파일에 다시 실행했고 모든 항목이 0이다. 남은 `sk-` 줄은 모두 `risk-`·`task-` 단어 내부다.
6. **control 파일:** `MANIFEST.tsv`는 payload 목록과 redaction 전후 해시를 담는다. `SHA256SUMS`는 자기 자신을 뺀 전체 파일의 해시다.
7. **새로 실행하지 않은 것:** 테스트·검사는 다시 실행하지 않았다. 원본 E와 `/home/user/repo`는 수정하지 않았다.
