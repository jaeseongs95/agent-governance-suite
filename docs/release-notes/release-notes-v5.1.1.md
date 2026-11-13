# AGS 5.1.1 Release Notes

AGS 5.1.1 is a hotfix release. It adds one paragraph to the `independent-audit-gate` skill so that an audit is performed as an exclusive adversarial review. Tool input and output contracts, storage file formats, hooks and the MCP server behavior are unchanged.

## Before upgrading

- No action is required. There are no breaking changes, and the 5.1.0 data is used as it is.

## Changes

- **`independent-audit-gate` states the audit stance.** The skill now says, in Korean as the rest of its body: 「감사는 배타적 적대적 검수로 한다. 감사자는 작성자의 보고와 판단에 기대지 않고, 대상이 맞다는 생각을 버린 채 결함을 찾는다.」 (An audit is an exclusive adversarial review: the auditor does not rely on the author's report or judgment, and looks for defects after discarding the assumption that the target is correct.) The skill's classification spans were moved to the new line numbers with their text unchanged, and the change is registered as a reviewed successor of the 5.1.0 bytes.

## Verification

Candidate: the `hotfix/5.1.1` commit tagged `v5.1.1`.

- Run on Windows (this machine): `pnpm lint`, `pnpm release:check`, `pnpm claude:check`, `pnpm bundle:check`, `pnpm source:check`, `git diff --check` and `pnpm test`. The results are listed in the GitHub Release of this version.
- Not run: GitHub Actions CI (this project no longer runs it), Linux, and real-host checks on Codex and Antigravity.

---

# AGS 5.1.1 릴리스 노트

AGS 5.1.1은 핫픽스 판입니다. `independent-audit-gate` 스킬에 문단 하나를 더해 감사를 배타적 적대적 검수로 하도록 했습니다. 도구 입력·출력 계약, 저장 파일 형식, 훅과 MCP 서버 동작은 바뀌지 않았습니다.

## 업그레이드 전 확인

- 따로 할 일은 없습니다. 깨지는 변경이 없고 5.1.0의 데이터를 그대로 씁니다.

## 바뀐 점

- **`independent-audit-gate`가 감사 태도를 적습니다.** 스킬 본문에 「감사는 배타적 적대적 검수로 한다. 감사자는 작성자의 보고와 판단에 기대지 않고, 대상이 맞다는 생각을 버린 채 결함을 찾는다.」를 넣었습니다. 스킬 분류 근거 범위는 글은 그대로 두고 새 줄 번호로 옮겼고, 이 변경을 5.1.0 바이트의 검토된 후속으로 등록했습니다.

## 검증

후보는 `v5.1.1` tag가 붙은 `hotfix/5.1.1` 커밋입니다.

- Windows(이 PC)에서 실행: `pnpm lint`, `pnpm release:check`, `pnpm claude:check`, `pnpm bundle:check`, `pnpm source:check`, `git diff --check`, `pnpm test`. 결과는 이 판의 GitHub Release에 적습니다.
- 실행하지 않음: GitHub Actions CI(이 프로젝트는 더 이상 돌리지 않습니다), Linux, Codex·Antigravity 실호스트 확인.
