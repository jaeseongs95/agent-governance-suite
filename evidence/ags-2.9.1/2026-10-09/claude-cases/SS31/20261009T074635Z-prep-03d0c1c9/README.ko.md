# SS31 — timeout과 결과 불명

준비 완료 / 부모 입력 대기. 실제 Claude Code 제품 시험은 NOTRUN이며 PASS 판정이 아니다. 이번 실행의 Claude·JEV·vendor API 호출은 각각 0회, 비용 US$0, 토큰·캐시·재시도·실패 호출 0이다. 제품 코드와 생성 배포물은 수정하지 않았다.

고정 입력은 공개 evidence commit `af579e2caa8c09b380bdf88b5e9c675b0b0b9c68`의 `cases/SS31/`에서 읽었다. manifest payload 45개와 SHA256SUMS 항목 46개 모두 바이트 수·SHA256 검증에 통과했다. 이 결과는 파일 무결성 준비 확인이다. 원래 제목은 “timeout과 결과 불명”, 실행종류는 `mock.`이며 입력은 “확실한 미전송 timeout, 전송 뒤 응답 없는 timeout, 전송 여부도 불명인 timeout, timeout 뒤 늦게 성공하는 응답을 각각 주입한다.”이다. 정확한 원래 fields는 original-input-and-criteria.json에 보존했다.

입력 UTF8 SHA256는 `8e3cd8c4633c42b293685eb2452bbe6379123202957d5b243c2deab3d58bc655`(161 bytes), 공개 단일 fixture SHA256는 `bc53e0835e112ae97e7a16fb0331396e9cd1b6b877e726589526b06e74dc43fa`, 원래 SS31 SHA256SUMS SHA256는 `99ca53022dcba4b8fe228c11df34386980b824cc35e6d1b5a7bb9f62894e1348`이다. 원래 전체 corpus와 oracle hash는 고정 기록이 보고하는 역사적 지문이며 이번 준비에서 해당 원본 전체를 재계산하지 않았다. 정제 전 원본 지문과 공개본 manifest 지문을 혼용하지 않는다.

기대 결과는 미전송 확정 timeout/not-started, 전송·소비 불명 uncertain/timedOut=true/started 또는 unknown 진단이다. JEV 시도 최대 1회와 허용된 vendor fallback 최대 1회를 각각 세고, 실제 HTTP 전송과 비용을 분리한다. 늦은 응답은 현재 결과나 fallback을 덮거나 이중 완료하지 않아야 한다. JEV 비용은 확인 전 unknown과 보수적 예약으로 유지하며 vendor 비용을 별도 기록한다. 취소 신호는 취소·무과금 확인이 아니다. 정책 밖 경로나 자동 JEV 재전송은 금지다. 허용된 fallback 성공은 JEV 실패 이력을 남긴 채 수락 가능하며 fallback 불가의 UNAVAILABLE/UNCERTAIN 보류를 임의로 실패 정답으로 바꾸지 않는다. B 목적 적합성은 별도 확인한다.

기존 c6a8019 결과는 오프라인 FAIL, 회귀 3 PASS/37 SKIPPED, 격리 12 PASS/2 FAIL, 실제 host 4단계 NOTRUN이다. credential second-read gap과 Node timer overflow가 역사적 결함이며 현재 후보 판정은 미실행이다. exploratory의 UNCERTAIN-only 두 assertion은 원래 허용 기준과 충돌하여 정정된 기록이므로 새 제품 결함으로 집계하지 않는다.

CLI는 `/workspace/cloud-tools/claude/node_modules/.bin/claude`에서 `2.1.286 (Claude Code)`을 재확인했다. PATH에는 없지만 지정 실행파일은 존재한다. 로컬 --version/--help만 실행했고 API 인증이나 모델 호출은 하지 않았다. Node v24.19.0와 기존 Vitest/TypeScript 경로를 확인했지만 후보 dependency 일치는 미확인이다. 기존 product checkout의 AGENTS.md와 관련 SKILL.md는 준비 절차로만 읽었다. .agents/skills가 없음을 확인하고 repository skills/를 읽었으며 검증된 후보에서 다시 읽는다. 과거 main을 시험하지 않았다.

재개에는 부모의 검증된 후보·독립 SOURCE 판단·원격 고정 출처·선행 검사 결과, 공통 Claude 정확한 model/effort/flags와 성공한 API 인증 방식이 필요하다. R17 `fa1e250c1cbc4f8f446f2e2ddeb516f4e439edbb` / tree `43d2b4e49cdb6993c48d7adc792a3ef17426092e`는 전달된 잠정 식별자이며 독립 SOURCE와 원격 게시가 미확인이다. main이나 c6a8019로 대체하지 않는다. JEV 실제 호출은 별도 배정 전 금지다. 영구 인증·권한·네트워크 정책을 변경하지 않는다.

승인된 설치·classification config/profile/qualification/route/budget, 실제 task/hook/inventory가 준비되어야 한다. 공개 fixture의 originalPrompt/oracle은 null이며 sourceSpec 원본 파일, raw HTTP wire, 서명된 host receipt와 E0·E1·E2 정의, B의 실제 목적 기대값은 누락되어 있다. 공개 synthetic request를 실제 사용자 원문이나 의미 정답으로 승격하지 않는다. 이 근거가 없으면 mock 성공과 별개로 전체 host/B 판정은 BLOCKED/NOTRUN을 유지한다.

execution-plan.json에는 그대로 유지할 14개 subcase와 실제 Claude host에서 수행할 절차·명령 템플릿을 기록했다. Sol은 환경과 근거를 관리하고 Claude가 직접 host 도구로 읽기·적용·시험·검증을 수행해야 한다. US$2는 준비 호출을 포함한 사례 소프트 상한이며 소비 목표가 아니다. 비용·토큰·캐시·재시도·실패·미확정 청구를 모두 기록하고 한도 접근 시 다음 호출을 멈춘다. 원본 채팅·비밀·개인정보·raw session transcript는 게시하지 않는다.

게시 대상은 기존 evidence 브랜치의 `evidence/ags-2.9.1/2026-10-09/claude-cases/SS31/20261009T074635Z-prep-03d0c1c9/`이며 이 디렉터리의 정제된 보고서·준비 근거·해시 목록만 추가한다. 게시 성공과 고정 원격 파일 재읽기 결과는 별도 publication receipt로 확인한다.
