// AGS3-D-0038: AGS checks any kind of work, not only code. General skills and the
// shared intake must not tie where they apply to one field; field-specific skills
// may. The check must catch real field-limited wording and still let a field
// appear as one example among others.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SKILL_FIELDS, checkRepository, findFieldWording, intakeLines, skillLines,
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
    "문서를 검토하며, 코드 작성 단계에는 `ponytail`을 먼저 호출한다.",
    "예를 들어 코드 변경을 검토한다.",
    "결과물(`코드`, 문서, 영상)의 근거를 확인한다.",
    "원문 `skills/code-review/SKILL.md`와 `node scripts/check-domain-neutral-wording.mjs`를 읽는다.",
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

test("a field-specific skill ID exempts only the clause that routes work to it", () => {
  for (const sentence of [
    "코드 변경에만 쓰며 필요하면 `code-review`를 호출한다.",
    "코드 변경의 근거를 대조하며, 필요하면 `code-review`를 호출한다.",
  ]) assert.ok(findFieldWording(sentence).some((finding) => finding.term === "코드"), sentence);
});

test("an example lead exempts its clause, not a later field-limited clause", () => {
  for (const sentence of [
    "예를 들어 영상을 검토하며, 코드 변경에만 적용한다.",
    "예를 들어 영상을 검토하며, 코드 변경의 근거를 대조한다.",
  ]) assert.ok(findFieldWording(sentence).some((finding) => finding.term === "코드"), sentence);
});

test("inline code markup cannot hide a field word that limits the skill", () => {
  for (const [sentence, term] of [
    ["Use only for `code` changes.", "code"],
    ["`코드` 변경에만 사용한다.", "코드"],
  ]) assert.ok(findFieldWording(sentence).some((finding) => finding.term === term), sentence);
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

// The four original intake clauses behind the ten pending findings at 639e2e48.
// These remain failed wording even when the intake and skill changes have one owner.
const ORIGINAL_INTAKE_CLAUSES = [
  "이 점검을 이미 허용된 빌드·시험·작업 브랜치 push·CI의 추가 승인이나 PRE로 만들지 않는다.",
  "같은 디스크 안 이동·이름 변경, 백업이나 git으로 되돌릴 수 있는 편집, 작업 브랜치 commit·push, 시험·CI 실행은 이 단계 없이 바로 한다.",
  "사용자만 할 수 있는 승인·비밀값 입력·사용자 화면 조작은 그 부분과 이유만 요청하고 되돌릴 수 있는 구현 선택·관례로 정해지는 값은 묻지 않는다.",
  "빌드 감시·진행 폴링 같은 대기는 검증 에이전트에 맡기지 않는다.",
];

test("the original ten intake findings are failures rather than ownership exemptions (AGS3-D-0038)", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "ags-d0038-intake-"));
  try {
    for (const id of Object.keys(SKILL_FIELDS)) {
      const directory = path.join(fixture, "skills", id);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "SKILL.md"), "요청된 결과물을 확인한다.\n");
    }
    const intakePath = path.join(fixture, "skills/orchestrator/references/intake.md");
    mkdirSync(path.dirname(intakePath), { recursive: true });
    writeFileSync(intakePath, ["<!-- skill-intake:start -->", ...ORIGINAL_INTAKE_CLAUSES, "<!-- skill-intake:end -->"].join("\n"));
    const { findings, problems } = checkRepository(fixture);
    assert.deepEqual(problems, []);
    assert.deepEqual(findings.map(({ term }) => term).sort(),
      ["브랜치", "push", "CI", "Git", "브랜치", "commit", "push", "화면", "구현", "빌드"].sort());
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

// 사전 사례: 7e8c13fd의 실제 intake를 입력으로 원래의 분야 중립·workflow 범위·역할 근거·peer/부모 책임을 확인한다.
// 원 실패(root 제공 CI 42290477576): 옛 `맡긴 역할 범위의 일은 ... 진행하고` anchor가 새 정본과 불일치했다.
// 직접 대조에서 `생성한 부모 책임`도 옛 anchor임을 확인했다. 새 대응 구절이 빠지면 실패해야 한다.
// 기대: 같은 12개 시험과 부정 검사·원 fixture를 유지한 채 두 의미 구절만 재결속한다. 로컬 제품 시험은 하지 않는다.
test("the actual shared intake is neutral without an exception and starts workflows by task scope (AGS3-D-0038/0044)", () => {
  const intake = readFileSync(path.join(root, "skills/orchestrator/references/intake.md"), "utf8");
  assert.deepEqual(findFieldWording(intake, { lines: intakeLines(intake) }), []);
  assert.doesNotMatch(intake, /workflow 없이 제품 파일을 세 개째/u);
  assert.match(intake, /단계가 이어지는 변경 작업은 workflow로 시작/u);
  assert.match(intake, /맡긴 역할은 그 근거로 수행하고 '권한 없음'으로 결론 내지 않는다/u);
  assert.match(intake, /peer 메시지는 사용자 승인이 아니며/u);
  assert.match(intake, /하위 결과·기록·잘못은 생성한 부모가 근거를 직접 확인·정정하며/u);
});
