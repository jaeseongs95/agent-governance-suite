// AGS is not a coding plugin (AGS3-D-0038). A general skill checks any kind of
// work (video, ads, documents, operations, code), so its wording must not tie
// where it applies to one field. This check finds field-limited words in the
// description and body of every general SKILL.md, in the source tree and in the
// generated Claude package (which carries the Claude overlay descriptions), and
// in the shared intake block.
//
// Usage: node scripts/check-domain-neutral-wording.mjs
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Every skill is general (null: it applies to any field of work) or
 * field-specific (the field it exists for). A field-specific skill's field
 * words are its subject, so only general skills are checked.
 */
export const SKILL_FIELDS = Object.freeze({
  "acceptance-evidence-validator": null,
  "blocker-diagnostician": null,
  "coordinate-subagents": null,
  "evaluation-validity-auditor": null,
  "independent-audit-gate": null,
  "independent-deliberation-panel": null,
  "iteration-frame-auditor": null,
  "model-effort-advisor": null,
  "mutation-risk-preflight": null,
  "orchestrator": null,
  "prompt-engineering": null,
  "recovery-strategy-selector": null,
  "session-board": null,
  "task-contract": null,
  "ui-ux-design": null,
  "change-scope-guardian": "Git 작업 트리의 변경 범위",
  "code-review": "코드 변경분 검토",
  "codex-token-usage-analyzer": "Codex 세션 로그",
  "cs-engineering": "소프트웨어의 동시성·DB·알고리즘·성능",
  "instruction-scope-resolver": "작업 공간의 에이전트 지침 파일",
  "korean-prose-editor": "한국어 산문",
  "ponytail": "코드 작성·수정",
  "software-security-auditor": "소프트웨어 보안",
  "solid-design": "코드 설계",
  "test-engineering": "소프트웨어 테스트",
  "workspace-convention-profiler": "저장소 구조와 관례",
});

/** Words that tie a sentence to software or screens. */
export const FIELD_TERMS = Object.freeze([
  ["코드", /(?<![레바에])코드/gu],
  ["소스", /(?<!리)소스/gu],
  ["저장소", /저장소/gu],
  ["커밋", /커밋/gu],
  ["브랜치", /브랜치/gu],
  ["빌드", /빌드/gu],
  ["테스트", /테스트/gu],
  ["구현", /구현/gu],
  ["개발", /개발/gu],
  ["리팩터링", /리팩터링/gu],
  ["라이브러리", /라이브러리/gu],
  ["프레임워크", /프레임워크/gu],
  ["컴포넌트", /컴포넌트/gu],
  ["렌더링", /렌더링/gu],
  ["화면", /화면/gu],
  ["웹", /웹(?!툰)/gu],
  ["데스크톱", /데스크톱/gu],
  ["모바일", /모바일/gu],
  ["백엔드", /백엔드/gu],
  ["프런트엔드", /프[런론]트엔드/gu],
  ["소프트웨어", /소프트웨어/gu],
  ["diff", /\bdiff\b/giu],
  ["patch", /\bpatch(?:es)?\b/giu],
  ["PR", /\bPRs?\b|\bpull requests?\b/gu],
  ["CI", /\bCI\b/gu],
  ["Git", /\bgit\b/giu],
  ["push", /\bpush\b/giu],
  ["API", /\bAPIs?\b/gu],
  ["CLI", /\bCLIs?\b/gu],
  ["UI", /\bUI\b/gu],
  ["code", /\b(?:source )?code(?:base)?\b/giu],
  ["repository", /\brepositor(?:y|ies)\b|\brepos?\b/giu],
  ["commit", /\bcommits?\b/giu],
  ["branch", /\bbranch(?:es)?\b/giu],
  ["build", /\bbuilds?\b/giu],
  ["implementation", /\bimplement(?:s|ed|ing|ation|ations|er|ers)?\b/giu],
  ["library", /\blibrar(?:y|ies)\b/giu],
  ["screen", /\bscreens?\b/giu],
  ["software", /\bsoftware\b/giu],
]);

// A sentence that only says where the skill is not used, or what it does not do
// in place of another owner, does not narrow where it is used...
const EXCLUSION = /(?:사용하지|쓰지|적용하지|대신하지|대신 수행하지) 않는다|범위가 아니다|\b[Dd]o not (?:use|activate|apply)\b/u;
// ...unless it ties the skill to the field ("코드에만", "코드 이외에는", "only for code").
const ONLY = /에만|이외|\bonly\b/u;
const CLAUSE_END = /(?:고|며|지만|으나|는데),\s|[;:]|\b(?:and|but),\s/u;
// The word names the branch for that field: "화면이면", "코드일 때", "## 화면일 때".
const BRANCH_SUFFIX = /^(?:이면|면|이라면|라면|일 때|인 경우|일 경우|에서는)/u;
const BRANCH_HEADING = /^#{2,}\s.*(?:일 때|인 경우|이면)\s*$|^#{2,}\s+When\b/u;
// Explicit examples: "(예: PR이면 ...)", "예를 들어 ...", "e.g. ...".
const EXAMPLE_GROUP = /\((?:예|e\.g\.|for example)[^)]*\)/gu;
const EXAMPLE_LEAD = /예를 들어|예컨대|\be\.g\.|\bfor example\b|\bsuch as\b/u;
// Names that contain a field word but are not about that field: code spans, link
// targets, hyphenated identifiers (skill names), the UI/UX discipline, the Claude
// Code host, a command's exit or status code and a screenshot of the agent host.
const NAMES = /`[^`]*`|\]\([^)]*\)|\bUI\/UX\b|\b[a-z]+(?:-[a-z]+)+\b|\bClaude Code\b|(?:종료|오류|상태|응답) 코드|화면 캡처/gu;

const blank = (text) => text.replace(/[^\n]/gu, " ");
const hasFieldTerm = (text) => FIELD_TERMS.some(([, pattern]) => new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text));
const FIELD_SKILLS = Object.keys(SKILL_FIELDS).filter((id) => SKILL_FIELDS[id] !== null);

/** The `·`-joined word run around the match also lists a field-neutral item: "디자인·편집·촬영·구현". */
function inMixedList(sentence, index, length) {
  const stop = /[\s,()「」『』:;.]/u;
  let start = index;
  while (start > 0 && !stop.test(sentence[start - 1])) start -= 1;
  let end = index + length;
  while (end < sentence.length && !stop.test(sentence[end])) end += 1;
  const items = sentence.slice(start, end).split("·");
  return items.length > 1 && items.some((item) => item.trim() && !hasFieldTerm(item));
}

/** The rule that lets this occurrence stand, or null when it ties the sentence to the field. */
function allowance(sentence, raw, index, length, underBranchHeading) {
  if (underBranchHeading) return "branch-heading";
  if (BRANCH_SUFFIX.test(sentence.slice(index + length))) return "branch";
  // The sentence routes work to a field-specific skill, whose field it names.
  if (FIELD_SKILLS.some((id) => raw.includes(`\`${id}\``))) return "field-skill-routing";
  for (const group of sentence.matchAll(EXAMPLE_GROUP)) {
    if (index >= group.index && index < group.index + group[0].length) return "example";
  }
  // A parenthesized list that also names a field-neutral item: "(화면, 인쇄·광고, 영상)".
  for (const group of sentence.matchAll(/\(([^()]*)\)/gu)) {
    if (index < group.index || index >= group.index + group[0].length) continue;
    const items = group[1].split(/,\s*|·/u);
    if (items.length > 1 && items.some((item) => item.trim() && !hasFieldTerm(item))) return "example-list";
  }
  const lead = sentence.search(EXAMPLE_LEAD);
  if (lead >= 0 && lead < index) return "example";
  if (inMixedList(sentence, index, length)) return "mixed-list";
  // The word must sit in the clause the exclusion closes, not in an earlier clause ("..판정하고, ..대신하지 않는다").
  const exclusion = EXCLUSION.exec(sentence.slice(index));
  if (exclusion && !CLAUSE_END.test(sentence.slice(index, index + exclusion.index)) && !ONLY.test(sentence)) return "exclusion";
  return null;
}

/**
 * Findings in markdown `text`: { line, term, text } with the 1-based line and the
 * sentence. `lines` limits the scan to those line numbers (null: every line).
 * Fenced code blocks and HTML comments are skipped.
 */
export function findFieldWording(text, { lines = null } = {}) {
  const findings = [];
  const source = text.replace(/<!--[\s\S]*?-->/gu, blank);
  let fenced = false;
  let underBranchHeading = false;
  source.split(/\r?\n/u).forEach((raw, offset) => {
    const line = offset + 1;
    if (/^\s*(```|~~~)/u.test(raw)) { fenced = !fenced; return; }
    if (fenced) return;
    if (/^#{1,6}\s/u.test(raw)) underBranchHeading = BRANCH_HEADING.test(raw);
    if (lines && !lines.has(line)) return;
    // Blanking keeps every offset, so a span of `cleaned` is the same span of `raw`.
    const cleaned = raw.replace(NAMES, blank);
    const ends = [...cleaned.matchAll(/(?<=[.!?])\s+/gu)].map((match) => [match.index, match.index + match[0].length]);
    let start = 0;
    for (const [end, next] of [...ends, [cleaned.length, cleaned.length]]) {
      const sentence = cleaned.slice(start, end);
      const original = raw.slice(start, end);
      start = next;
      for (const [term, pattern] of FIELD_TERMS) {
        for (const match of sentence.matchAll(pattern)) {
          if (!allowance(sentence, original, match.index, match[0].length, underBranchHeading)) {
            findings.push({ line, term, text: original.trim() });
          }
        }
      }
    }
  });
  return findings;
}

/** The 1-based line numbers of the frontmatter description and of the body. */
export function skillLines(markdown) {
  const all = markdown.split(/\r?\n/u);
  const result = new Set();
  if (all[0] !== "---") { all.forEach((_, index) => result.add(index + 1)); return result; }
  const close = all.indexOf("---", 1);
  for (let index = 1; index < close; index += 1) {
    if (!/^description:/u.test(all[index])) continue;
    result.add(index + 1);
    for (let next = index + 1; next < close && /^\s+\S|^\s*$/u.test(all[next]); next += 1) result.add(next + 1);
  }
  for (let index = close + 1; index < all.length; index += 1) result.add(index + 1);
  return result;
}

/** The 1-based line numbers between the skill-intake markers. */
export function intakeLines(markdown) {
  const all = markdown.split(/\r?\n/u);
  const start = all.findIndex((line) => line.includes("<!-- skill-intake:start -->"));
  const end = all.findIndex((line) => line.includes("<!-- skill-intake:end -->"));
  if (start < 0 || end < start) throw new Error("skill-intake markers are missing");
  return new Set(all.slice(start + 1, end).map((_, index) => start + index + 2));
}

export const INTAKE_FILE = "skills/orchestrator/references/intake.md";

/**
 * Findings in a file this check's change may not edit: the intake block, which
 * the intake work owns (fix/v380-defects-20261106). They are reported, not
 * failed. Each entry names the file (its Claude package copy follows), the word
 * and a phrase of the sentence. An entry that matches no finding fails, so the
 * list cannot go stale or absorb a new finding.
 */
export const PENDING = Object.freeze([
  { file: INTAKE_FILE, term: "브랜치", phrase: "이미 허용된 빌드·시험·작업 브랜치 push·CI의 추가 승인" },
  { file: INTAKE_FILE, term: "push", phrase: "이미 허용된 빌드·시험·작업 브랜치 push·CI의 추가 승인" },
  { file: INTAKE_FILE, term: "CI", phrase: "이미 허용된 빌드·시험·작업 브랜치 push·CI의 추가 승인" },
  { file: INTAKE_FILE, term: "Git", phrase: "백업이나 git으로 되돌릴 수 있는 편집, 작업 브랜치 commit·push" },
  { file: INTAKE_FILE, term: "브랜치", phrase: "백업이나 git으로 되돌릴 수 있는 편집, 작업 브랜치 commit·push" },
  { file: INTAKE_FILE, term: "commit", phrase: "백업이나 git으로 되돌릴 수 있는 편집, 작업 브랜치 commit·push" },
  { file: INTAKE_FILE, term: "push", phrase: "백업이나 git으로 되돌릴 수 있는 편집, 작업 브랜치 commit·push" },
  { file: INTAKE_FILE, term: "화면", phrase: "비밀값 입력·사용자 화면 조작" },
  { file: INTAKE_FILE, term: "구현", phrase: "되돌릴 수 있는 구현 선택·관례로 정해지는 값" },
  { file: INTAKE_FILE, term: "빌드", phrase: "빌드 감시·진행 폴링 같은 대기" },
]);

const pendingEntry = (finding) => PENDING.find((entry) =>
  (finding.file === entry.file || finding.file === `claude-plugin/${entry.file}`)
  && finding.term === entry.term && finding.text.includes(entry.phrase));

export function checkRepository(root = ROOT) {
  const problems = [];
  const ids = readdirSync(path.join(root, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && readdirSync(path.join(root, "skills", entry.name)).includes("SKILL.md"))
    .map((entry) => entry.name).sort();
  for (const id of ids) if (!(id in SKILL_FIELDS)) problems.push(`${id}: not classified as general or field-specific in SKILL_FIELDS`);
  for (const id of Object.keys(SKILL_FIELDS)) if (!ids.includes(id)) problems.push(`${id}: classified but has no skills/${id}/SKILL.md`);
  const general = ids.filter((id) => SKILL_FIELDS[id] === null);
  const all = [];
  for (const id of general) {
    for (const file of [`skills/${id}/SKILL.md`, `claude-plugin/skills/${id}/SKILL.md`]) {
      let text;
      try { text = readFileSync(path.join(root, file), "utf8"); } catch (error) {
        // A skill the Claude package leaves out has no Claude copy.
        if (error.code === "ENOENT" && file.startsWith("claude-plugin/")) continue;
        throw error;
      }
      for (const finding of findFieldWording(text, { lines: skillLines(text) })) all.push({ file, ...finding });
    }
  }
  const intake = readFileSync(path.join(root, INTAKE_FILE), "utf8");
  for (const finding of findFieldWording(intake, { lines: intakeLines(intake) })) all.push({ file: INTAKE_FILE, ...finding });
  const findings = [];
  const pending = [];
  const used = new Set();
  for (const finding of all) {
    const entry = pendingEntry(finding);
    if (entry) { used.add(entry); pending.push(finding); } else findings.push(finding);
  }
  for (const entry of PENDING) {
    if (!used.has(entry)) problems.push(`${entry.file}: pending entry "${entry.term}" / "${entry.phrase}" matches no finding`);
  }
  return { general, findings, pending, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { general, findings, pending, problems } = checkRepository();
  for (const { file, line, term, text } of pending) console.log(`pending ${file}:${line}: "${term}": ${text}`);
  for (const problem of problems) console.error(problem);
  for (const { file, line, term, text } of findings) console.error(`${file}:${line}: field-limited word "${term}": ${text}`);
  if (problems.length || findings.length) {
    console.error(`domain-neutral wording: ${findings.length} finding(s), ${problems.length} problem(s) in ${general.length} general skills and the intake block`);
    process.exitCode = 1;
  } else {
    console.log(`domain-neutral wording: ${general.length} general skills and the intake block pass (${pending.length} pending in files owned elsewhere)`);
  }
}
