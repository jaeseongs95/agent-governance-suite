#!/usr/bin/env node
// Claude Code-only skill trigger hook.
// Claude Code selects a plugin skill from its one-line description and reads no implicit-invocation policy,
// so sessions rarely reach the governance skills on terse natural requests. This hook watches two events and
// injects a short recommendation into the model context; it never blocks, never runs a skill, and writes no state.
//   UserPromptSubmit: pattern-match the prompt for commit / destructive / repeated-failure / underspecified-task intents.
//   PreToolUse (Bash): pattern-match the command for destructive or publishing operations.
// Any failure exits 0 with no output so the session is never disrupted.
import { readFileSync } from "node:fs";

const SKILL = (name) => `/agent-governance-suite:${name}`;

const PROMPT_RULES = [
  {
    skill: "change-scope-guardian",
    // Read-only requests about commits (log, history, message, "show me") are not a pre-commit situation.
    test: (p) => /(커밋|commit|merge|병합|push|푸시)/iu.test(p)
      && !/((커밋|commit|merge|병합|push|푸시)\s*(로그|내용|이력|히스토리|목록|메시지|log|message|history)|(커밋|commit).{0,8}(보여|알려|설명|show|list))/iu.test(p),
    why: "커밋·병합 전에는 요청 범위 밖 파일이나 다른 작업의 변경이 섞였는지 확인하는 단계가 있다",
  },
  {
    skill: "mutation-risk-preflight",
    // Verb forms only: "삭제된 파일 목록 보여줘" or a bare "permission" must not trigger.
    test: (p) => /(rm\s+-r|rm\s+-rf|삭제해|삭제할|삭제하|지워|지울|날려|날리|drop\s+table|truncate|migrat|마이그레이션|deploy|배포해|배포할|배포하|publish|게시해|게시할|권한\s*변경|permission\s*(change|grant|update|revok)|chmod|결제|billing)/iu.test(p),
    why: "삭제·배포·마이그레이션·권한 변경처럼 되돌리기 어려운 작업은 실행 직전에 대상·승인·영향 범위·복구 조건을 읽기 전용으로 점검하는 단계가 있다",
  },
  {
    skill: "blocker-diagnostician",
    // "또" must be the adverb, not the conjunction "또는".
    test: (p) => /(실패|에러|error|fail|죽|깨지|안\s*돼|안\s*됨)/iu.test(p) && /(또(?!는)|다시|계속|반복|여전히|세\s*번|두\s*번|번째|still|again|keeps?)/iu.test(p),
    why: "같은 실패가 반복될 때는 관측된 실패와 원인 가설을 분리하고 새 정보를 주는 다음 검사를 고르는 단계가 있다",
  },
  {
    skill: "task-contract",
    test: (p) => /(추가해|구현해|만들어|짜\s*줘|작업을?\s*맡|implement|add\s+a|build)/iu.test(p) && /(아직|미정|알아서|정해지지|모르겠|나중에|일단)/iu.test(p),
    why: "요청에 미정인 결정이 남아 있으면 구현 전에 목표·범위·완료 조건을 고정하는 단계가 있다",
  },
];

const COMMAND_RULES = [
  { skill: "mutation-risk-preflight", test: (c) => /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\b)/iu.test(c) || /\b(git\s+(push\s+.*--force|reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D)|drop\s+(table|database)|truncate\s+table|kubectl\s+delete|terraform\s+(apply|destroy)|gh\s+release\s+(create|delete)|npm\s+publish|pnpm\s+publish)\b/iu.test(c), why: "되돌리기 어려운 명령" },
  { skill: "change-scope-guardian", test: (c) => /\bgit\s+(commit|merge|push)\b/iu.test(c) && !/--dry-run/iu.test(c), why: "커밋·병합·push 직전" },
];

function readInput() {
  try {
    const text = readFileSync(0, "utf8");
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function render(event, hits, subject) {
  if (hits.length === 0) return null;
  const lines = hits.map((h) => `- ${SKILL(h.skill)}: ${h.why}.`);
  const header = event === "UserPromptSubmit"
    ? "agent-governance-suite 안내: 이 요청은 다음 플러그인 스킬의 적용 조건에 해당할 수 있다. 해당되면 다른 작업보다 먼저 Skill 도구로 호출하고, 해당되지 않으면 그 이유를 한 줄로 밝히고 진행한다."
    : `agent-governance-suite 안내: 실행하려는 명령(${subject})은 다음 스킬의 적용 조건에 해당한다. 아직 수행하지 않았다면 명령 실행 전에 먼저 호출한다.`;
  return `${header}\n${lines.join("\n")}`;
}

function main() {
  const input = readInput();
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  let context = null;
  if (event === "UserPromptSubmit") {
    // Claude Code documents the field as `prompt`; some builds deliver `user_input`. Accept both.
    const prompt = typeof input.prompt === "string" ? input.prompt : typeof input.user_input === "string" ? input.user_input : "";
    if (prompt.length > 0 && prompt.length < 20_000 && !prompt.startsWith("/")) {
      context = render(event, PROMPT_RULES.filter((r) => r.test(prompt)), null);
    }
  } else if (event === "PreToolUse" && input.tool_name === "Bash") {
    const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
    if (command.length > 0) {
      const hits = COMMAND_RULES.filter((r) => r.test(command));
      context = render(event, hits, command.length > 80 ? `${command.slice(0, 80)}…` : command);
    }
  }
  if (context) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }));
  }
}

try {
  main();
} catch {
  // never disrupt the session
}
process.exit(0);
