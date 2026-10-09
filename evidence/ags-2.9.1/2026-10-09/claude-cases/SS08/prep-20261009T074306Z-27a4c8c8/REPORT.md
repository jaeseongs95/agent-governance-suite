# SS08 — 이름으로 지정한 스킬

상태: **준비 완료 · 부모 인계 대기**. 실제 Claude 제품 시험은 **NOTRUN**이며 PASS를 주장하지 않는다. 유료 Claude/JEV 호출, 재시도와 실패 호출은 모두 0회이고 비용·토큰·캐시는 0이다. 사례 예산 US$2는 준비 호출을 포함하며 소비 목표가 아니다.

원래 공개 입력은 `$cs-engineering 으로 이 retry 설계의 멱등성과 자원 수명만 분석해 줘. 코드 작성과 타 스킬 호출은 하지 마.` 이다. 원문은 추가 개행 없는 UTF-8 137바이트이며 SHA-256은 `92b030041d6deb5424cb8e9f4dc1c8a531b05814fec7e85d6839c4f4be07c1c7`이다. 입력·sourceSpec·oracle는 [원본 공개 source](https://github.com/jaeseongs95/agent-governance-suite/blob/af579e2caa8c09b380bdf88b5e9c675b0b0b9c68/evidence/ags-2.9.1/2026-10-09/cases/SS08/inputs/SS08.source.json)에 고정되어 있다. 이 폴더의 inputs에는 같은 공개 bytes만 보존했다.

기대 결과는 `explicitSkillIds=[cs-engineering]`, 필수 CS 보존, 허용 추가 스킬 없음, `ponytail`·`orchestrator` 대체 금지이다. 코딩·자동 위임·다른 스킬 호출·새 workflow 생성은 금지이다. raw 분류가 CS를 놓치면 그 실패를 남기고, select에서 유효한 명시 CS가 보존되어도 raw 성공으로 계산하지 않는다. 미설치·미지원이면 needed를 보존하고 runnable/admission의 막힘을 드러내야 한다. 미관측 selected IDs와 receipt는 null로 남겨야 하며 관측된 빈 배열과 구분한다.

고정 evidence commit `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`의 SS08 파일 25개를 읽고 해시했다. SHA256SUMS의 24개 항목과 manifest의 23개 payload는 모두 일치한다. source JSON SHA-256은 `b06da7e4ff34fb68a01ffa979e5290c2ac5efcace295511df5169009f77cf26d`이다. 역사적 fixture SHA-256 `17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9`, frozen oracle SHA-256 `5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055`, 원래 sourceRefs 7개도 공개 Git bytes에서 재계산해 일치를 확인했다. 이는 읽기 전용 provenance 검사이며 제품 시험이 아니다. 외부 `TEST-SPEC.seq7.ko.md`와 일부 원본 로그는 공개 자료에 없으므로 발명하거나 확인했다고 쓰지 않았다.

기존 c6a8019 결과는 최종 isolated 13 PASS / 4 FAIL, exit 1, overall FAIL이다. 실제 selected/read/applied/verified는 모두 NOTRUN이고 실제 receipt/selected IDs는 null이다. 기존 네 실패 원인과 mock 비용은 역사적 결과로 유지한다. 이 수치가 새 후보의 기대 정답이나 실호스트 시험 결과를 뜻하지 않는다. 재실행하지 않았다.

Claude CLI `/workspace/cloud-tools/claude/node_modules/.bin/claude`는 로컬에서 `2.1.286 (Claude Code)`으로 재확인했다. PATH 검색에서는 발견되지 않지만 지정 경로의 실행 파일은 존재하고 --version/--help가 exit 0이다. Node v24.19.0, pnpm 11.19.0이다. 로컬 AGENTS.md와 관련 SKILL.md, 공개 sourceRefs를 읽었고 workspace/repo `.agents/skills`는 없다. evidence 고정 commit은 제품 AGENTS.md가 없는 근거 전용 트리이다. 현재 읽은 로컬 지침은 준비·게시 절차용이며 제품 후보로 시험하지 않았다.

재개 시 부모가 검증한 고정 후보·tree·원격 bytes와 독립 SOURCE 판정, 공통 Claude 모델·effort, 성공한 API 인증 절차와 선행 검사 결과를 먼저 받아야 한다. 알려진 R17 `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`는 전달받은 미검증 정보이며 승인된 시험 대상으로 간주하지 않았다. main·c6a8019 대체 시험은 하지 않았다. JEV는 별도 배정 전 시작하지 않는다.

재개 절차와 전체 frozen oracle는 resume-plan.public.json에 기록했다. 실제 Claude Code가 호스트 작업을 수행하고 Sol은 환경·근거를 관리한다. 원문 입력 해시를 확인한 뒤 raw/explicit/select를 분리 기록하고, actual selected receipt → cs-engineering 읽기 → 주어진 retry 설계에 적용 → 같은 대상의 검증 근거를 확보한다. retry 설계 자료가 아직 없으므로 applied/verified는 막혀 있다. 이 부재가 CS 필요성을 없애지는 않는다. plugin/MCP/hooks 관측도 인증 성공과 별도로 확인해야 한다. --bare는 hooks를 건너뛴다고 로컬 도움말에 명시되어 있어 그것만으로 호스트 시험 준비를 증명할 수 없다.

제품 소스·생성물, 영구 인증 설정, 권한·네트워크 정책은 수정하지 않았다. 공개 산출물은 SS08 고유 경로 `evidence/ags-2.9.1/2026-10-09/claude-cases/SS08/prep-20261009T074306Z-27a4c8c8`의 정제 보고서·공개 synthetic 입력·근거·해시뿐이다. 비밀값·개인정보·원본 채팅은 포함하지 않는다. 기존 evidence 파일과 다른 작업은 보존한다. 원격 게시와 고정 commit 재읽기 검증은 별도 최종 인계 결과로 보고한다.
