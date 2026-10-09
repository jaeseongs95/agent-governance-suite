# SS12 — 대상과 행동이 모호한 요청

준비 상태: **PREPARED_WAITING_PARENT**. 실제 Claude Code 제품 시험은 **NOT_RUN**이며 PASS를 주장하지 않는다. 유료 Claude/JEV/vendor 호출 0회, 비용 US$0. 사례 소프트 예산은 준비·실패·재시도·캐시를 모두 포함해 US$2다.

입력은 공개 synthetic 사례의 정확한 원문 “그거 처리해 줘.”이며 21 UTF-8 bytes, trailing newline 없음. SHA256 `5deb6397ac183e6bd2cf53dc2f98221b958183e84047bf793e5f028b12037ef8`. 고정 evidence commit `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`의 `evidence/ags-2.9.1/2026-10-09/cases/SS12/input/originalPrompt.utf8.txt`에서 읽었다. confirmedContext의 모든 필드는 null이고 contextSources는 빈 목록이다. 행동·대상·이전 참조를 추가하지 않는다. 단일 원래 variant는 base다.

기대 결과는 `selectionStatus=NEEDS_INPUT`, `agentSelectedSkillIds=null`, `missing-action`과 `missing-target`을 밝히는 실제 clarification이다. 고확신 코드 구현·배포·보안 감사 선택을 꾸며내거나 uncertain을 no-skill `[]`로 바꾸면 원래 기준에 맞지 않는다. frozen embedded sourceSpec과 oracle을 보존했으며 외부 TEST-SPEC.seq7.ko.md는 기존부터 MISSING_ORIGINAL이다. 누락 문서를 재구성하지 않았다.

원래 공개 파일 29개를 정확한 Git blob에서 읽었고 SHA256SUMS 28/28 및 manifest payload 27/27 항목의 bytes·SHA256이 일치했다. 전체 근거와 해시는 source-integrity.json에 있다. 과거 c6a8019에서는 offline 19-pass controls와 PARTIAL/all-uncertain의 null→[] 경계 실패가 기록되었다. 원래 host 단계는 NOTRUN이다. 과거 실패·미실행·characterization assertion을 정답이나 R17 결과로 승격하지 않는다.

로컬 Claude CLI `/workspace/cloud-tools/claude/node_modules/.bin/claude`에서 `2.1.286 (Claude Code)`을 재확인했다. PATH에서 발견되지 않아도 설치된 실제 실행 파일을 확인했다. Node v24.19.0, pnpm 11.19.0이다. --version 외 Claude 실행과 인증·유료 호출은 하지 않았다. 영구 인증 설정·권한·네트워크 정책·제품 코드·생성 배포물을 변경하지 않았다.

보고된 후보 R17은 commit `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb`, tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`다. 현재는 부모가 제공할 독립 SOURCE 판정, 원격 고정본, 공통 정확한 모델/effort/API 인증 방식, 선행 검사 결과와 host evidence capture 설정을 기다린다. 이전 main이나 c6a8019로 시험을 대체하지 않는다. c6a8019는 기존 지침의 hash provenance를 읽는 데만 사용했다.

재개 시 Sol은 후보·입력·설정·근거·비용을 관리하고, fresh Claude Code가 실제 원문을 처리하고 host workflow와 clarification을 수행한다. oracle과 과거 결과를 Claude 입력에 넣지 않는다. 실제 NEEDS_INPUT/null transcript와 도구 관측을 수집하며 accepted-selection receipt를 꾸며내지 않는다. 구체적 단계·기대값·재개 조건은 execution-plan.json, 비용 원장은 cost-ledger.json에 있다.

게시 범위는 이 고유 SS12 run의 정제된 보고서·근거·해시 목록뿐이다. 기존 evidence 브랜치에 추가 commit으로 게시하고 고정 원격 commit의 각 파일 bytes를 다시 읽어 대조한다. force push, 다른 작업 파일 덮어쓰기, 비밀값·개인정보·원본 채팅 게시를 하지 않는다.
