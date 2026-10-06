# 관측하지 못했거나 포함하지 않은 항목

## 관측하지 못한 값과 로그
- **Cloud sandbox provisioning·setup 로그:** 세션 안에서 접근할 경로가 없어 받지 못했다.
- **실제 environment ID:** unknown. 컨테이너 환경 변수 중 `env_` 형식 ID를 담은 것이 없다. `CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE=cloud_default`만 관측됐다.
- **실제 모델·effort:** unknown. 턴별 관측 출처가 없다. `CLAUDE_EFFORT=high`는 세션 설정값이다.
- **CS Node harness의 사례별 실행 수:** 관측 불가. wrapper가 성공하면 child 출력을 숨긴다(`cs-suite-breakdown.md` 참고).
- **기존 Linux 911/3/5 결과의 FAIL 3건 이름:** 받지 못해 1:1로 대조하지 못했다.

## 후처리 cutoff 뒤의 기록
- 후처리 원 로그는 `2026-10-06T04:20:44Z`(seq 07)에 `postprocess-raw/`로 복사했다.
  - `postprocess-raw/commands.jsonl`에는 seq 01~06만 있다.
  - `07-copy-postprocess-raw.stdout`은 복사가 진행되는 중에 복사된 부분본이다(cutoff 줄만 있음).
- seq 08 이후의 원 로그는 이 폴더에 없다. VM의 `/root/cs280-publish/postprocess-raw/`에만 있다. 해당 단계는 postprocess-raw redaction, 잔여 검사, 비밀값 대조 목록 삭제, 이 문서·MANIFEST·SHA256SUMS 생성, commit, push다.
  - 잔여 검사(seq 09) 결과는 `REDACTION.md`에 옮겨 적었다.
  - commit·push 결과는 이 폴더에 담을 수 없다. 담당자에게 보낸 응답에만 있다.
- `scratchpad/residual.sh`를 staging하고 redaction한 단계 하나는 wrapper 없이 실행했다. 그 출력(교체 종류·횟수)은 `REDACTION.md`에 옮겨 적었다.

## Transcript (transcript inventory)
- 세션 transcript는 공개 저장소에 **넣지 않았다.** transcript에는 명령 출력 말고도 공개 대상이 아닌 세션 운영 맥락이 함께 담긴다. 패턴 기반 redaction만으로는 이것을 모두 걸러낼 수 없다고 판단했다.
- 그래서 `~/.claude/projects/` 아래 파일 목록은 수집하지 않았다. 후보 파일별로 넣을지 뺄지 판정하는 inventory도 만들지 않았다.
- 실행 근거는 명령별 원 로그(`NN-*.log`, `commands.jsonl`, `postprocess-raw/`)와 scratchpad 스크립트로 대신한다.

## 제외한 파일과 이유
| 파일 | 이유 |
| --- | --- |
| scratchpad `lits.txt`, `/root/cs280-publish/.lits.tmp` | 런타임 비밀값 대조 목록. 사용 직후 삭제했다. |
| scratchpad `selftest/` 샘플 | 탐지기 자체 검증용 가짜 값. 검증 직후 삭제했다. |
| `/root/cs280-evidence.tgz`, `/root/cs280-evidence.b64`, `/root/cs280-b64-*` | original-E 41파일을 인코딩한 사본이라 내용이 이미 포함되어 있다. VM에만 비공개로 보관한다. |
| `/root/cs280-publish/push-failure.txt` | 첫 push의 403 오류 기록. 같은 원문이 담당자 보고에 있다. VM에만 보관한다. |
| `/root/cs280-state/` | 테스트용 일회성 상태 디렉터리(pnpm store, XDG, plugin data). 이 범위에서는 trust DB·HMAC key·sqlite 파일을 포함하지 않는다. |
