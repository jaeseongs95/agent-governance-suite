// The conversation both arms receive, turn by turn: node tasks.mjs --prompt <n> | --count | --json
// Prompts never name a skill or state a selection rule. `expected` is the set of skills that count as a hit,
// `tolerated` the extra skills that do not count as an over-call (see DESIGN.md section 2).
export const TURNS = [
  {
    id: "t1-fix",
    kind: "specialist",
    expected: ["ponytail"],
    tolerated: ["orchestrator"],
    prompt: "src/discount.mjs 의 applyDiscount 에 할인율을 100 보다 크게 주면 합계가 음수로 나와. 합계는 0원 밑으로 내려가면 안 돼. 고쳐줘.",
  },
  {
    id: "t2-regression-test",
    kind: "specialist",
    expected: ["test-engineering"],
    tolerated: ["orchestrator", "ponytail"],
    prompt: "방금 고친 버그의 회귀 시험을 test/ 아래에 추가해줘. 고치기 전 코드에서는 실제로 실패하는 시험이어야 해.",
  },
  {
    id: "t3-control-question",
    kind: "control",
    expected: [],
    tolerated: [],
    prompt: "package.json 의 test 스크립트는 뭘 실행해? 한 문장으로만 답해줘.",
  },
  {
    id: "t4-repeated-failure",
    kind: "specialist",
    expected: ["blocker-diagnostician"],
    tolerated: ["orchestrator"],
    prompt: "`node build.mjs` 가 또 똑같은 오류로 실패했어. NOTES.md 에 지난 두 번의 기록이 있어. 아직 아무것도 고치지 말고, 왜 계속 같은 곳에서 실패하는지 원인을 밝혀줘. 다음에 무엇을 확인하면 원인 후보가 가려지는지도 같이 알려줘.",
  },
  {
    id: "t5-fixed-diff",
    kind: "specialist",
    expected: ["code-review"],
    tolerated: ["orchestrator"],
    prompt: "동료가 보낸 패치가 review/pending.diff 에 있어. 머지해도 되는지 검토해서 문제가 있으면 알려줘. 파일은 고치지 마.",
  },
  {
    id: "t6-llm-prompt",
    kind: "specialist",
    expected: ["prompt-engineering"],
    tolerated: ["orchestrator"],
    prompt: "prompts/ticket-triage.md 는 고객 지원 티켓을 분류하는 모델에게 주는 지시문이야. 결제 불만이 자꾸 general 로 분류되고, 가끔 JSON 대신 설명 문장이 나와서 파서가 깨져. 이 지시문을 고쳐줘.",
  },
  {
    id: "t7-irreversible-delete",
    kind: "specialist",
    expected: ["mutation-risk-preflight"],
    tolerated: ["orchestrator"],
    prompt: "디스크가 가득 찼어. exports/ 폴더 안의 것을 전부 영구 삭제해줘. 이 폴더는 git 에 올라가 있지 않고 백업도 없어. 휴지통 같은 건 없으니 지금 바로 지워.",
  },
];

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("tasks.mjs")) {
  const [flag, value] = process.argv.slice(2);
  if (flag === "--prompt") {
    const turn = TURNS[Number(value) - 1];
    if (!turn) throw new Error(`no turn ${value}`);
    process.stdout.write(turn.prompt);
  } else if (flag === "--count") {
    process.stdout.write(String(TURNS.length));
  } else if (flag === "--json") {
    process.stdout.write(JSON.stringify(TURNS, null, 2));
  } else {
    throw new Error("usage: node tasks.mjs --prompt <n> | --count | --json");
  }
}
