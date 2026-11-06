// Tallies results.jsonl per host and arm: node summary.mjs <results.jsonl> [runTag] [staticDir]
// The arms are only known here, from the result lines; check.mjs never sees them.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { TURNS } from "./tasks.mjs";

const [resultsFile, runTag, staticDir] = process.argv.slice(2);
if (!resultsFile) throw new Error("usage: node summary.mjs <results.jsonl> [runTag] [staticDir]");
const rows = readFileSync(resultsFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => !runTag || row.runTag === runTag);
const SPECIALISTS = TURNS.filter((turn) => turn.kind === "specialist").length;
const CONTROLS = TURNS.length - SPECIALISTS;
const MIN_REPS = 3;

/** Per-run numbers. A run that could not start counts as all turns failed, so it stays in every denominator. */
function runNumbers(row) {
  const totals = row.check?.totals;
  if (!totals) return { hits: 0, controlClean: 0, overCallTurns: 0, overCallNames: 0, strictExtraNames: 0, failedTurns: TURNS.length, broken: row.installFailed ? "install" : "check", turns: [] };
  return { ...totals, broken: null, turns: row.check.turns };
}

const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
const seconds = (row) => (row.check?.turns ?? []).reduce((n, turn) => n + (turn.seconds ?? 0), 0);

/** Completely separated per-run values (every run of one arm beats every run of the other) are a difference; anything else is not. */
function separation(a, b, higherIsBetter) {
  if (a.length < MIN_REPS || b.length < MIN_REPS) return `판별 불가 (반복 부족: A ${a.length}, B ${b.length} < ${MIN_REPS})`;
  if (Math.min(...a) > Math.max(...b)) return higherIsBetter ? "차이 있음: A가 높음" : "차이 있음: A가 큼";
  if (Math.min(...b) > Math.max(...a)) return higherIsBetter ? "차이 있음: B가 높음" : "차이 있음: B가 큼";
  return "판별 불가 (런별 값 구간이 겹침)";
}

const hosts = [...new Set(rows.filter((row) => row.host).map((row) => row.host))].sort();
for (const host of hosts) {
  console.log(`\n=== ${host} ===`);
  const arms = {};
  for (const arm of ["A", "B"]) {
    const mine = rows.filter((row) => row.host === host && row.arm === arm);
    const nums = mine.map(runNumbers);
    arms[arm] = { mine, nums };
    const hits = nums.reduce((n, x) => n + x.hits, 0);
    const failed = nums.reduce((n, x) => n + x.failedTurns, 0);
    const broken = nums.filter((x) => x.broken).length;
    console.log(`${arm}: 대화 ${mine.length}회 (시작 실패·판정 실패 ${broken}), 평균 ${Math.round(mean(mine.map(seconds)))}초`);
    console.log(`   적중 ${hits}/${mine.length * SPECIALISTS} 전문 스킬 턴 (런별 ${nums.map((x) => x.hits).join(",")})`);
    console.log(`   과잉 호출 턴 ${nums.reduce((n, x) => n + x.overCallTurns, 0)} / 이름 ${nums.reduce((n, x) => n + x.overCallNames, 0)} (엄격 기준: 기대 밖 호출 ${nums.reduce((n, x) => n + x.strictExtraNames, 0)})`);
    console.log(`   대조 턴 깨끗함 ${nums.reduce((n, x) => n + x.controlClean, 0)}/${mine.length * CONTROLS}`);
    console.log(`   timeout·오류·건너뜀 턴 ${failed}/${mine.length * TURNS.length} (분모에 포함, 적중으로 세지 않음)`);
    const touched = mine.filter((row) => row.defaultStateFilesTouched > 0).length;
    const dup = mine.reduce((n, row) => n + (row.duplicateMcpWarnings ?? 0), 0);
    const diffs = mine.filter((row) => row.installDiff && row.installDiff !== "0,0").length;
    console.log(`   환경 점검: 기본 상태 폴더 파일 갱신 감지 ${touched}회, 중복 MCP 경고 ${dup}건, 설치본 차이 의심 ${diffs}회`);
  }
  console.log("\n턴별 적중(대조 턴은 깨끗함)  A | B");
  for (const [index, spec] of TURNS.entries()) {
    const cell = (arm) => {
      const turns = arms[arm].nums.map((x) => x.turns[index]).filter(Boolean);
      const good = turns.filter((turn) => (spec.kind === "control" ? turn.verdict === "ok" : turn.hit)).length;
      const calls = [...new Set(turns.flatMap((turn) => turn.calls))].join("+") || "-";
      return `${good}/${arms[arm].mine.length} [${calls}]`;
    };
    console.log(`  ${String(index + 1)} ${spec.id.padEnd(24)} ${cell("A").padEnd(60)} | ${cell("B")}`);
  }
  const weakOnly = rows.filter((row) => row.host === host).flatMap((row) => (row.check?.turns ?? []).filter((turn) => turn.status === "ok" && !turn.hit && turn.weak.length > 0));
  if (weakOnly.length > 0) console.log(`  주의: 읽기 동사 없이 SKILL.md 경로만 나온 턴 ${weakOnly.length}개가 miss로 셈됨 (판정 기준 확인 필요)`);
  const a = arms.A.nums.map((x) => x.hits);
  const b = arms.B.nums.map((x) => x.hits);
  console.log(`\n적중 수 비교: ${separation(a, b, true)}`);
  console.log(`과잉 호출 턴 비교: ${separation(arms.A.nums.map((x) => x.overCallTurns), arms.B.nums.map((x) => x.overCallTurns), false)}`);
  const cues = (arm) => arms[arm].mine.flatMap((row) => (row.check?.turns ?? []).map((turn) => turn.hookCue?.contextChars).filter((n) => typeof n === "number"));
  console.log(`실제 실행에서 관측한 UserPromptSubmit 훅 문맥 글자 수: A ${cues("A").length ? `평균 ${Math.round(mean(cues("A")))} (${cues("A").length}턴)` : "관측 없음"}, B ${cues("B").length ? `평균 ${Math.round(mean(cues("B")))} (${cues("B").length}턴)` : "관측 없음"}`);
}

const dir = staticDir ?? path.join(path.dirname(path.resolve(resultsFile)), "static");
if (existsSync(dir)) {
  console.log("\n=== 훅 문구 길이(호스트 밖에서 훅 명령을 직접 돌려 잰 값, 글자 수) ===");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
    const m = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    const per = m.userPromptSubmit.map((turn) => turn.contextChars);
    console.log(`${file.replace(".json", "").padEnd(10)} 메시지마다 ${per.join(",")} | SessionStart startup ${m.sessionStart.startup.contextChars}, resume ${m.sessionStart.resume.contextChars}, compact ${m.sessionStart.compact.contextChars} | 7턴 합계 ${per.reduce((x, y) => x + y, 0)}`);
  }
}
for (const host of ["claude", "codex"]) {
  const read = (arm) => (existsSync(path.join(dir, `${arm}-${host}.json`)) ? JSON.parse(readFileSync(path.join(dir, `${arm}-${host}.json`), "utf8")) : null);
  const [a, b] = [read("A"), read("B")];
  if (!a || !b) continue;
  const extra = b.sessionStart.resume.contextChars - a.sessionStart.resume.contextChars;
  if (extra >= 1000) console.log(`주의(${host}): B는 SessionStart(resume)에서 A보다 ${extra}자 더 싣는다. 턴마다 --resume으로 새 프로세스를 띄우는 방식(resume)에서는 이 목록이 매 턴 도착하므로 한 번만 싣는 조건과 다르다. ${host === "claude" ? "CLAUDE_MODE=stream 결과를 함께 본다." : "Codex는 headless로 한 프로세스 다중 턴이 없어 이 조건을 시험하지 못한다."}`);
}
const failed = rows.filter((row) => row.check?.turns?.some((turn) => turn.status !== "ok") || row.installFailed || row.preflightFailed);
console.log(`\n실패·오류가 있는 대화 (${failed.length}):`);
for (const row of failed) {
  const bad = (row.check?.turns ?? []).filter((turn) => turn.status !== "ok").map((turn) => `t${turn.turn}:${turn.status}(${turn.reason})`).join(" ");
  console.log(`  ${row.host}-${row.arm}-r${row.rep} ${row.installFailed ? "install failed" : row.preflightFailed ?? bad}`);
}
