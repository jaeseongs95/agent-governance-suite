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
| M08 async 관측 범위 | 실제 manifest와 같은 async=true 등록. 자체 fixture는 실행되면 marker만 쓰고 즉시 종료하며 relay/서비스를 만들지 않음. 별도 mixed fixture는 동기 context hook을 함께 등록 | 기존 수집기와 수정 수집기에 같은 fixture를 주고 marker·원 registration·reason·통계 범위를 대조 | async는 실제 미실행/NOT_MEASURED_ASYNC, 원 entry와 이유 보존, exit/0 bytes 성공값을 만들지 않음. async-only 통계는 null, mixed는 동기 출력만 집계하고 미측정 수를 명시. async/전체 native payload는 UNKNOWN | RED→GREEN, 기존 marker 실행 2회/수정 async 미실행·mixed 집계 검산 |
| M09 상태 경로 격리 | 부모의 공개6상태변수를 자체 sentinel 경로로 설정. 자체 hook은 해당6값과 locale만 stdout에 출력 | 기존/수정 수집기에 같은 fixture를 주고 child 실제 전달6값과 결과 statePaths를 대조 | DB_PATH/CONTINUITY_DB_PATH/SESSION_BOARD_DB_PATH/SESSION_MESSAGE_STATE_DIR/SHARED_STATE_DIR/TRUST_DB_PATH 모두 자기 tmp 하위 절대경로. 부모 sentinel 상속0, workflow/continuity 파일 구분. 인증/HOME 접근·복사0 | RED→GREEN, 기존 부모 override 5개 상속/수정 6값 전부 자기 tmp |
| P01 phase3 A/B | exact b2a1ec6c archive A/B, 동일 lock hash의 기존 deps, Node24 exact, D36 종료·정리·Linux heavy.lock 해제 | 기존 phase3-control로 A의 3 source만 변환하고 receipt/hash 보존. A/B 모두 같은 공식 build·claude:build. 공통 skill/tool bytes 및 제품 source diff를 대조 | 변환 receipt의 3 source 외 공통 source 변경0. generated diff는 실제 build로만 생성. 다른 수리가 달라지면 인과 측정 중단 | 수행, 정확한 source 3개 변환/양 arm 같은 공식 build 4회 exit0 |
| P02 source 출력량 | P01의 두 빌드, 같은 explicit locale, 기존 measure-hooks | 각 host startup/user-input/지원 compact의 출력 파일 bytes·UTF-16/code point·목록 위치·공통 payload 비교 | 원 source 출력 차이만 보고. 미지원 이벤트/실패/누락을 0이나 성공으로 세지 않음. 모델 토큰·도달의 증명이 아님 | 수행, 네 collector 0/원 bytes·hash·목록 위치 검산. D32 크기 AC 미충족 |

Windows 선행 관측은 c48b33e02058989356b3ddcdcc0c07d10d79490f76127f12와 8ea71d79eb0264c24db081d3e14e32993a14a266281143cd, 둘 다 exit0이다. Node C:/Program Files/nodejs/node.exe v24.22.2, SHA256 1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9, free memory 3963616 KiB, disk 51148963840 bytes, 선택한 node/git/bash/pnpm/모델 프로세스 metadata0이었다. Administrator와 부모 ACL은 관측했으나 실제 쓰기 probe는 하지 않았다. 기존 repo/repo2/repo3/v380-green1-01a14016/v380-host-01a14016의 node_modules 존재와 pnpm-lock SHA256 40aad25b371d6c6c2a08aed5f9e97b721fb528ecedc80617aac7cebaaa8c577a는 후보와 일치했다. Windows 빌드/제품 hook 측정은 0이며 이 조건을 Linux 실행 환경으로 전용하지 않는다.

fixture RED/GREEN은 Linux TEST의 자체 source fixture에서만 수행하고 명령·후보/hash·원 exit·실제 stdout/결과 참조를 아래에 추가한다. fixture 실행에 모델·AGS 상태·외부 MCP는 필요 없다. 로컬에서는 syntax/lint/diff만 확인한다. 아래 fixture 실행 시점에는 제품 A/B가 NOT_RUN이었으며, 후속 실제 결과는 문서 끝에 별도로 기록한다.

기존 수집기 RED는 Linux TEST operation 18ea4392eae831076725d0a35fff163354474e4b8e1a850c, 독립 oracle exit1이다. `/home/mcpops/ags-tests/ags38-01a14016-20261107/d32-measure-collector-01a14016/red/result.json`에 원 명령/수집기 종료코드/row/child locale를 보존했다. 기존 measure-hooks SHA256은 a2b1d04605ec70591212cc85a9134a0911e1634d5d7883d0472264d50e8a47b8이다. M01은 bytes/raw 필드 없음, M02는 reported=ko와 다르게 실제 fixture child11개 locale=null, M03은 ENOENT/row exit=null인데 수집기 exit0으로 확인됐다. 이 oracle exit1은 AGS 제품 hook 실패가 아니다. fixture는 원문 상수·자기 관측 locale만 출력하고 AGS/모델/MCP를 실행하지 않았다. Node v24.22.1과 공통 heavy.lock nonblocking 획득 아래 유한 실행했다.

수리는 기존 측정 경로에서 Buffer stdout/stderr와 분리된 context UTF-8 파일/hash를 보존하고, 실제 전달 locale를 유지·기록한다. 빈 출력/JSON 문맥 없음/잘못된 JSON·문맥/프로세스 실패를 구분하며 후자는 수집기 nonzero가 된다. 같은 세션 시작 prelude도 결과에 보존한다. 기존 UTF-16 길이 필드를 유지하면서 code point와 UTF-8 bytes를 따로 기록한다. 출력 경로 재사용은 원 근거 보존을 위해 거부한다. 정상 현재 Claude node+args 및 Linux Codex bash 실행 선택은 바꾸지 않았다.

고정 수리 b9d7bc2247c1c264e4cd9f00f80cfbc2088ac9b3의 TEST GREEN은 operation 562ecee1632b4bbfb10f5d808d0870baa6163d609cb0b1d2, 독립 oracle exit0이다. 같은 root의 green-b9d7bc22/result.json에 9개 fixture 실행과 재사용 거부1회를 기록했다. good-ko/good-en/good-default/codex-ko는 각각11 invocation과 UTF-8 7bytes/UTF-16 3/code point2, locale·전체 보존파일 hash를 확인했다. missing4회/collector1, nonzero11회/child7·collector1, invalid11회/원FF0A 2bytes·collector1, empty11회/collector0, unsupported2회/resume·compact supported=false였다. 재사용 거부 exit1 전후 원 결과와 출력 파일 모두 hash가 같았고 임시 state 잔류0이다. 해당 fixture 회차는 모델0·제품 hook0이며 당시 P01/P02는 NOT_RUN이었다. collector SHA256은 af74f1e7315bd504216d72f9305b02202037300ec8bacd511851905728548791, tasks는 전후 동일한 481587626ebaef49c22a79cb9d3141ae46564f25c46353240279d572439c8301이다.

로컬 node --check, ESLint10.10.0의 실제 measure-hooks 대상 검사, git diff --check는 exit0이다. 최초 lint 호출은 잘못된 eslint.config.mjs 경로로 ENOENT였고 실제 저장소 eslint.config.js로 바로잡은 뒤 통과했다. 이것은 코드 lint 실패나 제품 시험이 아니다. 해당 fixture 회차 뒤 Linux 후속 슬롯에서 실제 A/B 빌드·출력량·목록 위치·공통 payload를 기존 도구로 회수했다. 결과는 아래에 기록한다.

제품 측정은 `/home/mcpops/ags-tests/ags38-01a14016-20261107/d32-source-b2a1ec6c-01a14016`의 고유 root에만 쓴다. candidate checkout에서 A/B를 각각 git archive로 내보내 `.git` 없는 사본으로 만들고 A만 기존 phase3-control을 한 번 실행한다. helper/collector와 변환 receipt의 hash를 보존한다. 기존 deps의 pnpm-lock SHA256이 후보와 일치할 때만 각 arm의 node_modules symlink로 읽어 재사용하고 pnpm install은 실행하지 않는다. package.json의 공식 build 명령과 같은 `tsc --noEmit && node scripts/build.mjs`, 이어 `node scripts/build-claude-plugin.mjs`를 양쪽 같은 Node24/bin·의존성으로 실행한다. shared deps를 재설치하거나 바꾸지 않는다.

source A/B 측정 locale는 AGENT_GOVERNANCE_LOCALE=ko로 양쪽 동일하게 전달한다. 기존 collector의 네 호출(Claude A/B, Codex A/B)만 실행하며 출력 경로는 매번 새로 쓴다. hook별 raw stdout/context bytes/hash, UTF-16/code point, 설치 스킬 목록 첫 줄 `- acceptance-evidence-validator:`의 출현 위치·횟수와 각 실제 package의 전체 설치행 존재를 확인한다. 목록 기대집합은 그 package의 classification.json에서 직접 정한다. 공식 Claude builder는 codex-token-usage-analyzer를 제외하므로 Codex26/Claude25를 같은26으로 강제하지 않는다. 공통 intake는 각 arm/host의 설치된 references/intake.md 내 원블록 bytes/hash 및 원문 frame을 먼저 대조하고 실제 hook 출력에 담긴 블록/본문 반복과 pointer를 따로 센다. 이 파일 비교를 MCP/native 모델에 보낸 전체 instructions의 직접 관측이라고 쓰지 않는다. 원출력 차이는 루트 경로·자체 합성 ID 등 관측된 가변 항목과 phase3 text를 분리해 적고 임의 정규화로 동일성을 만들지 않는다. hook 실패/누락/미지원은 수치0의 성공으로 바꾸지 않는다.

실제품 측정 전 manifest 수명 계약을 대조했다. Claude SessionStart의 session-message-hook은 async=true/--own-relay이며 launcher는 relayClosed를 기다린다. 부모가 정한 source 관측 목적은 동기 문맥 출력이므로 이 등록을 spawnSync/20초 timeout으로 반복 실행하지 않는다. async entry는 NOT_MEASURED_ASYNC로 미실행·원 registration·이유만 기록하고 동기 context hook만 측정한다. 이는 제품 manifest/relay 수명 변경이나 전체 native payload 보증이 아니다. b2 제품 A/B source는 그대로 고정하고 수집 도구의 async 범위 수리 SHA를 별도로 핀한다. D36 종료 전 실제 제품 hook은 계속 실행하지 않는다.

runtime-config.ts의 실제 resolver는 workflow DB32행, continuity146행, board160행, message98행, shared59행, trust111행의 해당 override를 기본 경로보다 먼저 적용한다. 따라서 기존 XDG/shared 고정만으로는 부모 public DB override를 차단하지 못한다. 위 공개6변수는 모두 자기 tmp 아래로 덮어쓰고 그 선택 필드만 결과에 기록한다. workflow/continuity는 다른 파일, board와 message/trust/shared도 같은 자기 tmp 안의 별도 경로다. HOME·인증파일·부모 환경 전체를 수집하지 않는다. M08/M09 fixture 검사가 끝나기 전 실제 제품 hook은 보류한다.

M08/M09의 고정 수집기 27e819dd7b26de55f9da3b88e9da7142ca749f24 TEST 판별은 operation 0b8467dbff255052b3d2137d3bb819fa7ada4846adc13745 exit0이다. 자기 fixture 원결과는 d32-measure-collector-01a14016/async-isolation-27e819dd/result.json이다. 이전 b9 수집기는 async=true 즉시종료 fixture marker를 2번 실행했고, 이전 a3는 부모 public 상태 override 5개를 물려받았다. 수정 수집기는 async-only 미실행/통계null/원등록·이유 보존, mixed는 동기 7bytes만 집계/async 1개 미측정, child의 상태값 6개 전부 자기 tmp/statePaths와 일치/부모 sentinel0/workflow·continuity 구분을 확인했다. Claude/Codex 동기 fixture 11회씩 raw hash·bytes 회귀도 통과했고 임시 상태 잔류 0이었다. collector SHA256은 102f4e4cef2a847624c125953f74682d445e13514c79233e5d55e71251888f45이며 tasks SHA256은 481587626ebaef49c22a79cb9d3141ae46564f25c46353240279d572439c8301로 불변이다.

P01/P02는 D36 종료·own cleanup·lockfree를 확인한 뒤 Linux 고유 root `/home/mcpops/ags-tests/ags38-01a14016-20261107/d32-source-b2a1ec6c-01a14016`에서 수행했다. 제품 B는 b2a1ec6c4e6af1e173b66ae98052add54c740b83, 수집기는 27e819dd7b26de55f9da3b88e9da7142ca749f24로 별도 고정했다. Node v24.22.1/메모리6307744KiB/디스크76771483648bytes/own쓰기 가능과 기존 deps lock40aad25b… 일치를 확인했다. 모델·플러그인 설치·전역설정 변경은0이다. A의 source 3개만 기존 helper로 변환했고 helper SHA256=3ab4d2b542fe1ddcf6f80c9d3a639e0aea07450c30e2f8e5f6a18a985b274b82, A receipt SHA256=331d77cb902c5c45d1f1ab8056521c8e8eceee734d468a32fedcd1c9ddccadf9다.

최초 archive Claude build는 .git 없는 사본에서 git ls-files가 실패하여 operation 2a049a5a8fd2326e719c71ac9fc8ad1d1e5e13349a42225e exit1로 보존했다. builder의 Git 사용이 파일명 열거뿐임을 실제 소스로 확인했다. 프로세스별 GIT_DIR/GIT_INDEX_FILE을 exact 후보 checkout 메타데이터에, GIT_WORK_TREE를 각 arm에 결속한 같은 조건으로 양쪽 공식 build/claude:build 네 명령을 다시 실행하여 operation a98ceb8df0d58fbd35a2034139fb79b27a78c745d1833893 exit0을 회수했다. arm의 source/.git을 고치지 않았고 index 전후 hash는 같았다. 공유 deps는 symlink로 읽었으며 pnpm install은0이다.

Claude 측정 operation 8d81b2d19dad295df551ea16bc638f357463f44437a963cf와 Codex 1e5384168dd32606d68664527651e94fc1df2956ee81d6c9는 각 exit0, host/arm당 동기 33호출 전부0이었다. Claude async 등록 4개은 NOT_MEASURED_ASYNC로 미실행했다. 원 byte·hash·UTF-16/code point·전달 locale ko·자기 상태 경로 6개 독립검산은 operation 0af9d70cf7855cea358311caf301883fa5b662363ad80778 exit0이다. 최초 분류목록 경로 오기 조회1194c2de43bb3dd2ba50b59b91d3093143c3bfcc0b9fc3bd exit1도 보존하며 실제 */classification.json 경계를 확인한 뒤 검산했다. 분석 JSON의 SHA256은698444d591558eb83d69c0a0edff17e9503f9a4072a4fdd632e12b61198ea42b이다.

| 호스트 | 범위 | stdout bytes A→B | context bytes A→B | context UTF-16/code points A→B |
| --- | --- | --- | --- | --- |
| Claude | startup/resume 각각 | 273→3104 | 195→3000 | 123/123→2413/2413 |
| Claude | 지원 compact | 4024→4292 | 3838→4105 | 2803/2803→2915/2915 |
| Claude | 사용자 각1입력 | 3696→1133 | 3584→1046 | 2657/2657→479/479 |
| Claude | 시작1회+사용자7입력 | 26145→11035 | 25283→10322 | 18722/18722→5766/5766 |
| Codex | startup/resume 각각 | 385→3266 | 307→3161 | 214/214→2553/2553 |
| Codex | 지원 compact | 4186→4454 | 3999→4266 | 2943/2943→3055/3055 |
| Codex | 사용자 각1입력 | 3746→1133 | 3633→1046 | 2706/2706→479/479 |
| Codex | 시작1회+사용자7입력 | 26607→11197 | 25738→10483 | 19156/19156→5906/5906 |

A의 전체 설치 목록은 compact continuity와 사용자7입력에 반복됐다. B에서는 시작/재개/압축/prelude의 intake 또는 skill-trigger에 있고 사용자 입력에는 없다. 첫 설치행의0기준 code point/UTF-8 byte 위치는 A compact409/986, A 사용자386/927, B Codex573/1181, B Claude482/1069다. 기대 목록은 package별 classification.json의 Codex26/Claude25였다. 매턴 반복은 줄었으나 startup/resume/compact 전체 동기 출력은 증가했다. Codex pointer의 실제 A/B arm 경로 차이도 원문에 남기고 정규화하지 않았다.

공통 intake 순수 API skillIntakeText("ko")의 A/B 원출력은 12144bytes/5447code points/SHA256084ef759b045079b476922fab2387efcaa167b3f409d7675a2627ffb486b2079로 완전히 같다. root/Claude의 marker .trim 원블록도 11784bytes/5224code points/SHA256f16536e8bb9d2f3b385776267e3320ac5b8a4235198723c774519ab9f0589db1로 같았다. hook context의 공통 intake 전체블록·orchestrator 전체본문은 각각 0회, Codex reference pointer는 arm당 4회/Claude 0회였다. 이것은 MCP/native 모델 전체 입력 전달의 관측이 아니다.

원 D32 AC의 3.7 이하 크기 목표는 미충족이다. immutable v3.7.0 commit36265b7061c1ca57014bc4fb18843fe6d16dadc1의 같은 marker .trim은 4344code points/9783bytes였고 b2는 5224/11784다. operation 8c13b19abd5d41259a4b3ff7e4fc1c175d4c55b202eb50aa exit0의 v370-size-target-comparison.json은 withinV370SizeTarget=false다. 이 source A/B 결과만으로 D32 완료·모델토큰 감소·native 도달·행동 성공을 선언하지 않는다. async와 전체 native payload는 UNKNOWN이다.

cleanup operation 20618cf0542c57f75f46baf6e4d161366da2d8f9c2e3563d exit0: 기록한 own PGID 4개 잔류[], 자기 고유 root Node[], tmp[], heavyLockFree=true, checkout b2 tracked diff 없음/index hash 전후 동일/deps lock 동일을 확인했다. 전역 프로세스 완전목록 보증은 하지 않는다. 원자료는 위 고유 root의 REPORT.ko.md, source-output-analysis.json, source-output-summary.json, matched-build-and-common-intake.json, source-transform-pin.json, v370-size-target-comparison.json, cleanup-receipt.json, measures/와 logs/에 보존했다. 후속 슬롯은 root에게만 먼저 통지했으며 QB 모델 시작을 직접 요청하지 않았다.
