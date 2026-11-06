# Q32 source hook 수집기 사례

수집기 원결함 기준은 d2ffc9af54cd1cb3f7a85061a3e7788287863654다. f73c54d0과의 차이는 claude-stream.mjs 하나이며 제품 소스는 같다. 최신 제품 A/B 후보는 root가 공식 build/claude/en/lint 종료0으로 고정한 b2a1ec6c4e6af1e173b66ae98052add54c740b83이다. 소유 변경은 measure-hooks.mjs와 이 문서뿐이다. 새 runner·서비스·모델·플러그인 설치·Windows bash 설치는 하지 않는다. 제품 A/B 생성·측정은 Linux D15→D36 이후 별도 슬롯이며 아래 fixture 판별과 구분한다.

공개 경계는 기존 `node tests/real-host/cue-ab/measure-hooks.mjs <claude|codex> <pluginRoot> <outFile>`다. source hook의 자체 합성 입력/출력만 다룬다. native callback, 모델 입력·토큰·실제 스킬 선택·행동·압축 효과를 증명하지 않는다. 기존 `.length`의 글자수 단위는 UTF-16 code unit이며 Unicode code point·UTF-8 bytes와 구분한다.

현재 원 경로는 stdout을 UTF-8 문자열로 받은 뒤 길이만 저장하고 버린다. 따라서 bytes·원문 hash·목록 위치·공통 payload 비교는 재구성할 수 없다. locale를 child env에서 삭제하면서 결과에는 삭제 전 값을 적는다. exit=null/ENOENT·nonzero·잘못된 JSON도 전체 프로세스 exit0으로 보고할 수 있다. 이 실패를 제품 source가 짧다는 근거로 쓰지 않는다.

Claude 현재 manifest는 모든 command가 `node`, args가 별도 배열이다. 따라서 현재 배포물에서 whole command 문자열을 executable로 쓰는 경로 오류는 발견되지 않았다. 임의 whole-command 형식을 새로 지원하지 않는다. Codex는 기존 Linux bash 경로만 사용한다. Windows TEST에는 bash가 PATH에 없으므로 Codex 측정을 실행하지 않았다.

| 사례 | 입력·선행조건 | 절차·독립 oracle | 기대·판정 | 실제 |
| --- | --- | --- | --- | --- |
| M01 UTF-8 보존 | 실제 manifest와 같은 command=node/args 배열인 자체 hook fixture. stdout JSON additionalContext는 `가🙂` | startup/resume/지원 compact와 기존 7개 user-input을 실행. 원 stdout 파일을 JSON으로 직접 읽고 fixture 상수와 대조. context는 UTF-16 3, code point 2, UTF-8 7 bytes다. raw 파일 bytes/hash를 Python hashlib/파일크기와 대조 | 모든 실제 invocation exit0, context 원문·hash·byte count를 보존. stdout bytes는 원파일 크기와 일치. 실패를 0글자 성공으로 바꾸면 FAIL | RED→GREEN, Claude/Codex 자체 fixture |
| M02 locale | fixture가 child의 AGENT_GOVERNANCE_LOCALE 값도 stdout에 기록. ko/en/미설정 각각 별도 출력 경로 | 호출 env와 보존된 child stdout locale 및 결과 locale를 대조 | 실제 전달한 값이 동일. 미설정은 null/default로 명시하고 effective host locale로 확대하지 않음 | RED→GREEN, ko/en/null |
| M03 spawn 실패 | 같은 fixture의 executable을 존재하지 않는 절대경로로 지정 | 기존 collector 그대로 실행. row exit/error와 collector 실제 exit를 대조 | ENOENT/exit=null 보존, collector nonzero. 0글자/exit0으로 성공 처리하면 FAIL | RED→GREEN, collector1/ENOENT |
| M04 child 실패 | fixture는 context를 출력한 뒤 exit7 | row stdout 원문/bytes/hash 및 native exit와 collector exit를 대조 | partial source 출력은 보존하되 row7/collector nonzero | GREEN, child7/collector1/context 보존 |
| M05 JSON/빈 출력 | 잘못된 JSON 또는 UTF-8이 아닌 자체 stdout bytes; 별도 fixture는 정상 exit0/빈 stdout | raw byte 파일과 독립 fixture 상수 대조 | 잘못된 JSON은 nonzero+parse 상태, 원 bytes 보존. 정상 빈 출력은 NO_OUTPUT/0이며 오류와 구분 | GREEN, invalid1/empty0 |
| M06 증거 보존 | 이미 사용한 outFile/출력 디렉터리 | 같은 경로로 한 번 더 실행 | 원 근거를 덮어쓰지 않고 거부. 재실행은 새로운 출력 경로만 사용 | GREEN, 재실행1/기존파일 전부 hash일치 |
| M07 미지원 이벤트 | startup matcher만 있는 자체 fixture | 같은 기존 collector에서 resume/compact 결과를 확인 | 빈 rows와 supported=false를 보존. 0글자를 압축 지원 성공으로 확대하지 않음 | GREEN, resume/compact false |
| P01 phase3 A/B | exact b2a1ec6c archive A/B, 동일 lock hash의 기존 deps, Node24 exact, D36 종료·정리·Linux heavy.lock 해제 | 기존 phase3-control로 A의 3 source만 변환하고 receipt/hash 보존. A/B 모두 같은 공식 build·claude:build. 공통 skill/tool bytes 및 제품 source diff를 대조 | 변환 receipt의 3 source 외 공통 source 변경0. generated diff는 실제 build로만 생성. 다른 수리가 달라지면 인과 측정 중단 | NOT_RUN, 슬롯 대기 |
| P02 source 출력량 | P01의 두 빌드, 같은 explicit locale, 기존 measure-hooks | 각 host startup/user-input/지원 compact의 출력 파일 bytes·UTF-16/code point·목록 위치·공통 payload 비교 | 원 source 출력 차이만 보고. 미지원 이벤트/실패/누락을 0이나 성공으로 세지 않음. 모델 토큰·도달의 증명이 아님 | NOT_RUN |

Windows 선행 관측은 c48b33e02058989356b3ddcdcc0c07d10d79490f76127f12와 8ea71d79eb0264c24db081d3e14e32993a14a266281143cd, 둘 다 exit0이다. Node C:/Program Files/nodejs/node.exe v24.22.2, SHA256 1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9, free memory 3963616 KiB, disk 51148963840 bytes, 선택한 node/git/bash/pnpm/모델 프로세스 metadata0이었다. Administrator와 부모 ACL은 관측했으나 실제 쓰기 probe는 하지 않았다. 기존 repo/repo2/repo3/v380-green1-01a14016/v380-host-01a14016의 node_modules 존재와 pnpm-lock SHA256 40aad25b371d6c6c2a08aed5f9e97b721fb528ecedc80617aac7cebaaa8c577a는 후보와 일치했다. Windows 빌드/제품 hook 측정은 0이며 이 조건을 Linux 실행 환경으로 전용하지 않는다.

fixture RED/GREEN은 Linux TEST의 자체 source fixture에서만 수행하고 명령·후보/hash·원 exit·실제 stdout/결과 참조를 아래에 추가한다. fixture 실행에 모델·AGS 상태·외부 MCP는 필요 없다. 로컬에서는 syntax/lint/diff만 확인한다. 실제 제품 A/B 결과가 없으면 P01/P02는 계속 NOT_RUN이다.

기존 수집기 RED는 Linux TEST operation 18ea4392eae831076725d0a35fff163354474e4b8e1a850c, 독립 oracle exit1이다. `/home/mcpops/ags-tests/ags38-01a14016-20261107/d32-measure-collector-01a14016/red/result.json`에 원 명령/수집기 종료코드/row/child locale를 보존했다. 기존 measure-hooks SHA256은 a2b1d04605ec70591212cc85a9134a0911e1634d5d7883d0472264d50e8a47b8이다. M01은 bytes/raw 필드 없음, M02는 reported=ko와 다르게 실제 fixture child11개 locale=null, M03은 ENOENT/row exit=null인데 수집기 exit0으로 확인됐다. 이 oracle exit1은 AGS 제품 hook 실패가 아니다. fixture는 원문 상수·자기 관측 locale만 출력하고 AGS/모델/MCP를 실행하지 않았다. Node v24.22.1과 공통 heavy.lock nonblocking 획득 아래 유한 실행했다.

수리는 기존 측정 경로에서 Buffer stdout/stderr와 분리된 context UTF-8 파일/hash를 보존하고, 실제 전달 locale를 유지·기록한다. 빈 출력/JSON 문맥 없음/잘못된 JSON·문맥/프로세스 실패를 구분하며 후자는 수집기 nonzero가 된다. 같은 세션 시작 prelude도 결과에 보존한다. 기존 UTF-16 길이 필드를 유지하면서 code point와 UTF-8 bytes를 따로 기록한다. 출력 경로 재사용은 원 근거 보존을 위해 거부한다. 정상 현재 Claude node+args 및 Linux Codex bash 실행 선택은 바꾸지 않았다.

고정 수리 b9d7bc2247c1c264e4cd9f00f80cfbc2088ac9b3의 TEST GREEN은 operation 562ecee1632b4bbfb10f5d808d0870baa6163d609cb0b1d2, 독립 oracle exit0이다. 같은 root의 green-b9d7bc22/result.json에 9개 fixture 실행과 재사용 거부1회를 기록했다. good-ko/good-en/good-default/codex-ko는 각각11 invocation과 UTF-8 7bytes/UTF-16 3/code point2, locale·전체 보존파일 hash를 확인했다. missing4회/collector1, nonzero11회/child7·collector1, invalid11회/원FF0A 2bytes·collector1, empty11회/collector0, unsupported2회/resume·compact supported=false였다. 재사용 거부 exit1 전후 원 결과와 출력 파일 모두 hash가 같았고 임시 state 잔류0이다. 모델0·제품 hook0이며 P01/P02는 계속 NOT_RUN이다. collector SHA256은 af74f1e7315bd504216d72f9305b02202037300ec8bacd511851905728548791, tasks는 전후 동일한 481587626ebaef49c22a79cb9d3141ae46564f25c46353240279d572439c8301이다.

로컬 node --check, ESLint10.10.0의 실제 measure-hooks 대상 검사, git diff --check는 exit0이다. 최초 lint 호출은 잘못된 eslint.config.mjs 경로로 ENOENT였고 실제 저장소 eslint.config.js로 바로잡은 뒤 통과했다. 이것은 코드 lint 실패나 제품 시험이 아니다. 아직 실제 A/B 빌드·출력량 숫자·목록 위치·공통 payload 비교를 회수하지 않았으며 Linux 후속 슬롯에서 기존 도구로 수행한다.

제품 측정은 `/home/mcpops/ags-tests/ags38-01a14016-20261107/d32-source-b2a1ec6c-01a14016`의 고유 root에만 쓴다. candidate checkout에서 A/B를 각각 git archive로 내보내 `.git` 없는 사본으로 만들고 A만 기존 phase3-control을 한 번 실행한다. helper/collector와 변환 receipt의 hash를 보존한다. 기존 deps의 pnpm-lock SHA256이 후보와 일치할 때만 각 arm의 node_modules symlink로 읽어 재사용하고 pnpm install은 실행하지 않는다. package.json의 공식 build 명령과 같은 `tsc --noEmit && node scripts/build.mjs`, 이어 `node scripts/build-claude-plugin.mjs`를 양쪽 같은 Node24/bin·의존성으로 실행한다. shared deps를 재설치하거나 바꾸지 않는다.

source A/B 측정 locale는 AGENT_GOVERNANCE_LOCALE=ko로 양쪽 동일하게 전달한다. 기존 collector의 네 호출(Claude A/B, Codex A/B)만 실행하며 출력 경로는 매번 새로 쓴다. hook별 raw stdout/context bytes/hash, UTF-16/code point, 설치 스킬 목록 첫 줄 `- acceptance-evidence-validator:`의 출현 위치·횟수와 전체26행 존재를 확인한다. 공통 intake는 각 arm/host의 설치된 references/intake.md 내 원블록 bytes/hash 및 원문 frame을 먼저 대조하고 실제 hook 출력에 담긴 블록/본문 반복과 pointer를 따로 센다. 이 파일 비교를 MCP/native 모델에 보낸 전체 instructions의 직접 관측이라고 쓰지 않는다. 원출력 차이는 루트 경로·자체 합성 ID 등 관측된 가변 항목과 phase3 text를 분리해 적고 임의 정규화로 동일성을 만들지 않는다. hook 실패/누락/미지원은 수치0의 성공으로 바꾸지 않는다.
