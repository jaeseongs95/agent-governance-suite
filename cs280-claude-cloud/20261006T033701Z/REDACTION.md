# 민감정보 제거 기록 (REDACTION)

- 원본: `/root/cs280-claude-cloud/20261006T033701Z/` (파일 41개, 수정하지 않음)
- 사본: `/root/cs280-publish/cs280-claude-cloud/20261006T033701Z/`
- 원본의 `SHA256SUMS`를 바꾸지 않고 `SHA256SUMS.original`로 복사했다(SHA256 `fae5f24f04227cb252c9f8597142d55544055f126cc9d5e29d54cd70f8fdaf16`).
- 바꾼 값은 `[REDACTED]`로 표시한다. 원래 값은 이 문서에 적지 않는다.

## 결과

**모든 파일에서 0건을 바꿨다.** 원본 41개 파일은 바이트 단위로 원본과 같다(`sha256sum -c SHA256SUMS.original` 통과). 새로 추가한 파일은 이 `REDACTION.md`와 `SHA256SUMS.original`이고, `SHA256SUMS`는 다시 만들었다.

| 파일 | 바꾼 개수 | 패턴 종류 |
| --- | --- | --- |
| `00-source-pin.log` | 0 | - |
| `00-source-pin.post-git.txt` | 0 | - |
| `01-pnpm-install.log` | 0 | - |
| `01-pnpm-install.post-git.txt` | 0 | - |
| `02-bundle-check-prebuild.log` | 0 | - |
| `02-bundle-check-prebuild.post-git.txt` | 0 | - |
| `03-source-check.log` | 0 | - |
| `03-source-check.post-git.txt` | 0 | - |
| `04-claude-drift.log` | 0 | - |
| `04-claude-drift.post-git.txt` | 0 | - |
| `05-lint.log` | 0 | - |
| `05-lint.post-git.txt` | 0 | - |
| `06-build.log` | 0 | - |
| `06-build.post-git.txt` | 0 | - |
| `07-pnpm-test.log` | 0 | - |
| `07-pnpm-test.post-git.txt` | 0 | - |
| `07-vitest-results.json` | 0 | - |
| `08-runtime-check.log` | 0 | - |
| `08-runtime-check.post-git.txt` | 0 | - |
| `09-validate-all.log` | 0 | - |
| `09-validate-all.post-git.txt` | 0 | - |
| `10-validate-official.log` | 0 | - |
| `10-validate-official.post-git.txt` | 0 | - |
| `11-claude-check.log` | 0 | - |
| `11-claude-check.post-git.txt` | 0 | - |
| `12-bundle-check-postbuild.log` | 0 | - |
| `12-bundle-check-postbuild.post-git.txt` | 0 | - |
| `13-skills-context-check.log` | 0 | - |
| `13-skills-context-check.post-git.txt` | 0 | - |
| `14-release-check.log` | 0 | - |
| `14-release-check.post-git.txt` | 0 | - |
| `15-git-integrity.log` | 0 | - |
| `15-git-integrity.post-git.txt` | 0 | - |
| `commands.jsonl` | 0 | - |
| `cs-suite-breakdown.md` | 0 | - |
| `environment.json` | 0 | - |
| `source-pin.json` | 0 | - |
| `status.json` | 0 | - |
| `test-failures.md` | 0 | - |
| `token-scan.txt` | 0 | - |

## 검사한 패턴
- 이메일 주소
- 사람 계정명·사용자명: 알려진 로컬·GitHub 계정명 목록을 단어 경계로 검사했다. `/home/<name>` 경로는 VM 경로인 `/home/user`만 있다.
- Windows 사용자 홈의 사용자명 부분: `C:\Users\<name>`, `C:\\Users\\<name>`, `C:/Users/<name>`, `/c/Users/<name>`
- IPv4·IPv6: Python `ipaddress`로 형식을 검증했다. `127.0.0.1`, `0.0.0.0`, `::1`, `::`는 유지 대상이다.
- 토큰과 키:
  - `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`
  - 단독 `sk-`(앞이 영숫자가 아닌 경우)
  - `xox?-`, `AKIA` + 16자
  - `Bearer <값>`
  - `*_TOKEN=`·`*_SECRET=`·`*_KEY=` 뒤의 값
  - JWT 형태(`eyJ…`)
- 실행 환경의 비밀값 리터럴: 이름에 TOKEN/SECRET/KEY/PASSWORD/SOCKET/CREDENTIAL이 들어간 환경 변수의 값(`CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_MESSAGING_SOCKET` 포함)과 session ingress token 파일 내용을 문자열 그대로 대조했다. 대조 목록은 저장소 밖 임시 파일에만 두었고, 검사가 끝난 뒤 지웠다.

## 유지한 항목(지시에 따라 바꾸지 않음)
- commit/tree SHA, 파일 해시, Cloud session ID(`cse_…`, session UUID), container ID, 테스트 이름
- `/root`, `/home/user/repo` 같은 VM 경로
- 단어 내부의 `sk-` 오탐: `risk-` 18곳, `task-` 13곳(15줄). 앞 글자를 확인해 모두 `ri`/`ta` 뒤에 오는 것만 남았음을 확인했다.

## 탐지기 자체 검증
가짜 값으로 만든 샘플(R에 넣지 않음)에서 모든 유형을 바꾸는 것을 확인했다: 이메일, IPv4(사설·공인), IPv6, github/sk/xox/AKIA/JWT 토큰, Bearer, `*_TOKEN=`·`*_SECRET=`·`*_KEY=`, Windows 홈 세 형식, 계정명. 같은 샘플에서 루프백, 시각 `03:40:14`, 버전 `1.20.0`, SHA, session·container ID, `task-…`는 그대로 남았다. 첫 검증에서 `MY_SECRET=` 형태를 놓쳐 패턴을 고친 뒤 다시 검증했다.

## 바이너리 파일
없다. 모든 파일의 `file --mime` 결과가 텍스트 charset이다. trust DB, HMAC key, sqlite 상태 파일은 원래 증거 디렉터리에 없고 포함하지 않았다.

## 제거 뒤 잔존 검사(원시 출력)
```
# residual grep (grep -P, counts of matching lines across all files except SHA256SUMS*/REDACTION.md)
email                  0
github-token           0
sk-standalone          0
sk-word-internal       15
slack-xox              0
aws-AKIA               0
bearer                 0
secret-assignment      0
jwt                    0
windows-home           0
account-name           0
ipv4-non-loopback      0
messaging-token-literal 0
runtime-secret-literals(env *TOKEN*/*SECRET*/*KEY*/*SOCKET*, ingress token file): 0
ipv6 (python ipaddress-validated, excluding ::1 and ::): 0
```

참고: 이 문서 안에서 `sk-` 패턴에 걸리는 문자열은 위 잔존 검사 출력의 라벨 `sk-standalone`·`sk-word-internal` 두 줄뿐이며 토큰이 아니다.
