// AGS is not a coding plugin (AGS3-D-0038). A general skill checks any kind of
// work (video, ads, documents, operations, code), so its wording must not tie
// where it applies to one field. This check finds field-limited words in the
// description and body of every general SKILL.md, in the source tree and in the
// generated Claude package (which carries the Claude overlay descriptions), in
// the shared intake block and the four mandatory reference boundaries below,
// and (3.9.0) in every other reference of a general skill, the classification
// targets every session and subagent start lists, and the hook, tool and
// instruction messages of every locale.
//
// Usage: node scripts/check-domain-neutral-wording.mjs
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  ["runner", /\brunner\b/giu],
]);

// A sentence that only says where the skill is not used, or what it does not do
// in place of another owner, does not narrow where it is used...
const EXCLUSION = /(?:사용하지|쓰지|적용하지|대신하지|대신 수행하지) 않는다|범위가 아니다|\b[Dd]o not (?:use|activate|apply)\b/u;
// ...unless it ties the skill to the field ("코드에만", "코드 이외에는", "only for code").
const ONLY = /에만|이외|\bonly\b/u;
const CLAUSE_END = /(?:고|며|지만|으나|는데),\s|[;:]|\b(?:and|but),\s/u;
// The word names the branch for that field: "화면이면", "코드일 때", "## 화면일 때".
const BRANCH_SUFFIX = /^\s*(?:이면|면|이라면|라면|일 때|인 경우|일 경우|에서는)/u;
const BRANCH_HEADING = /^#{2,}\s.*(?:일 때|인 경우|이면)\s*$|^#{2,}\s+When\b/u;
// Explicit examples: "(예: PR이면 ...)", "예를 들어 ...", "e.g. ...".
const EXAMPLE_GROUP = /\((?:예|e\.g\.|for example)[^)]*\)/gu;
const EXAMPLE_LEAD = /예를 들어|예컨대|\be\.g\.|\bfor example\b|\bsuch as\b/u;
// Names that contain a field word but are not about that field: link targets,
// hyphenated identifiers (skill names), the UI/UX discipline, the Claude
// Code host, a command's exit or status code and a screenshot of the agent host.
const NAMES = /\]\([^)]*\)|\bUI\/UX\b|\b[a-z]+(?:-[a-z]+)+\b|\bClaude Code\b|(?:종료|오류|상태|응답|원인|이유) 코드|화면 캡처/gu;
// Inline markup alone does not turn a field word into an identifier.
const INLINE_IDENTIFIER = /^(?:[^\s]+[/\\]|[./\\]|\{|\[|v?\d+\.\d+|(?:node|python3?|git|pnpm|npm|npx)(?:\s|$))|^[^\s]+\.[a-zA-Z][a-zA-Z0-9]{0,7}$/u;
// ponytail: these explicit clause markers are a wording heuristic, not a language parser.
const CLAUSE_BOUNDARY = /(?:하고|하며|이고|이며|쓰고|쓰며|지만|으나|는데),?\s|[;:]|\b(?:and|but),\s/gu;

const blank = (text) => text.replace(/[^\n]/gu, " ");
const hasFieldTerm = (text) => FIELD_TERMS.some(([, pattern]) => new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text));
const FIELD_SKILLS = Object.keys(SKILL_FIELDS).filter((id) => SKILL_FIELDS[id] !== null);

function clauseBounds(sentence, index) {
  let start = 0;
  for (const boundary of sentence.matchAll(CLAUSE_BOUNDARY)) {
    const next = boundary.index + boundary[0].length;
    if (next > index) return { start, end: boundary.index };
    start = next;
  }
  return { start, end: sentence.length };
}

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
  const { start, end } = clauseBounds(sentence, index);
  const clause = sentence.slice(start, end);
  // These explicit conditions govern their own clause, never a later clause.
  const condition = /^\s*(?:-\s*)?(?:저장소 관례가 필요하고 이미 제공됐다면|소프트웨어 테스트와 표준 runner가 있는 경우에는)/u.exec(sentence);
  if (condition && start < condition[0].length) return "branch";
  if (sentence.slice(index).startsWith("diff와 의미 동일성 근거")) return "evidence-kind";
  // Only this clause routes work to the field-specific skill whose field it names.
  if (FIELD_SKILLS.some((id) => raw.slice(start, end).includes(`\`${id}\``))) return "field-skill-routing";
  for (const group of sentence.matchAll(EXAMPLE_GROUP)) {
    if (index >= group.index && index < group.index + group[0].length) return "example";
  }
  // A parenthesized list that also names a field-neutral item: "(화면, 인쇄·광고, 영상)".
  for (const group of sentence.matchAll(/\(([^()]*)\)/gu)) {
    if (index < group.index || index >= group.index + group[0].length) continue;
    const items = group[1].split(/,\s*|·/u);
    if (items.length > 1 && items.some((item) => item.trim() && !hasFieldTerm(item))) return "example-list";
  }
  const lead = clause.search(EXAMPLE_LEAD);
  if (lead >= 0 && lead < index - start) return "example";
  if (!/^구현자/u.test(sentence.slice(index)) && inMixedList(sentence, index, length)) return "mixed-list";
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
    const inlineNames = raw.replace(/`([^`]*)`/gu, (whole, content) =>
      Object.hasOwn(SKILL_FIELDS, content) || INLINE_IDENTIFIER.test(content) ? blank(whole) : ` ${content} `);
    const cleaned = inlineNames.replace(NAMES, blank);
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

// Only the four mandatory references identified by D38, and their general
// application/role/procedure clauses. Evidence lists and specialist routing stay out.
const REFERENCE_RULES = {
  "skills/task-contract/references/entry-details.md": [
    ["작성 절차", /^1\.\s/u, 1],
  ],
  "skills/independent-audit-gate/references/entry-details.md": [
    ["권한과 역할 경계", /^- 감사자는/u, 3],
    ["실행 안전", /^(?:감사자와|- (?:저장소의|대상의) 기존 검증|- 감사자는)/u, 3],
    ["실행 절차", /^(?:3|4|6)\.\s/u, 3],
    ["완료 불변조건", /^- 감사자와/u, 1],
    ["판정의 범위를 보존한다", /^- 발견사항의 ID/u, 1],
  ],
  "skills/independent-audit-gate/references/audit-protocol.md": [
    ["2. 감사자 독립성", /^- /u, 6],
    ["3. 감사자 briefing", /^필수 정보/u, 1],
    ["재현과 실행 안전", /^(?:증거 재현은|자원 경계는|감사자는 기존 검증|(?:구현자|변경 작업자)는 명세를|- (?:저장소가 정의한|대상에 정의된) 검증)/u, 5],
    ["6. 수정과 재감사", /^공백·서식/u, 1],
  ],
  "skills/independent-audit-gate/references/orchestrator-integration.md": [
    ["1. 책임 분리", /^- 상위 orchestrator/u, 1],
    ["3. 출력 handoff", /^- `Independence`/u, 1],
  ],
};

/**
 * References of a general skill that exist for one field, with that field. Every
 * other reference of a general skill is scanned in full (3.9.0, AGS3-D-0038).
 */
export const REFERENCE_FIELDS = Object.freeze({
  "skills/orchestrator/references/engineering-practices/": "소프트웨어 엔지니어링 실무 모듈(코딩·시험·코드 검토 단계 담당에게만 전달)",
});

/**
 * Locale messages whose subject is one field, with that field. Every other hook,
 * tool and instruction message is scanned: it reaches sessions of every kind of work.
 */
export const LOCALE_FIELDS = Object.freeze({
  "tools.check_for_updates.description": "AGS 자체 배포 저장소의 판 확인",
  "tools.list_session_status.description": "세션 현황판이 보고하는 작업 공간 Git 상태",
});

const LOCALE_DOMAINS = Object.freeze(["hooks", "tools", "instructions"]);

/** English field words a hyphenated classification target can carry ("test-evidence"). */
const TARGET_TERMS = Object.freeze([
  ...FIELD_TERMS.filter(([term]) => /^[A-Za-z]/u.test(term)),
  ["test", /\btests?\b/giu],
  ["code", /\bcoding\b/giu],
]);

/** Field words in classification `targets`: these lists reach every session and subagent start. */
export function findTargetWording(targets) {
  const findings = [];
  for (const target of targets) {
    const words = String(target).replace(/-/gu, " ");
    for (const [term, pattern] of TARGET_TERMS) {
      if (new RegExp(pattern.source, pattern.flags.replace("g", "")).test(words)) findings.push({ term, text: target });
    }
  }
  return findings;
}

function markdownFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith(".md") ? [full] : [];
  });
}

/** Reuse the existing lines boundary; missing/empty structural selections fail. */
function referenceLines(markdown, rules) {
  const all = markdown.replace(/<!--[\s\S]*?-->/gu, blank).split(/\r?\n/u);
  const prose = new Set();
  let fenced = false;
  all.forEach((line, index) => {
    if (/^\s*(```|~~~)/u.test(line)) { fenced = !fenced; return; }
    if (!fenced && line.trim()) prose.add(index);
  });
  const lines = new Set();
  for (const [heading, select, minimum] of rules) {
    const starts = all.flatMap((line, index) => prose.has(index) && /^#{1,6}\s/u.test(line)
      && line.replace(/^#{1,6}\s+/u, "") === heading ? [index] : []);
    if (starts.length !== 1) throw new Error(`required reference section missing or repeated: ${heading}`);
    const start = starts[0], level = all[start].match(/^#+/u)[0].length;
    let selected = 0;
    for (let index = start + 1; index < all.length; index += 1) {
      if (!prose.has(index)) continue;
      const next = /^(#{1,6})\s/u.exec(all[index]);
      if (next && next[1].length <= level) break;
      if (select.test(all[index])) { lines.add(index + 1); selected += 1; }
    }
    if (selected < minimum) throw new Error(`required reference clauses missing: ${heading} (${selected}/${minimum})`);
  }
  return lines;
}

export function checkRepository(root = ROOT) {
  const problems = [];
  const ids = readdirSync(path.join(root, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && readdirSync(path.join(root, "skills", entry.name)).includes("SKILL.md"))
    .map((entry) => entry.name).sort();
  for (const id of ids) if (!(id in SKILL_FIELDS)) problems.push(`${id}: not classified as general or field-specific in SKILL_FIELDS`);
  for (const id of Object.keys(SKILL_FIELDS)) if (!ids.includes(id)) problems.push(`${id}: classified but has no skills/${id}/SKILL.md`);
  const general = ids.filter((id) => SKILL_FIELDS[id] === null);
  const findings = [];
  for (const id of general) {
    for (const file of [`skills/${id}/SKILL.md`, `claude-plugin/skills/${id}/SKILL.md`]) {
      let text;
      try { text = readFileSync(path.join(root, file), "utf8"); } catch (error) {
        // A skill the Claude package leaves out has no Claude copy.
        if (error.code === "ENOENT" && file.startsWith("claude-plugin/")) continue;
        throw error;
      }
      for (const finding of findFieldWording(text, { lines: skillLines(text) })) findings.push({ file, ...finding });
    }
  }
  const intake = readFileSync(path.join(root, INTAKE_FILE), "utf8");
  for (const finding of findFieldWording(intake, { lines: intakeLines(intake) })) findings.push({ file: INTAKE_FILE, ...finding });
  for (const [source, rules] of Object.entries(REFERENCE_RULES)) {
    for (const file of [source, `claude-plugin/${source}`]) {
      let text;
      try { text = readFileSync(path.join(root, file), "utf8"); } catch (error) {
        const skill = source.split("/")[1];
        if (error.code === "ENOENT" && file.startsWith("claude-plugin/")
          && !existsSync(path.join(root, "claude-plugin/skills", skill, "SKILL.md"))) continue;
        if (error.code !== "ENOENT") throw error;
        problems.push(`${file}: required reference missing`);
        continue;
      }
      let lines;
      try { lines = referenceLines(text, rules); } catch (error) { problems.push(`${file}: ${error.message}`); continue; }
      for (const finding of findFieldWording(text, { lines })) findings.push({ file, ...finding });
    }
  }
  // 3.9.0: every other reference of a general skill, in full (the intake file is scanned above).
  const seen = new Set(findings.map(({ file, line, term }) => `${file}:${line}:${term}`));
  for (const id of general) {
    for (const prefix of ["", "claude-plugin/"]) {
      const directory = path.join(root, prefix, "skills", id, "references");
      for (const full of markdownFiles(directory)) {
        const source = path.relative(path.join(root, prefix), full).split(path.sep).join("/");
        if (source === INTAKE_FILE) continue;
        if (Object.keys(REFERENCE_FIELDS).some((field) => source.startsWith(field))) continue;
        const file = prefix + source;
        for (const finding of findFieldWording(readFileSync(full, "utf8"))) {
          const key = `${file}:${finding.line}:${finding.term}`;
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push({ file, ...finding });
        }
      }
    }
  }
  for (const field of Object.keys(REFERENCE_FIELDS)) {
    if (!existsSync(path.join(root, field))) problems.push(`${field}: field-specific reference listed but missing`);
  }
  // 3.9.0: classification targets of general skills (every session and subagent start lists them).
  for (const id of general) {
    const file = `skills/${id}/classification.json`;
    if (!existsSync(path.join(root, file))) continue;
    const { targets = [] } = JSON.parse(readFileSync(path.join(root, file), "utf8"));
    for (const finding of findTargetWording(targets)) findings.push({ file, line: 0, ...finding });
  }
  // 3.9.0: hook, tool and instruction messages of every locale.
  const localeRoot = path.join(root, "locales");
  if (existsSync(localeRoot)) {
    for (const locale of readdirSync(localeRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
      for (const domain of LOCALE_DOMAINS) {
        const file = `locales/${locale}/${domain}.json`;
        if (!existsSync(path.join(root, file))) continue;
        for (const [key, value] of Object.entries(JSON.parse(readFileSync(path.join(root, file), "utf8")))) {
          if (Object.hasOwn(LOCALE_FIELDS, key) || typeof value !== "string") continue;
          for (const finding of findFieldWording(value)) findings.push({ file, ...finding, line: 0, text: `${key}: ${finding.text}` });
        }
      }
    }
    for (const key of Object.keys(LOCALE_FIELDS)) {
      const found = readdirSync(localeRoot).some((locale) => LOCALE_DOMAINS.some((domain) => {
        const file = path.join(localeRoot, locale, `${domain}.json`);
        return existsSync(file) && Object.hasOwn(JSON.parse(readFileSync(file, "utf8")), key);
      }));
      if (!found) problems.push(`${key}: field-specific locale message listed but missing`);
    }
  }
  return { general, findings, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { general, findings, problems } = checkRepository();
  for (const problem of problems) console.error(problem);
  for (const { file, line, term, text } of findings) console.error(`${file}:${line}: field-limited word "${term}": ${text}`);
  if (problems.length || findings.length) {
    console.error(`domain-neutral wording: ${findings.length} finding(s), ${problems.length} problem(s) in ${general.length} general skills, their references and targets, the intake block and the locale messages`);
    process.exitCode = 1;
  } else {
    console.log(`domain-neutral wording: ${general.length} general skills, their references and targets, the intake block and the locale messages pass`);
  }
}
