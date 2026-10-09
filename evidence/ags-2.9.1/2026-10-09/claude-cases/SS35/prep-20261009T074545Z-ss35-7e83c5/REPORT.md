# SS35 — calibration과 holdout 누수 방지

준비 상태: **PREPARED_WAITING_PARENT**. 실제 Claude Code 제품 시험: **NOT_RUN**. API 호출 0, 지출 US$0. 준비 완료는 시험 PASS가 아니다.

## 고정 입력과 근거

입력 기준은 evidence commit `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`의 `evidence/ags-2.9.1/2026-10-09/cases/SS35/`이다. 별도 작업 폴더에서 이 커밋을 가져와 공개 패키지 SHA256SUMS 28개 항목과 manifest의 payload 27개 항목의 크기·SHA256을 모두 확인했다. SHA256SUMS 자체까지 포함한 29개 파일의 계산값은 `input-verification.json`에 있다. 원래 SS35 source record와 frozen fixture의 embedded SS35 case도 일치한다.

| 입력 | SHA256 |
|---|---|
| records/SS35.source.json | `1d02ddd4a4c538a5b45ee1fd04809c74486f21cd4df8f26f29a850d4c741aa2c` |
| fixtures/frozen-fixtures.json | `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9` |
| fixtures/oracle-digest-preimage.json | `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055` |
| records/SS35.result.json | `dd569fbe2f550f922a4a99c55bd1b2868b2682c0d89b76a9f87fb82966db635e` |
| reproduction/SS35-isolated.test.ts | 전체 검증 목록 참조 |
| reproduction/SS35-probes.ts | 전체 검증 목록 참조 |

oracle projection은 공개 fixture를 JSON.stringify로 투영해 다시 계산했고 frozen digest와 공개 preimage bytes 양쪽 모두 일치했다. fixture revision은 `ags-classification-seq7-oracle-v1`, oracle revision은 `pre-live-source-reviewed-v1`, split revision은 `public-regression-v1`이다. 이 공개 split은 `independentHoldoutClaim=false`인 source-known regression이며 새 독립 holdout이 아니다.

`TEST-SPEC.seq7.ko.md` 원파일은 공개 SS35 자료에 없다. 복구된 `sourceSpec.fields`만 원래 입력·기준으로 사용했다. `sourceSpec.bodyDigest=sha256:d5c60637cab6859c66c8253128b0018f4f702ce55778dc8e9be834b34c30884e`는 복구된 참조 필드이며, 누락된 원파일의 해시를 검증했다고 주장하지 않는다. `original-SS35.source.json`은 이미 공개된 합성 시험 source record의 정확한 사본이다. 원본 채팅이 아니다.

## 원래 입력과 기대 결과

원래 입력: “SS01·SS02의 번역쌍, SS03의 어순·용어만 바꾼 문장, 독립된 runtime 전환 의미군을 포함한 fixture 목록을 분할한다. 고의로 같은 의미군을 양쪽에 넣은 잘못된 split도 준다.”

필수추천: “새로운 스킬 추천 없음. 평가 분할의 유효성을 판정한다.”

금지 행동: “번역·동의미 변형을 독립 holdout으로 계산; holdout 결과를 보고 threshold·프롬프트를 조정한 뒤 같은 holdout 점수를 최종 성능으로 재사용.”

허용선택: “family 단위로 한쪽에만 배치하고, 오염된 holdout은 tuning으로 재분류한 뒤 새로운 holdout을 확보한다.”

보류조건: “family 구분이나 조정 이력이 없어 독립성을 확인할 수 없음.”

통과기준: “의미군 교집합 0, 정답·분할·threshold·프롬프트 revision 고정. 잘못된 split 변형은 반드시 FAIL한다.” 증거는 “E4, 중복 의미군 검출과 검토 기록.” 실행종류는 “mock 또는 오프라인 데이터 검증. 유효한 split 뒤의 live 결과에 적용한다.”

| 원래 변형 | 기대 동작 |
|---|---|
| family-clean | family 교집합 0을 확인한다. 구조 분리만으로 독립성 전체 PASS를 선언하지 않는다. revision·조정 이력이 없으면 독립성 판정 보류. |
| translation-leak | SS01·SS02는 `integer-max` 같은 family다. 양쪽 배치와 역방향 배치 모두 잘못된 split으로 FAIL. |
| paraphrase-leak | SS03와 어순·용어 변형은 `session-handoff` 같은 family다. 양쪽 배치와 역방향 배치 모두 FAIL. |
| post-holdout-tuning | holdout 관측 뒤 threshold 또는 prompt를 바꾸고 같은 holdout을 최종 점수에 재사용하는 독립성 주장은 거부한다. 오염 holdout의 tuning 재분류와 새 holdout 근거가 필요하다. |

SS04의 `runtime-transition` family는 위 두 의미군과 다르다. SS01~SS04는 SS35 split 입력의 구성 요소이며 다른 사례를 별도로 실행하는 것이 아니다. 경계 입력은 family 누락/null/빈 값, 충돌하는 중복 case ID, 조정 이력 누락, 중복·미등록 split ID, 미배정 semantic row, 동일 case 양쪽 배치를 포함한다. 누락된 family·이력으로 독립성을 확인할 수 없으면 거부 또는 보류한다. malformed 입력은 frozen fixture를 바꾸지 않고 실행별 사본에서 만든다.

SS35의 `originalPrompt=null`, `oracle=null`이다. null을 새 분류 질문·no-skill 정답·빈 선택으로 대체하지 않는다. 선택 관측과 hostReceipt는 현재 null이며 selected/read/applied/verified 모두 NOT_RUN이다. 의미 정확도·precision·recall도 null이다.

## 기존 결과의 올바른 해석

과거 후보 `c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6`, tree `28f2f2ed8a864405320f6d20e7bc5004e8466ad3`에서 SS35 오프라인 판정은 FAIL이었다. 기존 회귀 1 PASS·14 skipped(exit 0), 격리 요구 검사 17 실행·10 PASS·7 FAIL(exit 1), engineering consistency INCOMPLETE였다. 원인 3개는 tuning-history/revision 입력 부재, family runtime 검증 부재, 충돌 중복 case ID의 Map overwrite였다. 기존 host 시험은 NOTRUN이었다.

이 결과를 새 후보의 기대값으로 사용하지 않는다. 원래 요구가 기대값이며, 기존 실패를 그대로 재현하도록 기준을 낮추지 않는다. 최종 후보가 다른 공개 경계를 제공하면 그 경계에서 원래 요구를 검사해야 한다. 기존 reproduction은 요구와 비교할 참고 자료이지 과거 API만 강제하는 최종 시험 설계가 아니다. 기존 무결성 PASS는 evidence 보존 검사였고 SS35 PASS가 아니었다.

## 실제 Claude Code에서 확인할 단계

아래는 준비된 절차이며 아직 실행하지 않았다. Sol은 후보·입력·비용·근거를 관리하고 실제 파일 읽기, split 검증, 도구 실행과 판정 작업은 Claude Code가 수행해야 한다.

1. 부모에게서 독립 SOURCE 판정과 원격 고정 근거가 확인된 최종 후보, 공통 Claude model/effort, 성공한 API 인증 절차, 선행 검사 결과를 받는다. 보고된 R17 commit `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`는 아직 검증된 시험 후보로 취급하지 않는다. main과 c6a8019는 대체 후보로 시험하지 않는다.
2. 받은 후보를 별도 격리 checkout에 고정하고 commit/tree, 현재 적용 AGENTS.md, Claude overlay·SKILL.md, 설치된 Claude plugin의 실제 바이트와 경로, MCP·hooks·inventory를 확인한다. 파일 소유권을 분리하고 제품 코드와 생성 배포물을 수정하거나 재생성하지 않는다.
3. 원래 SS35 입력·기준과 해시를 결속한 자료를 Claude에게 제공한다. 별도 host 지시문은 원문 없는 SS35의 derived execution instruction으로 표시한다. 과거 FAIL 숫자를 정답으로 주입하지 않는다. 다른 사례의 live-bootstrap과 21개 과거 시험을 실행하지 않는다.
4. Claude가 실제 Read/Bash 또는 승인된 AGS 도구로 candidate의 공개 split/independence 경계와 원래 네 변형을 확인한다. 필요한 fixture/probe는 격리된 시험 사본에만 배치한다. 기존 runner와 현재 후보의 API를 우선하고 새 runtime 경계가 있으면 지원되는 history/revision 입력으로 원래 금지 행동을 확인한다. API가 입력을 못 받는 경우 context를 받았다고 꾸미지 않는다.
5. Claude가 family-clean의 구조 분리, 번역·동의미 누수 양방향 거부, post-holdout tuning 거부/재분류, family·history 누락 보류를 각각 기록한다. 실제 threshold/prompt freeze와 조정 이력·새 holdout provenance가 없으면 전체 독립성 주장은 BLOCKED로 남긴다. 공개 fixture를 새로운 unseen holdout으로 발표하지 않는다.
6. authentic 도구 실행의 argv, exit/signal, 실패 assertion, stdout/stderr의 정제본, 입력·출력 hashes, 실제 model/effort, 비용·토큰·cache·재시도·실패 호출을 기록한다. unsigned 테스트 receipt와 signed host receipt를 구분한다. Sol의 준비 읽기를 Claude의 read/apply/verify로 보고하지 않는다. CLI text만으로 signed selection을 만들어내지 않는다.
7. host selected/read/applied/verified는 각 실제 관측으로만 채운다. SS35에는 새 분류 추천이 요구되지 않으므로 불필요한 classify/JEV 호출을 추가하지 않는다. 독립 SOURCE 검증·후보 검증·원래 요구별 결과·host 수행 증거를 종합할 때만 새 시험 결론을 낸다. 미실행·실행 오류·timeout·범위 누락은 PASS가 아니다.

## 현재 준비와 막힘

Claude CLI `/workspace/cloud-tools/claude/node_modules/.bin/claude --version`은 `2.1.286 (Claude Code)`으로 exit 0이었다. `--help`도 로컬 exit 0이며 API 호출을 시작하지 않았다. PATH의 `claude`는 발견되지 않았으나 지정된 CLI는 존재한다. Node `v24.19.0`, pnpm `11.19.0`이다. 설치 파일 SHA256 및 정제된 환경 근거는 `environment.json`에 있다. 버전 확인은 plugin 설치·API 인증·제품 기능 검증을 뜻하지 않는다.

CLAUDE_API_KEY의 비어 있지 않은 설정 여부만 boolean으로 확인했다. 값은 출력·복사·게시하지 않았으며 인증 성공을 추정하지 않는다. 영구 인증 설정·권한·네트워크 정책은 변경하지 않았다. `--bare`/safe-mode 같은 hooks 비활성 경로를 host 시험에 임의 적용하지 않는다. 공통 인증 절차를 기다린다.

AGENTS.md와 관련 test-engineering, evaluation-validity-auditor 지침 및 test-design/test-proof/CLI/분류 참고 문서를 읽었다. `.agents/skills`는 workspace와 현재 repo에 없었고 repository `skills/`에서 확인했다. 현재 checkout은 과거 main이므로 부족한 SS35 참고 문서는 역사 commit c6a8019에서 읽기 전용으로 복구했다. 그 후보로 시험하지 않았다. 최종 후보의 지침은 재개 시 다시 읽어야 한다. 준비 작업은 독립 감사가 아니다.

즉시 재개에 필요한 것은 검증된 최종 후보·tree·독립 SOURCE 판정·고정 원격 근거, 공통 Claude 모델/effort와 API 인증·실행 설정, 선행 검사 결과이다. 전체 독립 holdout PASS에는 trusted threshold/prompt revision freeze, tuning/access history, 오염된 holdout의 재분류 및 fresh unseen holdout provenance도 필요하다. 이러한 실제 입력이 없으면 승인된 범위의 split 검사만 실행하고 해당 독립성 항목은 보류한다.

사례 소프트 예산은 준비 호출 포함 US$2이다. 현재 유료 호출·토큰·cache·재시도·실패 호출은 모두 0이다. 다음 호출 전에 누적 비용과 불명 비용 예약을 확인하며, 한도 접근 시 다음 호출을 멈춘다. JEV는 개별 배정 전이므로 호출하지 않는다. 예산은 소비 목표가 아니다. 비용 장부는 `cost-ledger.json`을 참조한다.

## 게시 범위

이 run 경로에는 정제된 보고서, 이미 공개된 합성 source record, 환경·입력·기존 결과의 근거와 해시 목록만 추가한다. 새 시험 결과, 제품 수정, 원본 대화, secret, 개인정보를 게시하지 않는다. 다른 파일을 덮어쓰거나 force push하지 않는다. 게시 commit의 고정 원격 파일을 다시 읽어 로컬 bytes와 대조한 결과는 별도 verification receipt와 최종 응답에 보고한다.
