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
  REFERENCE_FIELDS, SKILL_FIELDS, checkRepository, findFieldWording, intakeLines, skillLines,
} from "../../scripts/check-domain-neutral-wording.mjs";

const root = path.resolve(import.meta.dirname, "../..");

// D38 reference-boundary cases (report SHA 413147043b1e391a791fd18b27712bd0764d3b6a2f9dcbd382b9f21a527b6cbb):
// R01: the four required source references and existing Claude copies contribute actual role/procedure findings.
// R02: restoring the 1aed repository/implementer/unconditional-runner sentences fails in each package.
// R03: deleting a required section/clause or changing its selection prefix fails rather than scanning zero lines.
// R04: conditional software execution, technical keys/evidence and field-specific skill routing remain valid.
// Keep the original 12 tests, ten negative findings and clause exceptions unchanged in meaning.
// Expected RED: the expanded check against source 1aed980a reports the original reference violations.
// TEST (root only): node --test tests/tooling/ags3-d0038-domain-neutral-wording.node-test.mjs
// Local product/model/TEST execution: NOT_RUN.

const REFERENCE_CASES = [
  { file: "skills/task-contract/references/entry-details.md", select: /^1\.[^\n]*/mu, term: "저장소",
    original: "1. 원 요청, 이미 결정된 사용자 선택과 하나 이상의 `instructionResolutionRefs`를 구분한다. 대상 저장소의 경로 비교 방식은 `pathSemantics`에 `windows` 또는 `posix`로 명시한다. 저장소 관례가 필요하고 이미 제공됐다면 `workspaceProfileRef`를 근거로 쓴다." },
  { file: "skills/independent-audit-gate/references/entry-details.md", select: /^- 감사자는[^\n]*/mu, term: "구현",
    original: "- 감사자는 구현·수정·구현자 검증에 참여한 에이전트와 다른 실제 worker여야 한다. 역할 이름만 바꾼 자기감사는 독립 감사가 아니다." },
  { file: "skills/independent-audit-gate/references/audit-protocol.md", select: /^(?:구현자|변경 작업자)는 명세를[^\n]*/mu, term: "테스트",
    original: "구현자는 명세를 테스트로 추가하고 표준 runner로 실행한다. 검증 의미나 최종 소스가 바뀌었다면 영향 범위의 테스트와 원시 결과를 6절에 따라 다시 확인한다. 실행 형식만으로 결과를 폐기하지 않으며, 권한 위반이나 재현 근거 부족은 해당 증거의 한계로 처리한다." },
  { file: "skills/independent-audit-gate/references/orchestrator-integration.md", select: /^- 상위 orchestrator[^\n]*/mu, term: "구현",
    original: "- 상위 orchestrator는 요청 유형 판별, 작업 순서, 구현자와 감사자 식별, fresh auditor 배정, 결과 전달을 맡는다." },
];

function copyReferences(fixture, withClaude = false) {
  // 3.9.0 (AGS3-D-0038): a listed field-specific reference must exist, so a fixture repository carries the folder.
  for (const field of Object.keys(REFERENCE_FIELDS)) mkdirSync(path.join(fixture, field), { recursive: true });
  for (const { file } of REFERENCE_CASES) for (const prefix of withClaude ? ["", "claude-plugin/"] : [""]) {
    const target = path.join(fixture, prefix + file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(path.join(root, file)));
    if (prefix) writeFileSync(path.join(fixture, prefix, "skills", file.split("/")[1], "SKILL.md"), "요청된 결과물을 확인한다.\n");
  }
}

function referenceFixture(withClaude = false) {
  const fixture = mkdtempSync(path.join(tmpdir(), "ags-d0038-reference-"));
  for (const id of Object.keys(SKILL_FIELDS)) {
    const directory = path.join(fixture, "skills", id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "SKILL.md"), "요청된 결과물을 확인한다.\n");
  }
  const intake = path.join(fixture, "skills/orchestrator/references/intake.md");
  mkdirSync(path.dirname(intake), { recursive: true });
  writeFileSync(intake, "<!-- skill-intake:start -->\n요청된 결과물을 확인한다.\n<!-- skill-intake:end -->\n");
  copyReferences(fixture, withClaude);
  return fixture;
}

function removeReferenceFixture(fixture) {
  assert.equal(path.dirname(path.resolve(fixture)), path.resolve(tmpdir()));
  assert.ok(path.basename(fixture).startsWith("ags-d0038-reference-"));
  rmSync(fixture, { recursive: true, force: true });
}

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
    // 4.0.0: ponytail retired; solid-design is the field-specific (code design) skill routed to here.
    "코드 작성 단계에는 `solid-design`을 먼저 호출한다.",
    "문서를 검토하며, 코드 작성 단계에는 `solid-design`을 먼저 호출한다.",
    // 4.0.0 English descriptions name the exclusion first.
    "Not for implementation, repeated-failure diagnosis or release approval.",
    "Not automatically for general questions, non-visual CLI work or logs merely mentioning UI.",
    "Do not use it for code review.",
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
    // An English exclusion lead covers only its own clause and never an "only" limit.
    ["Not for documents; use it for code changes.", "code"],
    ["Use only for code changes and not for documents.", "code"],
    ["Review code changes. Not for documents.", "code"],
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
  for (const id of ["solid-design", "code-review", "test-engineering", "software-security-auditor"]) {
    assert.equal(typeof SKILL_FIELDS[id], "string", id);
  }
  // 4.0.0: ponytail's AGS successor makes any kind of output, so it is general.
  assert.equal(Object.hasOwn(SKILL_FIELDS, "ponytail"), false);
  for (const id of ["minimal-implementation", "acceptance-evidence-validator", "independent-audit-gate", "mutation-risk-preflight", "blocker-diagnostician",
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
    copyReferences(fixture);
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

test("restored original reference wording is caught in all four sources and their Claude copies", () => {
  for (const prefix of ["", "claude-plugin/"]) for (const { file, select, term, original } of REFERENCE_CASES) {
    const fixture = referenceFixture(true);
    try {
      const target = path.join(fixture, prefix + file), current = readFileSync(target, "utf8");
      assert.match(current, select, file);
      const changed = "\n\n" + current.replace(select, original);
      writeFileSync(target, changed);
      const { findings, problems } = checkRepository(fixture);
      assert.deepEqual(problems, []);
      const line = changed.split(/\r?\n/u).indexOf(original) + 1;
      assert.ok(line > 0);
      assert.ok(findings.some(finding => finding.file === prefix + file && finding.line === line
        && finding.term === term && original.includes(finding.text)), `${prefix + file}: ${term}`);
    } finally { removeReferenceFixture(fixture); }
  }
});

test("missing required references fail, while a package without the skill remains excluded", () => {
  for (const prefix of ["", "claude-plugin/"]) for (const { file } of REFERENCE_CASES) {
    const fixture = referenceFixture(true);
    try {
      rmSync(path.join(fixture, prefix + file));
      assert.ok(checkRepository(fixture).problems.some(problem => problem.includes(prefix + file)
        && problem.includes("required reference missing")));
    } finally { removeReferenceFixture(fixture); }
  }
  const fixture = referenceFixture();
  try { assert.deepEqual(checkRepository(fixture).problems, []); }
  finally { removeReferenceFixture(fixture); }
});

test("deleted or reshaped required clauses and empty sections cannot pass with an empty selection", () => {
  for (const { file, select } of REFERENCE_CASES) for (const replacement of ["", "다른 형태의 구현자 절차다.", "```text\n구현자 절차다.\n```", "<!-- 구현자 절차다. -->"]) {
    const fixture = referenceFixture();
    try {
      const target = path.join(fixture, file), current = readFileSync(target, "utf8");
      assert.match(current, select, file);
      writeFileSync(target, current.replace(select, replacement));
      assert.ok(checkRepository(fixture).problems.some(problem => problem.includes(file)
        && problem.includes("required reference")), file);
    } finally { removeReferenceFixture(fixture); }
  }
});

test("technical keys and conditional software steps stay valid without exempting a later clause", () => {
  for (const sentence of [
    "저장소 관례가 필요하고 이미 제공됐다면 `workspaceProfileRef`를 확인한다.",
    ["소프트웨어 테스트와 표준 runner가 있는 경우에는", "그 runner로 확인한다."].join(" "),
    "```yaml\nimplementers: []\n```\n```markdown\n- Implementer(s):\n```",
    "직접 확인한 diff와 의미 동일성 근거를 기록한다.",
    "코드 작성 단계에는 `test-engineering`을 호출한다.",
  ]) assert.deepEqual(findFieldWording(sentence), [], sentence);
  for (const sentence of [
    "소프트웨어 테스트와 표준 runner가 있는 경우에는 확인하며, 구현자와 분리된 감사자가 판정한다.",
    "저장소 관례가 필요하고 이미 제공됐다면 확인하며, 대상 저장소의 방법을 강제한다.",
    "변경 작업자는 명세를 사례로 추가하고 표준 runner로 실행한다.",
    "직접 확인한 diff와 의미 동일성 근거를 기록하며, 구현자와 분리된 감사자가 판정한다.",
  ]) assert.ok(findFieldWording(sentence).length > 0, sentence);
});
