import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = "7bc7753012227938be2a46f68bf3e29d29d5ef34";
// AC-010 adds peer instructions after the reviewed optimization. Preserve all
// historical bytes and compare the exact, separately frozen addition as well.
const SESSION_BOARD_ADDITION = "scripts/fixtures/session-board-peer-message-guidance.2.6.0.md";
const SESSION_BOARD_ADDITION_SHA256 = "381be4018118086b3c4087be043c004d8d6de986d42a6c0c14f182c2d76ed76f";
const CS_HANDOFF_ADDITION = "scripts/fixtures/cs-engineering-handoff.2.8.0.md";
const CS_HANDOFF_SHA256 = "c8937d58fd2d9193f191d86c629c9b54731d08d82ec12cb3249ff82e6362ed52";
const CS_REGISTRY_SHA256 = "63fc38d9dff8570173af73092e320c4ff2467d26185fb6528ea33a8af59db6a9";
const ENGINEERING_ADDITION = "scripts/fixtures/engineering-practices-handoff.2.8.1.md";
const ENGINEERING_ADDITION_SHA256 = "6f4bc0fd90113630f077415038492cbceddbaafb9e4e566c750111fafb3abef1";
const ENGINEERING_REGISTRY_SHA256 = "dd9c818c5e50d15316b3adc82c77c06810f3efbc6633c957855c1655d6159adc";
const ENGINEERING_REFERENCES = Object.freeze({
  "agent-instructions.md": "a6df55ef522a75262b93381ad2f8b5fcaca4212a0afeab6cc0d1a90de2230424",
  "catalog.json": "936714985d22b8ea67b51c5d74cceef2d1321efac8dbfca58989ba124bff3d81",
  "cli.md": "be715633beccc35385f6b1ae3c0c822d1a3487afcae9398bda0d9cf74cfa9341",
  "code-review.md": "2f0e7f9a75293084a766aa997daf39fe3d2dbbd6e45f9c7455709e9766f8b492",
  "debugging.md": "86239a76c5553be28fe4fddc89fa55b355015e20361d528fcb4c4874bc7fab84",
  "dependency.md": "88c6db7f0e7f2feb90484c8519eacdb51a313f96f38d7e3f62858e3df1d3ceaa",
  "implementation.md": "4b338f1d4b7dd51726f8f007c927bcae575c120283142136f802e64590defbd1",
  "index.md": "75d831fd83588e02f8604fa827ceace01b88cee04c0af5e820d46edd50ffe081",
  "sources.lock.json": "2c3bff501633df40599cf6e631db0a885beec38e4690e51a9628097c8e719b9d",
  "test-design.md": "fd2673d8ff204909e1d22cf929d57641dc90ec6e8293a7395178256d95d7dc0c",
  "test-proof.md": "7ac0a9d5031d32e5d2b3770a080c1629451903184dac1e38e240812c6fc91e1d",
  "verification.md": "0eb46c1e34a3d53cd171b4e254c186aab11e062d7b2ebf456fa700df347c4f62",
});
// Intake changes policy after the original optimization. Pin only this revision;
// all other skills keep their historical byte-for-byte checks.
const ORCHESTRATOR_INTAKE = Object.freeze({
  revision: "2.7.3-intake-selection-timing",
  initialMaxBytes: 4585,
  hashes: Object.freeze({
    reconstructed: "12744ae24122ce513b09152f3e4884b63883c7d15e808fa7b2b6c19c27be3af9",
    frontmatter: "9054478f3909908263ce9f26afaad3b51d2a0db8f1aceacb228b07c6e3dd7bae",
    mcpExecution: "be972eaa9b6d2ceab78f48f37fcc0eb4e1d4ce52cd8cfb5de356f019da46c546",
  }),
});
// A separately reviewed implementation revision; do not rewrite the historical
// optimization baseline or accept arbitrary additions to the skill tree.
const REVIEWED_IMPLEMENTATION_R1 = Object.freeze({
  revision: "2.8.1-implementation-r1-model-support-stage-bundle",
  approvalReference: "implementation-r1 scoped human request Sentinel_ffd3e94fbe088191b35bdea70e40bc7f and D fixed-candidate review",
  authorityEffect: "none",
  modelInitialMaxBytes: 2024,
  modelReconstructedSha256: "6da88c97055fc65932c6412cc3f9cd6265cbd9678f1934d7338f1b3f6c4733ca",
  hashes: Object.freeze({
    "skills/model-effort-advisor/SKILL.md": "55d965086eab2ac7fe8acd34d32a520a91ed465e92bfe8b73629b04ab8d61106",
    "skills/model-effort-advisor/references/entry-details.md": "2ae266a21db394f6b156a2a71a38edcfa0a64270ef7ca1a494c9af2a88a2d10c",
    "skills/model-effort-advisor/scripts/support-guard.mjs": "a688cc5ee30bd4b6b7a3b40f88dd8147ee2bebfeafe30bbcb723014e7d906c97",
    "skills/orchestrator/references/engineering-practices/cli.md": "42d409ec8fd0f39c491dfdeb18da3f3d15d9fb518c82a8d9f69ed0ae87a59f69",
  }),
});
// Preserve the R1 history; validate only the exact current R2 successor bytes.
const REVIEWED_IMPLEMENTATION_R2 = Object.freeze({
  "revision": "2.8.1-implementation-r2-model-diagnostic-shared-board",
  "approvalReference": "implementation-r2 scoped human request Sentinel_ffd3e94fbe088191b35bdea70e40bc7f; D fixed-candidate review is recorded separately",
  "authorityEffect": "none",
  "modelReconstructedSha256": "8b5fb5d5f9afaf4c5716fc3928495f0bf6f9e99bf2d2c31d5376686fad26917e",
  hashes: Object.freeze({
  "skills/model-effort-advisor/references/entry-details.md": "806874cf4ff417e5e5416a48df8f373ba7483591dbc916ce5edb3868280255de",
  "skills/model-effort-advisor/scripts/support-guard.mjs": "f080508b68211eddad4a29e59ed0290dc54bd7200617dbcc4e46a2cfd319cfd2",
  "skills/session-board/scripts/board-store.mjs": "87851a74230cc3ba03d3ff34ef3e1bb6a9c3b8aaa1566b158cd9906b35b1fb81",
  "skills/session-board/scripts/board-store.d.mts": "d4a156f0a4f3a83fdaf655daf3fe88efd14c427c79ffceb1b8012d14c38a0098"
}),
});
// Reviewed resolver output-contract revision. Pin only these exact bytes; the
// historical optimization baseline and every other check stay unchanged.
const REVIEWED_RESOLVER_OUTPUT_CONTRACT = Object.freeze({
  revision: "2.9.1-instruction-scope-resolver-output-contract",
  sourceCommit: "852f562046d98bb7561846cba3a11fb7d8b6fc73",
  approvalReference: "(1) scoped original AGS 2.9.1 user request, request identifier unconfirmed; (2) Dot delegated judgment within the existing project scope, based on user Sentinel_67f178f8ffac8191906809c9fde9fec8 at 2026-10-10T15:18Z (away until 2026-10-11 08:00 KST), ending 2026-10-10T23:00Z (Dot msgs 24896812, bd6c246d, cdff315e, 4dfba65a, 44702963); not a new direct human approval and not a separate safety approval; (3) independent review R169 conditional acceptance and R173 PRE PASS by auditor 8bb9313d",
  authorityEffect: "none",
  reconstructedSha256: "bf7c308854632be2aa20010ca1007fc082322ae7d1582f26d6a762fe14f45c07",
  hashes: Object.freeze({
    "skills/instruction-scope-resolver/SKILL.md": "5884f45b804b2b50dbfd060e73f2412940fa4e23b66b28eb256a71af4111d0cb",
    "skills/instruction-scope-resolver/references/entry-details.md": "57ba0ed8a184aa35aca5a84d101ada4dc94ee01126cff800712d9fd19f4caa74",
  }),
});
// Preserve the output-contract history; validate only the exact current N successor bytes.
const REVIEWED_RESOLVER_N_DESC_RULE = Object.freeze({
  revision: "2.9.1-instruction-scope-resolver-n-desc-rule-r8.3",
  baseCommit: "b2b8c70253822f67d9829dca7ff5a042a9c1fa67",
  supersedes: "2.9.1-instruction-scope-resolver-output-contract",
  approvalReference: "(1) scoped direct user approval chosen in Chief session bd8adeae on 2026-10-14 between 07:28Z and 07:40Z (Dot 8f240921) for one local candidate commit on b2b8c702 changing six files, without push, build, test or release; (2) independent reviews R-330, R-331 and R-335; the delegated judgment that ended 2026-10-10T23:00Z is not reused",
  authorityEffect: "none",
  reconstructedSha256: "95237f9845686a05e91caad97f65832d60981596efbb99f91c032fb70ac8254d",
  hashes: Object.freeze({
    "skills/instruction-scope-resolver/SKILL.md": "5884f45b804b2b50dbfd060e73f2412940fa4e23b66b28eb256a71af4111d0cb",
    "skills/instruction-scope-resolver/references/entry-details.md": "f40835131e257fff01e5913ae979d55af4546ed503e925e74dad716b432f90c3",
  }),
});
// Historical scope pins for this reviewed change, never a runtime selector
// allowlist. The classification loader continues to discover descriptors dynamically.
const CLASSIFICATION_UPDATE = Object.freeze({
  revision: "2.9.1-skill-classification-metadata-and-entry-bridges",
  approvalReference: "Scoped AGS 2.9.1 user request; frozen seq7 design/test contract and current implementation scope",
  authorityEffect: "none",
  additions: Object.freeze({
    orchestrator: Object.freeze({ path: "scripts/fixtures/skill-classification-intake.2.9.1.md", sha256: "640b42d913010477835200f35303790cc2015fabc9740d97b4f0ddabbe6f7bd3", bytes: 441 }),
    ponytail: Object.freeze({ path: "scripts/fixtures/skill-classification-implementation.2.9.1.md", sha256: "8bc16704d7e295f7dd389bf43a39c922d82a1e7733675d9fe37c5ec660bbad16", fixtureBytes: 298, suffix: "\n", bytes: 299 }),
  }),
  hashes: Object.freeze({
    "skills/acceptance-evidence-validator/classification.json": "8e5df6db63ddef4b4663df69cf102c66819e6a9c6883ca50681cf62e890e0db1",
    "skills/blocker-diagnostician/classification.json": "0d1aa4f87b5ec8d27f862b24c2988c72c020d0e1493e8493e1b3642a28069b38",
    "skills/change-scope-guardian/classification.json": "52103f0dde99c31e42dd548e6234a5198d9a1a5b7d639087dd54a52ae304ff0f",
    "skills/code-review/classification.json": "d4253d69e8ebf8f384f5e5a93e375f128546e06a72c54220eea0c28f99521ac4",
    "skills/codex-token-usage-analyzer/classification.json": "1f52246a9a1e8cd22c811d6ed26409910a7d844f4d4f67ca5d639f00d2ca03d3",
    "skills/context-continuity/classification.json": "d2441089650196242dba576e9c11ae791f05fb8955e40b8a2b3cf63f2e09dfc5",
    "skills/coordinate-subagents/classification.json": "2fb7b1956b081acd07f6d17a0d17f083426bcf65d27873250e56877c84ec49dc",
    "skills/cs-engineering/classification.json": "7ae34e15610c902316956642c74ca9b5186a2a7226ff623a3bd92bf0189ec592",
    "skills/evaluation-validity-auditor/classification.json": "1515fe42d89383f5dcdeeeb165ccf8341481ae59ce4f0f9065ac9fdd5a467afd",
    "skills/independent-audit-gate/classification.json": "ecc3cfc7486a232eb02de3cdcc775e449813a685e620ca8530eb0742574d6908",
    "skills/independent-deliberation-panel/classification.json": "936f167838041d925990c9e853062f531069d64bcbfc95658c2e5399ed6792fe",
    "skills/instruction-scope-resolver/classification.json": "260ffec71166aa7a6403d78f98b3a2e41bac4f0eebc66ce242ac7d0618c453dc",
    "skills/iteration-frame-auditor/classification.json": "bfe14a5aa19ba5711963f4b93abce34e44ac4809bcb16c1f5fe7f8ce7dce5a59",
    "skills/korean-prose-editor/classification.json": "8f49189dcf8106d2f242a186b8ebf46238ae5ed54101e43e7860dc7eedfe0ceb",
    "skills/model-effort-advisor/classification.json": "81d04623e6881ba127c1cdac3d6f53f228e4cfc8d4d38d567e06a1f309299d94",
    "skills/mutation-risk-preflight/classification.json": "0487794c38433a3153a5dee86de5ff524c16e84d7ac5f4a41f2ca4ab0328b99f",
    "skills/orchestrator/SKILL.md": "96125291e406b124a6559a269842d434112b98bdf28c49c752ef67dea38700b8",
    "skills/orchestrator/classification.json": "41891843dbbf4d4e86e830ad2d14613a67851fec35f04746ccad6c49e248cf0c",
    "skills/orchestrator/references/skill-classification.md": "85cfd39b4c3771669747a9ebf61bc8623b510104c4bd6af40c2168781adc3ef8",
    "skills/ponytail/SKILL.md": "f9531bdd7ec9f9a46cdd09e3cc4cbe34b9dce80330bd71cc99f52cbee2a910cd",
    "skills/ponytail/classification.json": "3ab551f50bf4aae31ae0b4c3c3fd6158f8fde1cee75d62b68a07b7e49f22a481",
    "skills/recovery-strategy-selector/classification.json": "c9f3e8cd8f7982fe36c23115d3e4ceceeb7a5c0f8bd747a8c0158c81e1642314",
    "skills/session-board/classification.json": "7193daa7a84da2918be65472c086624b5748f2122bf2071993c96e3afe20dd7e",
    "skills/software-security-auditor/classification.json": "f6354e18d117d008a8c8e8fc176eefa96e72eebb6040980d92dc3b4f861c3228",
    "skills/task-contract/classification.json": "a0dc1edbc83b0b79b479956f780dbb197db36039d04c15546837946ddd02c213",
    "skills/test-engineering/classification.json": "b7cd174b0a314bf228ac0a32f9c7c33ffe1494852c90ebd73c7682d548bb3e1c",
    "skills/workspace-convention-profiler/classification.json": "15c01583cc8a233fd969ea873cf5ba0d56a6fc305cd2a9ff7ed7b57338cb2853",
  }),
});
// Exact current policy successor; historical optimization/classification pins remain intact.
const PONYTAIL_POLICY_SUCCESSOR = Object.freeze({
  baselineRevision: "3b7555015dac80a601db8690430baa18f1d7b60b",
  hashes: Object.freeze({
    "skills/ponytail/SKILL.md": "953fd16ff07c23b9481e9bdfca12dbb0d115422ebdbd6626bae6b574838a777c",
    "skills/ponytail/agents/openai.yaml": "99b2f27b7983ae2543010244c90280519152c061c7ab8f817e629d5eb63fb64b",
    "skills/ponytail/classification.json": "beffd9f692ee156074e6c4a12f0afafd8d82c0b26c316b3d373754241fe2f401",
    "skills/orchestrator/SKILL.md": "1cfaf8503aacae72fb7e2591e708bea507848ae338e21855c15e4b1ccb635cd1",
    "skills/orchestrator/classification.json": "6e1ab44e91e1be1d9ee6be473ec332bed670a9f20ae80fab8deedd68d6a8ec76"
}),
});

export function matchesPonytailPolicySuccessor(path, bytes) {
  return Object.hasOwn(PONYTAIL_POLICY_SUCCESSOR.hashes, path)
    && createHash("sha256").update(bytes).digest("hex") === PONYTAIL_POLICY_SUCCESSOR.hashes[path];
}

// Exact implementation bytes integrated after the historical optimization.
// This validates source identity only; it grants no review or execution authority.
const CURRENT_IMPLEMENTATION_PINS = Object.freeze({
  revision: "3.0.0-source-integration-r16-repairs",
  authorityEffect: "none",
  hashes: Object.freeze({
  "skills/acceptance-evidence-validator/scripts/check-repository.mjs": "29cde6044e0c874df4d5b7503445d22e0479b0d855227231f43b2a939838abdc",
  "skills/acceptance-evidence-validator/scripts/core.d.mts": "5ad79b91fd34d6d4f07321b1011e2b48b5311a89296d10c360ed108ed92f45cf",
  "skills/acceptance-evidence-validator/scripts/core.mjs": "6147dfdd2b62b971b5965f6decc41544a1e77fa0f06b115ab003ef487c415393",
  "skills/acceptance-evidence-validator/scripts/schema-validation.mjs": "bdcf2686ba65e38175f17f8c04167e5b822e22390ae2c9415084b9cd57f20eae",
  "skills/blocker-diagnostician/scripts/check-repository.mjs": "fae24b9cc8186afdd484476e0107e796093e8369d2ec9ab9d4edbc5feb5279a8",
  "skills/change-scope-guardian/scripts/lib.mjs": "5c7b40ebb6064e6c76d5b29074c517eca2074ea47c0c7e6519ddb02f3872e985",
  "skills/change-scope-guardian/scripts/schema-validator.mjs": "ff48309ac4549d1fce4df6a4748331504719af6352152df7cbbc371054379dfb",
  "skills/codex-token-usage-analyzer/scripts/core.mjs": "99873c0891969d8055efa8d765abf80405863966287da9ac147695c9c1597e7e",
  "skills/codex-token-usage-analyzer/scripts/schema-validation.mjs": "06a35eb68b3d67e9fbcc1bbe8fe3fa57e51e792173aee3c8aeec80537616cc90",
  "skills/coordinate-subagents/references/model-routing-presets.json": "f47d4f6f404256d7020bf84b5d2ba6daea46014e187db13e0268c4c15c98d99d",
  "skills/coordinate-subagents/references/model-routing.md": "08d6b87efe41c2c7ed901f33a81324a787eda37e41badc2e29c6c1c4de572e9e",
  "skills/coordinate-subagents/scripts/model-catalog-adapter.d.mts": "936efbf8e7bbcef4f0c452ec4e4fe876c6f9ecb53a82df3d7d60de63bd684026",
  "skills/coordinate-subagents/scripts/model-catalog-adapter.mjs": "c6e74b706f89882cfa94e5269c8fb77c9011b731b9ee136d5396ecaa7f828834",
  "skills/coordinate-subagents/scripts/model-routing.d.mts": "4afbbfc1167ee637d1aab74bbfe4ec55241931d33fa55442b94dcea8d8e93fbe",
  "skills/coordinate-subagents/scripts/model-routing.mjs": "ee3e7084ca52cef9a14d8eb5d3b4f79bcb3c91098ca0d1fd6bac30ad64e29b7e",
  "skills/evaluation-validity-auditor/scripts/check-repository.mjs": "e00e96e27843e08b8885d38c181e33cc26a2730f6dca2f524a1584786b074454",
  "skills/independent-deliberation-panel/evals/fixtures/valid/ad01_specialist_cap.json": "9423c10246f09738712ac0bf5b5f9134795fa8a9f03bfb4d2a2f2af96af3618f",
  "skills/independent-deliberation-panel/scripts/run_evals.py": "91b43afc879001917d0a49c4209beeea4a98ffad0b64163ebd85f778d7269f20",
  "skills/independent-deliberation-panel/scripts/validate_decision_record.py": "fa57d3ad2a2d2a5b5c42128f126ba4ff32e1d1f6bb412587abc3006e8cdb3d87",
  "skills/instruction-scope-resolver/references/gemini-instructions.md": "fb03a623c11627f8fed8cfad07d6c492fcd4a710dd73b25963840f8524b18a56",
  "skills/instruction-scope-resolver/scripts/resolve-instruction-files.mjs": "ff696ff9c2b8e19dba88b9ad8f140966d810b6ee5086d2ccd376ae6afc20b27b",
  "skills/iteration-frame-auditor/integration/skill-descriptor.json": "44b5fa664b83708b62f664606910558e09837f3bb84a232fdfe8b5e82e4fb1f1",
  "skills/iteration-frame-auditor/scripts/core.mjs": "efb17e2f3ab93074fd36c4464dcfd6848f4f1627757dacc47196c18bd40345f6",
  "skills/korean-prose-editor/contracts/protected-manifest.schema.json": "cb518ab89e3a6b2ad422f5015f58843291505cf6a7360a4983a18b974cec25c7",
  "skills/korean-prose-editor/contracts/receipt.schema.json": "2ad9e132c19e58c9fcdc2a15fce4715c840766ebce638722f11ee47173a688f4",
  "skills/korean-prose-editor/scripts/finalizer-core.mjs": "44e898697c65fa8bc8e678dda878da50af9129172f054f366ea5f64191ed71ed",
  "skills/korean-prose-editor/scripts/protected-spans.mjs": "b28573ebad7fa0f0842d6aa83b6c52ad239fa9a8ac74f9eb28feb3c4a64be232",
  "skills/mutation-risk-preflight/references/recovery-requirements.md": "41c5284d8dd1c5c9f1f7c6d8e090f8a2af36677fbb0bc8b21e18cbcf2d1754ed",
  "skills/mutation-risk-preflight/scripts/evaluate-preflight.mjs": "530bc651aa8ee506eba0a160f8e1989711b2257c16df449394f0e22b2023ed9c",
  "skills/mutation-risk-preflight/scripts/schema-validation.mjs": "4cce85dc38941f216349a8ac89fa230f2d40ea55d05ccb17b3d030bdd7a141d2",
  "skills/mutation-risk-preflight/scripts/validate-skill.mjs": "06da56be6a8eeb85c78fea914e437e30eb56ab1ffa5369d897255093d58c64dd",
  "skills/recovery-strategy-selector/scripts/schema-validation.mjs": "a18cbdd934c0cc49f59ed2b33b6756ebeddaaeb1d4b58315041462b82e94151b",
  "skills/task-contract/scripts/validate-task-contract.mjs": "18d2a516da23c58bd7e2b1317d10a42be5f25becdac2562f0ed161c724c5528b",
  "skills/workspace-convention-profiler/scripts/profile-workspace.mjs": "392276006eb7658af3c9704de5c50ce36acce6f678e32a4f4a629562cbea5608",
  "skills/workspace-convention-profiler/scripts/schema-validation.mjs": "d27f1dac298004831a2c1c04e0c07a24ad1c7021d3e56bf051ebaa73a71557f6",
  "skills/workspace-convention-profiler/scripts/validate-skill.mjs": "7e6e3d72f8848a0761753ca3d1bcf0821ad0a242419420db13f3e628e6694034"
}),
});

export function matchesCurrentImplementationPin(path, bytes) {
  return Object.hasOwn(CURRENT_IMPLEMENTATION_PINS.hashes, path)
    && createHash("sha256").update(bytes).digest("hex") === CURRENT_IMPLEMENTATION_PINS.hashes[path];
}

const TARGETS = [
  "acceptance-evidence-validator",
  "blocker-diagnostician",
  "change-scope-guardian",
  "codex-token-usage-analyzer",
  "context-continuity",
  "coordinate-subagents",
  "evaluation-validity-auditor",
  "independent-audit-gate",
  "independent-deliberation-panel",
  "instruction-scope-resolver",
  "iteration-frame-auditor",
  "korean-prose-editor",
  "model-effort-advisor",
  "mutation-risk-preflight",
  "orchestrator",
  "recovery-strategy-selector",
  "session-board",
  "software-security-auditor",
  "task-contract",
  "workspace-convention-profiler"
];
const NO_SEPARATOR_SUFFIX = new Set(["context-continuity", "session-board"]);
const README_CHANGES = new Set(["independent-audit-gate", "independent-deliberation-panel"]);
const NODE24_README_MINIMUMS = Object.freeze({
  "acceptance-evidence-validator": "Node.js 22 이상",
  "blocker-diagnostician": "Node.js 22 이상",
  "change-scope-guardian": "Node.js 22 이상",
  "evaluation-validity-auditor": "Node.js 22.13 이상",
  "instruction-scope-resolver": "Node.js 22 이상",
  "mutation-risk-preflight": "Node.js 22 이상",
  "task-contract": "Node.js 22 이상",
  "workspace-convention-profiler": "Node.js 22 이상",
});
const NAVIGATION = Buffer.from('<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->\n- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.\n<!-- optimization-navigation:end -->\n');

function git(...args) {
  return execFileSync("git", ["-C", ROOT, ...args], { maxBuffer: 20 * 1024 * 1024 });
}

function baselineFile(path) {
  return git("show", `${BASELINE}:${path}`);
}

function frontmatter(bytes) {
  const end = bytes.indexOf(Buffer.from("\n---\n"), 4);
  return bytes.subarray(0, end < 0 ? 0 : end + 5);
}

function sameSet(left, right) {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

export function matchesNode24ReadmeUpdate(skillId, baseline, candidate) {
  const minimum = NODE24_README_MINIMUMS[skillId];
  return Boolean(minimum) && baseline.split(minimum).length === 2
    && candidate === baseline.replace(minimum, "Node.js 24.0.0 이상");
}

export function matchesOrchestratorIntakeUpdate(kind, bytes) {
  return Object.hasOwn(ORCHESTRATOR_INTAKE.hashes, kind)
    && createHash("sha256").update(bytes).digest("hex") === ORCHESTRATOR_INTAKE.hashes[kind];
}

export function matchesEngineeringReferenceUpdate(name, bytes) {
  const reviewedPath = `skills/orchestrator/references/engineering-practices/${name}`;
  if (Object.hasOwn(REVIEWED_IMPLEMENTATION_R1.hashes, reviewedPath)) {
    return matchesReviewedImplementationUpdate(reviewedPath, bytes);
  }
  return Object.hasOwn(ENGINEERING_REFERENCES, name)
    && createHash("sha256").update(bytes).digest("hex") === ENGINEERING_REFERENCES[name];
}

export function matchesReviewedImplementationUpdate(path, bytes) {
  const reviewed = Object.hasOwn(REVIEWED_IMPLEMENTATION_R2.hashes, path) ? REVIEWED_IMPLEMENTATION_R2 : REVIEWED_IMPLEMENTATION_R1;
  return Object.hasOwn(reviewed.hashes, path)
    && createHash("sha256").update(bytes).digest("hex") === reviewed.hashes[path];
}

export function matchesClassificationUpdate(path, bytes) {
  return matchesPonytailPolicySuccessor(path, bytes) || Object.hasOwn(CLASSIFICATION_UPDATE.hashes, path)
    && createHash("sha256").update(bytes).digest("hex") === CLASSIFICATION_UPDATE.hashes[path];
}

function withoutClassificationAddition(skillId, bytes, root = ROOT) {
  const currentPath = `skills/${skillId}/SKILL.md`;
  if (matchesPonytailPolicySuccessor(currentPath, bytes)) bytes = git("show", `${PONYTAIL_POLICY_SUCCESSOR.baselineRevision}:${currentPath}`);
  const frozen = CLASSIFICATION_UPDATE.additions[skillId];
  const fixture = readFileSync(join(root, frozen.path));
  const addition = Buffer.concat([fixture, Buffer.from(frozen.suffix ?? "")]);
  const index = bytes.indexOf(addition);
  if (fixture.length !== (frozen.fixtureBytes ?? frozen.bytes) || addition.length !== frozen.bytes || createHash("sha256").update(fixture).digest("hex") !== frozen.sha256
    || index < 0 || bytes.indexOf(addition, index + addition.length) >= 0) {
    throw new Error(`${skillId}: pinned 2.9.1 classification addition differs`);
  }
  return Buffer.concat([bytes.subarray(0, index), bytes.subarray(index + addition.length)]);
}

export function reconstructOptimizedSkill(skillId, root = ROOT) {
  const bytes = readFileSync(join(root, "skills", skillId, "SKILL.md"));
  const candidate = skillId === "orchestrator" ? withoutClassificationAddition(skillId, bytes, root) : bytes;
  let detail = readFileSync(join(root, "skills", skillId, "references", "entry-details.md"));
  if (skillId === "orchestrator") {
    const engineeringAddition = readFileSync(join(root, ENGINEERING_ADDITION));
    if (createHash("sha256").update(engineeringAddition).digest("hex") !== ENGINEERING_ADDITION_SHA256
      || !detail.subarray(-engineeringAddition.length).equals(engineeringAddition)) {
      throw new Error("orchestrator: pinned 2.8.1 Engineering Practices addition differs");
    }
    detail = detail.subarray(0, detail.length - engineeringAddition.length);
    const addition = readFileSync(join(root, CS_HANDOFF_ADDITION));
    if (createHash("sha256").update(addition).digest("hex") !== CS_HANDOFF_SHA256
      || !detail.subarray(-addition.length).equals(addition)) {
      throw new Error("orchestrator: pinned 2.8.0 CS handoff addition differs");
    }
    detail = detail.subarray(0, detail.length - addition.length);
  }
  const baselineRelativeDetail = Buffer.from(detail.toString("utf8").replace(/\]\((?![A-Za-z][A-Za-z0-9+.-]*:|#|\/)([^)\s]+)\)/gu, (_match, target) => `](${posix.normalize(posix.join("references", target))})`));
  const markerIndex = candidate.indexOf(NAVIGATION);
  if (markerIndex < 0) throw new Error(`${skillId}: navigation marker is missing`);
  const suffix = NO_SEPARATOR_SUFFIX.has(skillId) ? Buffer.alloc(0) : Buffer.from("\n");
  return Buffer.concat([candidate.subarray(0, markerIndex), baselineRelativeDetail, suffix, candidate.subarray(markerIndex + NAVIGATION.length)]);
}

export function checkSkillContextOptimization() {
  const errors = [];
  for (const reviewedPath of Object.keys(CLASSIFICATION_UPDATE.hashes)) {
    if (!matchesClassificationUpdate(reviewedPath, readFileSync(join(ROOT, reviewedPath)))) errors.push(`classification: reviewed bytes differ: ${reviewedPath}`);
  }
  for (const currentPath of Object.keys(PONYTAIL_POLICY_SUCCESSOR.hashes)) {
    if (!matchesPonytailPolicySuccessor(currentPath, readFileSync(join(ROOT, currentPath)))) errors.push(`policy successor bytes differ: ${currentPath}`);
  }
  for (const currentPath of Object.keys(CURRENT_IMPLEMENTATION_PINS.hashes)) {
    if (!matchesCurrentImplementationPin(currentPath, readFileSync(join(ROOT, currentPath)))) {
      errors.push(`current implementation bytes differ: ${currentPath}`);
    }
  }
  const detailOwners = readdirSync(join(ROOT, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((skillId) => {
      try {
        readFileSync(join(ROOT, "skills", skillId, "references", "entry-details.md"));
        return true;
      } catch {
        return false;
      }
    });
  if (!sameSet(detailOwners, TARGETS)) errors.push("target skill set does not match the 20 reviewed optimization targets");

  let baselineBytes = 0;
  let candidateBytes = 0;
  const skills = [];
  for (const skillId of TARGETS) {
    const skillPath = `skills/${skillId}/SKILL.md`;
    const detailPath = `skills/${skillId}/references/entry-details.md`;
    const baseline = baselineFile(skillPath);
    const candidate = readFileSync(join(ROOT, ...skillPath.split("/")));
    const markerIndex = candidate.indexOf(NAVIGATION);
    const markerCount = candidate.toString("utf8").split("<!-- optimization-navigation:start").length - 1;
    const reconstructed = markerIndex < 0 ? Buffer.alloc(0) : reconstructOptimizedSkill(skillId);

    if (markerCount !== 1 || markerIndex < 0) errors.push(`${skillId}: navigation marker must occur exactly once`);
    let expectedBaseline = baseline;
    if (skillId === "session-board") {
      const addition = readFileSync(join(ROOT, SESSION_BOARD_ADDITION));
      if (createHash("sha256").update(addition).digest("hex") !== SESSION_BOARD_ADDITION_SHA256) errors.push("session-board: approved 2.6.0 guidance fixture changed");
      expectedBaseline = Buffer.concat([baseline, addition]);
    }
    if (skillId === "orchestrator") {
      if (!matchesOrchestratorIntakeUpdate("reconstructed", reconstructed)) errors.push("orchestrator: reconstructed intake policy differs from the pinned revision");
      if (!matchesOrchestratorIntakeUpdate("frontmatter", frontmatter(candidate))) errors.push("orchestrator: intake frontmatter differs from the pinned revision");
      if (withoutClassificationAddition(skillId, candidate).length > ORCHESTRATOR_INTAKE.initialMaxBytes) errors.push("orchestrator: historical initial load exceeds the pre-intake limit");
      const reference = readFileSync(join(ROOT, "skills/orchestrator/references/mcp-execution.md"));
      if (!matchesOrchestratorIntakeUpdate("mcpExecution", reference)) errors.push("orchestrator: MCP execution policy differs from the pinned revision");
    } else if (skillId === "model-effort-advisor") {
      for (const approvedPath of [skillPath, detailPath, "skills/model-effort-advisor/scripts/support-guard.mjs"]) {
        if (!matchesReviewedImplementationUpdate(approvedPath, readFileSync(join(ROOT, approvedPath)))) {
          errors.push(`model-effort-advisor: reviewed implementation bytes differ: ${approvedPath}`);
        }
      }
      if (createHash("sha256").update(reconstructed).digest("hex") !== REVIEWED_IMPLEMENTATION_R2.modelReconstructedSha256) {
        errors.push("model-effort-advisor: reconstructed reviewed implementation differs");
      }
      if (candidate.length > REVIEWED_IMPLEMENTATION_R1.modelInitialMaxBytes) errors.push("model-effort-advisor: initial load exceeds its reviewed limit");
      if (!frontmatter(candidate).equals(frontmatter(baseline))) errors.push("model-effort-advisor: frontmatter changed");
    } else if (skillId === "instruction-scope-resolver") {
      for (const [reviewedPath, sha256] of Object.entries(REVIEWED_RESOLVER_N_DESC_RULE.hashes)) {
        if (createHash("sha256").update(readFileSync(join(ROOT, reviewedPath))).digest("hex") !== sha256) {
          errors.push(`instruction-scope-resolver: reviewed output-contract bytes differ: ${reviewedPath}`);
        }
      }
      if (createHash("sha256").update(reconstructed).digest("hex") !== REVIEWED_RESOLVER_N_DESC_RULE.reconstructedSha256) {
        errors.push("instruction-scope-resolver: reconstructed reviewed output contract differs");
      }
      if (!frontmatter(candidate).equals(frontmatter(baseline))) errors.push("instruction-scope-resolver: frontmatter changed");
    } else {
      if (!reconstructed.equals(expectedBaseline)) errors.push(`${skillId}: SKILL.md plus entry-details.md does not reconstruct the baseline byte-for-byte`);
      if (!frontmatter(candidate).equals(frontmatter(baseline))) errors.push(`${skillId}: frontmatter changed`);
    }
    if (candidate.length >= baseline.length) errors.push(`${skillId}: initial SKILL.md did not shrink`);

    const descriptorPath = `skills/${skillId}/agents/openai.yaml`;
    if (!readFileSync(join(ROOT, ...descriptorPath.split("/"))).equals(baselineFile(descriptorPath))) errors.push(`${skillId}: agents/openai.yaml changed`);

    const allowed = new Set([skillPath, detailPath]);
    for (const currentPath of Object.keys(CURRENT_IMPLEMENTATION_PINS.hashes)) {
      if (currentPath.startsWith(`skills/${skillId}/`)) allowed.add(currentPath);
    }
    for (const reviewedPath of Object.keys(CLASSIFICATION_UPDATE.hashes)) if (reviewedPath.startsWith(`skills/${skillId}/`)) allowed.add(reviewedPath);
    if (skillId === "session-board") {
      for (const reviewedPath of ["skills/session-board/scripts/board-store.mjs", "skills/session-board/scripts/board-store.d.mts"]) {
        if (!matchesReviewedImplementationUpdate(reviewedPath, readFileSync(join(ROOT, reviewedPath)))) {
          errors.push(`session-board: reviewed implementation bytes differ: ${reviewedPath}`);
        }
        allowed.add(reviewedPath);
      }
    }
    if (skillId === "model-effort-advisor") allowed.add("skills/model-effort-advisor/scripts/support-guard.mjs");
    if (skillId === "orchestrator") {
      allowed.add("skills/orchestrator/references/mcp-execution.md");
      for (const name of Object.keys(ENGINEERING_REFERENCES)) {
        const referencePath = `skills/orchestrator/references/engineering-practices/${name}`;
        if (!matchesEngineeringReferenceUpdate(name, readFileSync(join(ROOT, referencePath)))) {
          errors.push(`orchestrator: pinned engineering reference differs: ${name}`);
        }
        allowed.add(referencePath);
      }
    }
    if (README_CHANGES.has(skillId)) allowed.add(`skills/${skillId}/README.md`);
    if (Object.hasOwn(NODE24_README_MINIMUMS, skillId)) {
      const readmePath = `skills/${skillId}/README.md`;
      const baselineReadme = baselineFile(readmePath).toString("utf8").replaceAll("\r\n", "\n");
      const candidateReadme = readFileSync(join(ROOT, ...readmePath.split("/")), "utf8").replaceAll("\r\n", "\n");
      if (!matchesNode24ReadmeUpdate(skillId, baselineReadme, candidateReadme)) errors.push(`${skillId}: README.md differs beyond the Node 24 minimum update`);
      allowed.add(readmePath);
    }
    const changed = git("diff", "--name-only", BASELINE, "--", `skills/${skillId}`).toString("utf8").trim().split(/\r?\n/u).filter(Boolean);
    changed.push(...git("ls-files", "--others", "--exclude-standard", "--", `skills/${skillId}`)
      .toString("utf8").trim().split(/\r?\n/u).filter(Boolean));
    const unexpected = [...new Set(changed)].filter((path) => !allowed.has(path));
    if (unexpected.length) errors.push(`${skillId}: unexpected skill-owned changes: ${unexpected.join(", ")}`);

    baselineBytes += baseline.length;
    candidateBytes += candidate.length;
    skills.push({ skillId, baselineBytes: baseline.length, candidateBytes: candidate.length, reducedBytes: baseline.length - candidate.length });
  }

  const registry = JSON.parse(readFileSync(join(ROOT, "skills", "registry.json"), "utf8"));
  const engineering = registry.skills.filter((skill) => ["test-engineering", "code-review"].includes(skill.skillId));
  const frozenRegistry = { ...registry, skills: registry.skills.filter((skill) => !engineering.includes(skill)) };
  const registryDigest = (value) => createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`).digest("hex");
  if (registryDigest(frozenRegistry) !== CS_REGISTRY_SHA256) errors.push("existing skills/registry.json differs from pinned 2.8.0 candidate");
  if (registryDigest(engineering) !== ENGINEERING_REGISTRY_SHA256) errors.push("Engineering Practices registry differs from pinned descriptors");
  const ponytail = readFileSync(join(ROOT, "skills/ponytail/SKILL.md"));
  if (!withoutClassificationAddition("ponytail", ponytail).equals(baselineFile("skills/ponytail/SKILL.md"))) errors.push("excluded skill ponytail historical instructions changed");
  const ponytailChanged = [...new Set([
    ...git("diff", "--name-only", BASELINE, "--", "skills/ponytail").toString("utf8").trim().split(/\r?\n/u),
    ...git("ls-files", "--others", "--exclude-standard", "--", "skills/ponytail").toString("utf8").trim().split(/\r?\n/u),
  ].filter(Boolean))].filter((file) => !Object.hasOwn(CLASSIFICATION_UPDATE.hashes, file) && !Object.hasOwn(PONYTAIL_POLICY_SUCCESSOR.hashes, file));
  if (ponytailChanged.length) errors.push(`excluded skill ponytail unexpected changes: ${ponytailChanged.join(", ")}`);
  if (candidateBytes >= baselineBytes) errors.push("combined initial SKILL.md bytes did not shrink");

  return {
    baselineRevision: BASELINE,
    approvedAdditions: [{ skillId: "session-board", path: SESSION_BOARD_ADDITION, sha256: SESSION_BOARD_ADDITION_SHA256 }],
    policyBaselineUpdates: [{ skillId: "orchestrator", ...ORCHESTRATOR_INTAKE }],
    reviewedImplementationUpdates: [REVIEWED_IMPLEMENTATION_R1],
    activeReviewedImplementationUpdates: [REVIEWED_IMPLEMENTATION_R2],
    reviewedOutputContractUpdates: [REVIEWED_RESOLVER_OUTPUT_CONTRACT],
    activeReviewedOutputContractUpdates: [REVIEWED_RESOLVER_N_DESC_RULE],
    reviewedClassificationUpdates: [CLASSIFICATION_UPDATE],
    currentImplementationPins: [CURRENT_IMPLEMENTATION_PINS],
    currentPolicySuccessors: [PONYTAIL_POLICY_SUCCESSOR],
    runtimeBaselineUpdates: Object.entries(NODE24_README_MINIMUMS).map(([skillId, before]) => ({ skillId, before, after: "Node.js 24.0.0 이상" })),
    pass: errors.length === 0,
    errors,
    totals: {
      skillCount: TARGETS.length,
      baselineBytes,
      candidateBytes,
      reducedBytes: baselineBytes - candidateBytes,
      reductionPercent: Number((((baselineBytes - candidateBytes) / baselineBytes) * 100).toFixed(6))
    },
    skills
  };
}

function main() {
  const report = checkSkillContextOptimization();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.pass) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
