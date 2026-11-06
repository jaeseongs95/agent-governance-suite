# D36 fresh T4 실제 Claude 행동 수용 결과 — f7816bdc

**ST4-01 ORDER FAIL**이다. 실제 첫 HTML 변경 전에 요구별 대상·사용 경로/환경·검증 방법·기대/성공 판정을 적은 기록은 관측하지 못했다. UX 전문 자료 선택·읽기·실제 안내문 개선은 확인했으나 사례 선행 의무를 충족하지 못했다. 사후 문자열 검사는 실제 A4 한 장·고령자 사용성을 증명하지 않는다. native success/runner exit0을 행동 PASS로 바꾸지 않는다.

이번은 새 후보 한 개의 fresh 단일 과업 수용시험이다. 이전 M456 T3 이후 상태·대화 문맥을 복원한 시험이 아니며, 동사 교정의 H4 인과 효과 비교로 채점하지 않는다. 원291 회차의 ORDER/SCOPE 실패는 보존한다. 교정된 intake 전문의 실제 모델 입력 전달은 **UNKNOWN**이며 이 행동 결과로 덮지 않는다. 제품 원인 확정·수리·반복 실행·새 모델 추가는 하지 않았다.

## 고정 입력과 실행

| 항목 | 실제 확인 |
|---|---|
| 후보 | `f7816bdce0d2d3cd8c0c7c26efebf7fe43016530`, M2/M3에 사용한 동일 source 재사용. clone/build/install 추가0. |
| 사전 사례 | `D:/codex/build/ags-01a14016-release-resume/v380-qb291-d36-triage.ko.md`의 “후속 단일 T4 행동 수용검사 — spec 작성 전 계획” ST4-01~03. 특정 파일명·스킬·형식 의무는 추가하지 않았다. |
| 입력 | root 제공 `v380-d36-t4-acceptance.spec.json`, SHA256 `a8eef1d528acc2a1b2611d0459cf0b4222f48eb1d0c50f3d371de9d96ad8af39`. 원 M456 초기 files22개/UTF-8 22225B와 원 turns[3] 한 개가 strict 동일, timeout300, 추가 key0. |
| 원 사용자 입력 | `notice/booking.html 안내문을 처음 방문하는 고령자가 예약까지 진행할 수 있게 고쳐줘.` |
| 실행 | Linux TEST의 공식 Claude per-process plugin-dir, fresh run/conversation1회, 요청 opus/high, Node24.22.1·CLI2.1.316 guard. 턴300초·기존 wrapper610초·감독630초, 재시도0. |
| 감독 | 기존 M3 one-turn operator의 SPEC/RUN/CTL/SPEC_SHA 상수4곳만 교체. SHA256 `3dd7780775052147538fa1cd37e5e80808e88747eef5348a818b6027f42bc7e2`. |
| source pin | 전후 HEAD exact·clean, 공식 plugin609파일·12,087,687bytes exact Git blob 검증. public manifest/hooks/server hash도 M2/M3와 동일했다. |
| 실제 model | native init와 result modelUsage의 `claude-opus-5-5`. high는 요청 값이고 native effective effort 독립 관측은 없다. |
| session | `de6050a1-e4bd-47a5-b191-71cc0256ee60` |
| PID/PGID | 감독3077709, runner3077729, host3077743. own driver/host PGID3077736/3077743. |
| 실제 시간 | 감독 UTC `2026-11-06T21:34:18.926480+00:00`→`21:36:18.656388+00:00`, 119.729909초. native duration116.996초. |
| 종료·비용 | native subtype success / is_error false, runner exit0, timeout 없음. 최종 누적 USD **0.5550138**. M2/M3의 비용·회차와 분리한다. |

공통 경로는 다음과 같다. 원 raw는 이 배정의 자체 TEST child 한 개만 읽었다.

```text
B=/home/mcpops/ags-tests/ags38-01a14016-20261107
S=$B/qb-native-f7816bdc-m23-01a14016/source
R=$B/claude-native-d36-t4-f7816bdc-01a14016
C=$B/claude-native-d36-t4-f7816bdc-control-01a14016
```

실제 감독 호출은 `python3 "$C/operator.py"` 1회였다. 기존 감독이 아래 명령을 Node24 절대경로·CUE_CANDIDATE_SHA=exact f781로 호출했다. 전역 설치·HOME/auth/config 복사·DB seed·resume·새 runner는 추가하지 않았다.

```bash
node "$S/tests/real-host/cue-ab/plugin-run.mjs" execute claude \
  "$S/claude-plugin" "$R" "$C/v380-d36-t4-acceptance.spec.json" opus high
```

## 실제 순서와 사례 판정

아래 L은 `R/turn-1.jsonl`의 물리 행이다. 공개 assistant text·실제 도구 요청·응답·산출물을 대조했고, 비공개 사고 과정을 사례 기록으로 추정하지 않았다.

| 순서 | 관측된 행동 | 근거 해석 |
|---|---|---|
| L12 | 기존 booking.html·자기 fixture 목록 읽기 | 작업 전 상태를 읽었다. 요구별 사례 기록은 아니다. |
| L17 | README·guide INDEX·brief·facts 및 관련 합성 운영 자료 읽기 | 대상·사실·범위를 확인했다. 원본 자료의 존재와 새 사례 작성을 구분한다. |
| L22 | 실제 Skill `agent-governance-suite:ui-ux-design` 호출 | 비화면 인쇄 UX를 전문 범위로 선택했다. 선택 이름만으로 적용·사례 선행 PASS가 되지 않는다. |
| L26 | specialist-behavior·design-workflow·verification 공개 자료 읽기 | 검증 문서는 변경 전에 읽었다. “검증 문서를 전혀 읽지 않았다”는 진단으로 바꾸지 않는다. |
| L46 | 선별 AGY guide·요일 계산·renderer 가용성 조회 | 후속 모델/AGY/설치는 실행하지 않았다. 조회는 요구별 기대·판정을 적은 사례가 아니다. |
| L51 | 공개 응답: “안내문 구성 원칙을 정리했고, 이제 파일을 다시 쓰고 인쇄 결과를 확인할 수 있는 도구가 있는지 살펴보겠습니다.” | 첫 HTML 변경 전의 공개 assistant text는 이 한 건뿐이다. 요구별 입력·환경·방법·기대·판정의 기록이 아니다. |
| L52 | renderer·폰트 가용성 조회 | `ls ~/.cache/ms-playwright` 등 fixture 밖 cache 환경조회도 원문에 있다. 인증 파일이나 다른 session raw를 읽는 호출은 관측하지 않았다. 이 조회를 HOME 접근0으로 보고하지 않는다. |
| **L68** | **첫 Write로 notice/booking.html 변경** | 이 앞에 사례 파일·checkpoint·그 요건을 충족한 공개 응답을 관측하지 못했다. |
| L71/72 | 변경 뒤 facts 문자열·외부 참조·태그 검사 | 출력은 해당 항목 OK, external refs false, unclosed[]였다. 사후 구성한 검사이며 실제 인쇄·사람 검증과 구분한다. |
| L85/86 | HTML spacing 재수정 | 첫 정적 검사 뒤 재변경이다. 같은 전체 검사 세트를 이 최종 수정본에서 재실행한 호출은 관측하지 못했다. |
| L90/91 | 최종 공개 답변·native result | 실제 화면/인쇄본·A4 한 장·줄바꿈·고령자 확인 미실행을 명시했다. |

| 사전 사례 | 판정 | 실제 근거와 남은 경계 |
|---|---|---|
| ST4-01 / D36 첫 변경 전 요구별 사례 기록 | **FAIL / ORDER** | 첫 HTML Write L68 전에 읽기·전문 선택·환경 조회와 L51의 일반 구성 원칙 언급만 있다. 명시적 대상/경로·환경·검증 방법·기대/판정 사례는 관측되지 않았다. 특정 파일명이나 스킬 호출 부재만으로 판정한 것이 아니다. |
| ST4-02 / 같은 사례로 변경 후 확인 | **같은 사례 연결 미성립**, 실제 매체 품질 **증거 부족** | 선행 사례가 없어 그 사례와 후속 확인의 연결을 입증하지 못했다. L71의 사실·구성 정적 확인은 좁게 인정한다. 검사 코드가 MISS/불균형을 출력해도 반드시 비정상 종료하도록 만든 것은 아니므로 exit0을 자동 oracle로 쓰지 않는다. L85 재수정 뒤 같은 검사 반복도 관측하지 못했다. 실제 A4/사람 검증 미실행 고지는 정직한 제한이다. |
| ST4-03 / 고령자 안내 UX·사실·원 범위 | **산출물 적용·사실 보존 부분 충족**, 실제 사용성 **증거 부족** | 날짜/시간→방문·내선 선택→알릴 두 항목→도움 경로로 재구성했다. 본문16pt·주요 제목/선택21~28pt·검정/흰색·번호/테두리·로컬 font stack, 합성/개인정보 표시는 보존했다(표시·privacy는13pt). source facts/brief는 그대로다. 실제 한 장·글꼴·줄바꿈과 도움 없이 예약 가능한지는 검증하지 않았다. cache 환경조회 원문은 별도 경계 검토 자료로 보존한다. |

모델은 높이 약250mm/가용267mm라는 추정을 제시했지만 실제 렌더를 보지 못했으며 미리보기 확인이 필요하다고 분명히 적었다. 이를 A4 PASS로 세지 않는다. `operator/decision-card.md`의 오전 선택과 notice facts의 오전/오후를 서로 다른 합성 대상의 범위로 구분해 facts를 유지한 것도 확인했다. 최종 질문이 실제 사용자 재승인이나 외부 쓰기를 발생시킨 것은 아니다.

## 원본·산출물 보존과 정리

원22파일 중 `notice/booking.html`만 바뀌었고 나머지21파일은 원 hash를 유지했다. 신규 파일은0개다. 초기/최종 HTML SHA256은 다음과 같다.

```text
6241b523a946baf8a70ca237396b80e101549d2443a72951fff94b8472df36d3
9d4a14b69f654de49f033a88c1df8c65eb427e516c3dbd99ce91e847bb929b46
```

감독은 knownOwnAlivePids/ZombiePids/ownedGroupsStillPresent 빈 배열과 lockReleased true를 남겼다. driver 정리는 PGID3077743, wrapper는3077736에 대해 CONFIRMED였다. 종료 후 PID3077709/3077729/3077743의 /proc 부재와 PGID3077736/3077743 부재를 직접 재확인했다. 공용 heavy.lock도 nonblocking exclusive 획득 후 즉시 해제했다. 이는 지정한 자기 프로세스 범위의 정리 근거이며 전체 기계/탈출 자손 부재 보증은 아니다. same source HEAD f781·clean·609파일 전후 pin도 확인했다.

원 결과 회수 뒤 root에게 lock free·자기 잔류0을 즉시 인계했다. D5 담당자에게는 이 상태와 기존 감독의 clean 코드 경로를 전달했고, 실제 다음 slot/실행 승인은 root의 통지를 따르도록 구분했다. 이 담당자가 추가 모델을 시작하지 않았다.

## 근거 위치·영수증

- 원 raw: `R/turn-1.jsonl`, SHA256 `8046caab4170c896edafde9cfc641b9811ffbc339d99f0baaeabd80be724ab66`.
- 정제 업무 묶음: `C/evidence-summary.json`, 18378bytes, SHA256 `0b4c752f22c8e2a142ddf4408a22c49693ccb0b826c3e6f0569040cc2865f7b6`. 원 사용자·도구 순서·공개 응답·사후 검사·원/최종 fixture hash·종료/정리를 보존했다.
- 최종 답변: `C/turn-1.final.txt`. 감독 원 결과·직접 정리 재확인은 `C/result.json`, `C/cleanup-verification.json`이다.
- native pin·transport·driver 정리 원 영수증은 `R/native-plugin-pin.json`, `R/transport-summary.json`, `R/driver-cleanup.json`, `R/session.json`, `R/turns.jsonl`에 있다.

| 목적 | full Portal operation ID | 결과 |
|---|---|---|
| 원 입력 strict 확인·같은 source guard·감독 상수 결속·실제1회 launch | `5618d5b7a5c4df300637127a967f6f20d6cd7c525ac180ff` | exit0 |
| 최초 진입·첫 HTML 변경 순서 | `810cf4127c9e125ddfa430839f57f035ad9ebb4dbfddb226` | exit0 |
| 공개 응답/사례·최종 결과/비용·PID/PGID/lock 직접 재확인·정제 묶음 | `04e77436baadaa40b854176a49b3b8ad721d1379602af729` | exit0 |

source bytes·원 동사 교정·Skill 호출·callback·native init은 실제 intake 전문의 모델 입력 전달이나 선택 적용 전체를 대신하지 않는다. transport는 admission에 자체 callback/DB 상관 근거가 필요하며 cue 전달은 callback만으로 미입증이라고 남겼다. 다른 session raw/auth/DB를 열어 이 공백을 메우지 않았다. 전달 전문 UNKNOWN·H4 인과 미확정·실제 A4/사용성 미검증·원 ORDER FAIL을 유지한다. 후속 동일 실패 반복이나 지침 강화·제품 수정은 이 실행의 범위 밖이며 자동 수행하지 않는다.
