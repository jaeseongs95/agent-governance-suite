// AGS3-D-0038: AGS checks any kind of work, not only code. General skills and the
// shared intake must not tie where they apply to one field; field-specific skills
// may. The check must catch real field-limited wording and still let a field
// appear as one example among others.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  SKILL_FIELDS, checkRepository, findFieldWording, skillLines,
} from "../../scripts/check-domain-neutral-wording.mjs";

const root = path.resolve(import.meta.dirname, "../..");

// The ui-ux-design description before AGS3-D-0037 (698b0390), limited to screens.
const SCREEN_ONLY_DESCRIPTION = `---
name: ui-ux-design
description: >-
  웹·데스크톱·모바일의 사용자 흐름, 화면 구조, 시각적 계층과 상호작용을 설계·진단·개선한다.
  UI/UX 설계·검토·구현을 요청하거나 허용된 개발에서 화면·탐색·입력·접근성·반응형·대용량 표시를 실제로 다뤄야 할 때 사용한다.
  일반 질의·순수 백엔드·비시각적 CLI 작업, UI라는 단어만 포함한 로그, 아이콘·이미지 생성만 필요한 요청, 독립 감사·출시 승인만 필요한 요청에는 자동 적용하지 않는다.
---
`;

// The same description after AGS3-D-0037 (1cd5f20b): every medium people see and use.
const MEDIUM_NEUTRAL_DESCRIPTION = `---
name: ui-ux-design
description: >-
  사람이 보고 이해하고 행동하는 결과물(화면, 인쇄·광고, 영상, 공간·안내물, 제품, 서비스 절차, 문서·양식)의 사용자 흐름·정보 계층·행동 유도·접근성·예외 상황을 설계·점검하고, 결과물이 대상 사용자에게 실제로 통하는지 확인한다.
  UI/UX·사용자 경험의 설계·검토를 요청하거나 허용된 작업에서 이런 결과물의 동선·구성·문구·입력·접근성·상태를 실제로 다뤄야 할 때 사용한다.
  일반 질의·순수 백엔드·비시각적 CLI 작업, UI라는 단어만 포함한 로그, 아이콘·이미지 생성만 필요한 요청, 독립 감사·출시 승인만 필요한 요청에는 자동 적용하지 않는다.
---
`;

const scan = (markdown) => findFieldWording(markdown, { lines: skillLines(markdown) });
const terms = (findings) => [...new Set(findings.map((finding) => finding.term))].sort();

test("the screen-only ui-ux-design description is caught on its applicability lines", () => {
  const findings = scan(SCREEN_ONLY_DESCRIPTION);
  assert.deepEqual(terms(findings), ["개발", "데스크톱", "모바일", "웹", "화면"]);
  assert.deepEqual([...new Set(findings.map((finding) => finding.line))], [4, 5]);
});

test("the medium-neutral ui-ux-design description passes", () => {
  assert.deepEqual(scan(MEDIUM_NEUTRAL_DESCRIPTION), []);
});

test("a field named as one example among others, or as an explicit branch, passes", () => {
  for (const sentence of [
    "결과물(코드, 문서, 영상)의 근거를 확인한다.",
    "디자인·편집·촬영·구현 같은 제작은 맡은 에이전트가 한다.",
    "목적이 이미 이뤄졌는지 실제 상태(예: PR이면 base와 head의 포함 관계)로 확인한다.",
    "화면이면 아래 기준을 함께 적용한다.",
    "## 화면일 때\n\n- 기존 컴포넌트를 재사용하고 렌더링을 정리한다.",
    "구현, 반복 실패 원인 분석, 릴리스 승인에는 사용하지 않는다.",
    "코드 작성 단계에는 `ponytail`을 먼저 호출한다.",
    "명령의 종료 코드 0만으로 동작을 인정하지 않는다.",
  ]) assert.deepEqual(findFieldWording(sentence), [], sentence);
});

test("a sentence that ties the work to one field is caught, even inside an exclusion clause that limits it", () => {
  for (const [sentence, term] of [
    ["코드 변경의 근거를 수용 기준별로 대조한다.", "코드"],
    ["구현자와 분리된 감사자가 최종 변경을 확인한다.", "구현"],
    ["diff 크기보다 실패 영향을 기준으로 판단한다.", "diff"],
    ["작업 브랜치 commit/push와 CI 실행은 별도 승인을 요구하지 않는다.", "CI"],
    ["허용된 개발 작업에서 모델에 전달할 지시를 바꿀 때 사용한다.", "개발"],
    ["Use when reviewing code changes.", "code"],
    ["코드 작업에만 쓰고 그 밖의 작업에는 쓰지 않는다.", "코드"],
    ["구현자와 분리된 검토자로서 판정하고, 승인 결정을 대신하지 않는다.", "구현"],
  ]) assert.ok(findFieldWording(sentence).some((finding) => finding.term === term), `${term}: ${sentence}`);
});

test("every skill is classified as general or field-specific, and the code-only skills are field-specific", () => {
  const skills = readdirSync(path.join(root, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && readdirSync(path.join(root, "skills", entry.name)).includes("SKILL.md"))
    .map((entry) => entry.name).sort();
  assert.deepEqual(Object.keys(SKILL_FIELDS).sort(), skills);
  for (const id of ["ponytail", "code-review", "test-engineering", "software-security-auditor"]) {
    assert.equal(typeof SKILL_FIELDS[id], "string", id);
  }
  for (const id of ["acceptance-evidence-validator", "independent-audit-gate", "mutation-risk-preflight", "blocker-diagnostician",
    "task-contract", "orchestrator", "ui-ux-design"]) {
    assert.equal(SKILL_FIELDS[id], null, id);
  }
});

test("the general skills, their Claude package copies and the intake block pass the check", () => {
  const { findings, problems } = checkRepository(root);
  assert.deepEqual(problems, []);
  assert.deepEqual(findings, []);
});

test("CI runs the check through pnpm lint", () => {
  const { scripts } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(scripts.lint, /node scripts\/check-domain-neutral-wording\.mjs/u);
});
