# v1.15.0 — 한국어 산문 품질 게이트 통과, 용어집 정정, Claude 스킬 트리거

## 핵심 변경

- 한국어 산문 워크플로의 품질 게이트를 동결 frame `0.3.0-gate-1`(130건, legacy 100·holdout 30)에서 정식으로 1회 실행해 `EVALUATION_EVIDENCE_PASSED`를 얻었습니다. 재집계 지표는 legacy improvement 58/65, holdout improvement 19/20, restraint 45/45, protected exact 130/130, major meaning change 0건입니다. 결과 digest와 actor 기록은 `docs/roadmap.md`에 있고 원문이 담긴 cycle 산출물은 저장소 밖에 보관합니다.
- direct/MCP 용어집 짝 비교(66건)를 동결 게이트와 분리해 실행했습니다. MCP arm은 protect 12/12 보존, allow 12/12 비결함, canonical화가 안전한 avoid 13/13·prefer 8/8 반영, keep 9/9 유지였고 블라인드 A/B에서 신규 개선 20건·회귀 2건이었습니다.
- 회귀 사례를 독립 심의 패널로 검토한 결과 용어집 항목 `completion-result-ko`(`완료 영수증`→`완료 결과`)의 `sourceRef`가 무관한 역사 용어를 가리키고 해당 표현이 저장소 밖에서 관측되지 않아, 항목을 `active: false`로 내리고 출처와 priority를 정정했으며 용어집 데이터 버전을 `1.2.1`로 올렸습니다.
- `korean-prose-editor`의 검증 rubric과 선정·편집 정책에, 내부 구현 표현 치환에서 낱말 변화 자체는 「용어」 변화가 아니지만 고정 명칭·실제 대상 가능성을 배제할 수 없으면 `UNCERTAIN`이며 직역 은유 규정이 "확인 불가면 원문 유지" 기본값을 대체하지 않는다고 명시했습니다.
- `eval:receipt:verify`에 `--expected-quality-report-digest`를 추가해 품질 증거가 통과한 cycle의 receipt도 검증할 수 있게 했습니다. 이 스크립트는 toolchain digest에 포함되므로 이후에 동결하는 frame부터 적용됩니다.
- Claude Code 배포물의 스킬 `description` 17개를 `claude-overlay/replacements.json`으로 치환해, 제외 조항 대신 트리거 상황("커밋 전", "삭제·배포 직전", "같은 실패가 반복될 때" 등)을 앞세웁니다. Claude Code는 Codex의 `agents/openai.yaml` 암시 호출 정책을 읽지 않고 `description` 한 줄로만 스킬을 고르기 때문입니다. 원본 `skills/`와 Codex 배포물은 바뀌지 않습니다.

## 배경

이전 릴리스까지 한국어 산문 워크플로는 사용자 승인으로 활성화돼 있었지만 신규 holdout의 `≥80%` 지표가 생성된 적이 없었습니다. 이번 릴리스는 그 증거를 만들고, 그 과정에서 드러난 용어집 항목의 출처 문제와 정책 문언의 우선순위 공백을 함께 고칩니다. Claude Code에서 플러그인 스킬이 거의 호출되지 않던 원인을 조사한 결과 트리거 수단이 `description` 한 줄뿐인데 그 문장이 "언제 쓰지 않는지"만 말하고 있었으므로, 생성 사본의 문장을 바꿉니다.

## 호환성

- 용어집 binding·match-set·receipt 계약의 `version` 상수가 `1.2.0`에서 `1.2.1`로 바뀝니다. MCP 호출자는 새 용어집 version을 사용해야 하며 이전 binding은 거부됩니다.
- 스킬 구성, 공개 workflow 계약 schema, SQLite schema는 v1.14.1과 같습니다. MCP 서버 동작과 실행 보증 경계(`BINDING_REQUIRED`)는 바뀌지 않습니다.
- `korean-prose-editor`는 편입 스킬이므로 `skills/source-lock.json`의 `integratedChecksum`과 `downstreamModifications`를 갱신했습니다. `0.3.0-gate-1`은 이전 suite revision과 skill checksum에 결속돼 있어 재검증하려면 해당 revision을 체크아웃해야 하며, 결과 자체는 바뀌지 않습니다.
- 정책 문서 3개의 변경은 독립 저장소 `jaeseongs95/korean-prose-editor`에도 반영해 `v0.1.1`로 태그합니다. 이번 릴리스의 고정 commit은 옮기지 않습니다.

## 알려진 제한

- 실행 모델 정보는 host attestation adapter가 없어 caller-asserted입니다.
- 짝 비교 도구는 저장소 밖 `eval-tools/`에 있으며 저장소에 편입되지 않았습니다.
- 용어집 binding이 언어 역할의 독립 확인을 건너뛰게 하는지(anchoring)는 arm당 actor 1명 조건에서 확정하지 못했습니다.
- 새 스킬 description은 설치된 플러그인을 갱신한 뒤 새 세션에서만 반영됩니다.
