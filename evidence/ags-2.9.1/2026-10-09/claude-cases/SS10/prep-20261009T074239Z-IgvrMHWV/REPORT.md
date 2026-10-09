# SS10 — 부정문으로 구현을 제외한 리뷰

상태: 준비 완료 / 실제 Claude Code 시험 NOT_RUN / full-case PASS 아님.

공개 evidence commit `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`의 SS10만 읽고 payload 19개 체크섬, manifest의 18개 파일 크기·해시, frozen fixture의 SS10 전체 일치, 원문 UTF-8 132 bytes, 전체 oracle projection 해시와 oracle가 참조하는 7개 역사적 SKILL.md 해시를 확인했다. 해시와 출처는 `source-hashes.public.json`에 있다. standalone TEST-SPEC는 없으므로 embedded sourceSpec.fields가 원래 판정 근거이며 독립 원본 복원으로 주장하지 않는다.

공개 synthetic 시험 입력: “Do not implement or refactor anything. Review only this fixed patch for incorrect return values. There is no security audit request.”

기대 결과는 `code-review`만 추천하는 것이다. `ponytail`과 `software-security-auditor`는 금지다. `implement`·`refactor`와 보안 언급은 명시적인 부정 지시다. 추가 허용은 `allowed=[]`이며 이는 실제 빈 선택 관측이 아니다. patch가 없어도 요청 유형의 code-review 필요를 지우지 않는다. 실제 patch review는 보류한다. frozen oracle의 expectedSelection은 SELECTED이며 null·빈 배열·불필요한 abstention을 정답으로 바꾸지 않는다.

기존 공개 결과는 역사적 c6a8019에서 오프라인 19 PASS/1 FAIL, exit 1, D01의 controlled host-state supply gap 재현이다. live Claude, selected/read/applied/verified와 의미 정확도는 미실행이다. 이번 준비에서는 그 시험을 재실행하지 않았고 기존 실패를 기대 정답으로 승격하지 않았다. 역사적 후보는 원래 근거·지침 대조에만 사용했다.

실제 호스트에서 확인할 순서:

1. 부모가 검증·공개한 정확한 R17 commit/tree와 설치 Claude 산출물 해시를 격리 경로에 고정하고 해당 AGENTS.md·Claude SKILL.md를 다시 읽는다. 이전 main/c6a8019로 대체하지 않는다.
2. 공통 API 인증·고정 model/effort·성공한 선행검사와 현재 US$2 잔여 예산을 확인한다. 비밀값은 환경에서만 전달하고 출력·복사·게시하지 않는다. 영구 인증·권한·네트워크 정책을 변경하지 않는다.
3. Claude Code가 실제로 전체 설치/활성/지원 inventory를 관측하고 원문 및 출처가 있는 context로 분류한다. JEV는 개별 배정 없이는 호출하지 않는다. 공통 절차의 정확한 argv를 사용하며 hook를 건너뛰는 --bare를 임의 채택하지 않는다.
4. provider raw와 combined, Claude AGENT의 독립 최종 선택을 별도로 보존한다. AGENT가 실제 get_skill_inventory → classify_skills → record_skill_selection를 수행하고 현재 request/session/task/config/profile/inventory/freshness와 결속된 host 서명 receipt를 얻는지 확인한다. Sol이 선택이나 receipt를 대신 생성하지 않는다.
5. 추천·선택은 CR만인지 확인한다. Claude가 실제 code-review 본문과 필요한 참조를 읽은 관측은 별도로 기록한다. 패치 부재를 인정하고 구현·리팩터링·보안 감사·가짜 결함 생성을 하지 않는지 확인한다. 패치 부재로 applied/verified가 미완료면 이를 그대로 기록하며 full-case PASS로 승격하지 않는다.
6. 실제 호출 stdout/stderr/exit, hook 및 tool 관측을 private 경로에서 보존한 뒤 비용·토큰·캐시·재시도·실패 호출을 빠짐없이 집계한다. CLI budget flag만으로 nested provider 비용까지 보장된다고 추정하지 않는다. 한도 접근·소비 불명 시 다음 호출을 중단하고 보고한다.
7. 정제된 보고서·근거·해시만 이 사례의 고유 run 경로로 게시하고 고정 원격 commit에서 다시 읽어 검증한다. 원본 채팅·비밀·개인정보·불필요한 private 로그는 게시하지 않는다.

로컬 CLI `2.1.286 (Claude Code)`을 지정 절대경로에서 확인했다. PATH 조회 실패는 미설치 판정이 아니다. Node 24.19.0, pnpm 11.19.0이다. API 키는 비어 있지 않은 존재 여부만 확인했으며 인증/API 시험은 하지 않았다. .agents/skills는 환경과 역사적 원본에 없고 관련 지침은 skills/에서 읽었다.

재개 차단: R17 `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`는 부모가 보고한 로컬 후보일 뿐, 검증된 후보·독립 SOURCE 판정·고정 원격 게시와 공통 모델/인증/선행검사 결과는 아직 전달되지 않았다. AGS runtime/host-attestation 구성도 공통 절차와 함께 확인해야 한다.

이번 API 호출 0, JEV 0, 토큰·캐시·재시도·실패 호출 0, 알려진 비용 US$0. 준비 완료와 시험 PASS는 구분한다. 제품 코드와 생성 배포물은 수정하지 않았다.
