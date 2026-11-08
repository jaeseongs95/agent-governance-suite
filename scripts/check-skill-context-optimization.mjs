import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync as readFileBytes, readdirSync } from "node:fs";
import { dirname, join, posix, relative as relativePath, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Output named only by full commit SHAs (`show <sha>:<path>`, `diff --name-only --no-renames -z <sha> <sha>`) cannot
// change, so it is kept for the process, across module reloads (vi.resetModules). The cache belongs to the execFileSync
// in use, so a mocked child_process sees every call. Working-tree and index reads (`diff <sha> --`, `ls-files`) always run.
const COMMIT = /^[0-9a-f]{40}$/u;
const IMMUTABLE_GIT = Symbol.for("ags.check-skill-context-optimization.immutable-git");
const GIT_OPTIONS = Object.freeze({ maxBuffer: 20 * 1024 * 1024 });
// Executable skill scripts are outside the initial-context contract. Their complete
// bytes (including new scripts) remain checked by source-lock, not manual successor pins.
const EXECUTABLE_SCRIPT = /^skills\/[^/]+\/scripts\/.+\.(?:mjs|py)$/u;

function git(...args) {
  const run = () => execFileSync("git", ["-C", ROOT, ...args], GIT_OPTIONS);
  const show = args.length === 2 && args[0] === "show" && /^[0-9a-f]{40}:/u.test(args[1]);
  const immutable = show
    || (args.length === 6 && args[0] === "diff" && args[1] === "--name-only" && args[2] === "--no-renames" && args[3] === "-z" && COMMIT.test(args[4]) && COMMIT.test(args[5]));
  if (!immutable) return run();
  const caches = (globalThis[IMMUTABLE_GIT] ??= new WeakMap());
  if (!caches.has(execFileSync)) caches.set(execFileSync, new Map());
  const cache = caches.get(execFileSync);
  const key = JSON.stringify([ROOT, ...args]);
  if (show && !cache.has(key)) prefetchHistory(cache, args[1].slice(0, 40), args[1].slice(41).split("/")[0]);
  if (!cache.has(key)) cache.set(key, run());
  return Buffer.from(cache.get(key));
}

/**
 * Fills the immutable cache with every blob under `top` at `revision` in two processes (`ls-tree`, `cat-file --batch`)
 * instead of one `git show` per path. A path the listing does not yield (missing at the revision, an executable script,
 * a name cat-file cannot take on one line) stays uncached and is read by `git show`, which also reports its own error.
 * ponytail: reads the whole `top` tree once per revision, a few MB here; narrow the listing if that tree grows large.
 */
function prefetchHistory(cache, revision, top) {
  const marker = JSON.stringify([ROOT, "prefetched", revision, top]);
  if (cache.has(marker)) return;
  cache.set(marker, Buffer.alloc(0));
  let listing;
  // A listing failure only skips the prefetch: each read then runs `git show` and fails with git's own message.
  try { listing = execFileSync("git", ["-C", ROOT, "ls-tree", "-r", "-z", revision, "--", top], GIT_OPTIONS).toString("utf8"); }
  catch { return; }
  const pending = [];
  for (const entry of listing.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [, type, oid] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (type !== "blob" || EXECUTABLE_SCRIPT.test(path) || /[\r\n]/u.test(path)) continue;
    const key = JSON.stringify([ROOT, "show", `${revision}:${path}`]);
    const blob = JSON.stringify([ROOT, "blob", oid]);
    if (cache.has(blob)) cache.set(key, cache.get(blob));
    else pending.push({ key, blob, oid, spec: `${revision}:${path}` });
  }
  if (!pending.length) return;
  const output = execFileSync("git", ["-C", ROOT, "cat-file", "--batch"], { ...GIT_OPTIONS, input: pending.map(item => `${item.spec}\n`).join("") });
  let offset = 0;
  for (const item of pending) {
    const end = output.indexOf(10, offset);
    if (end < 0) throw new Error(`git cat-file --batch output ended before ${item.spec}`);
    const header = output.subarray(offset, end).toString("utf8");
    offset = end + 1;
    if (header === `${item.spec} missing` || header === `${item.spec} ambiguous`) continue;
    const match = /^([0-9a-f]{40,64}) blob (\d+)$/u.exec(header);
    if (!match || match[1] !== item.oid) throw new Error(`Unexpected git cat-file --batch header for ${item.spec}: ${header}`);
    const bytes = Buffer.from(output.subarray(offset, offset + Number(match[2])));
    offset += bytes.length + 1;
    cache.set(item.blob, bytes);
    cache.set(item.key, bytes);
  }
}

/** Whether a path or directory differs between two commits: one cached listing per commit pair. */
function changedBetween(from, to, path) {
  return git("diff", "--name-only", "--no-renames", "-z", from, to).toString("utf8").split("\0")
    .some(entry => entry === path || entry.startsWith(`${path}/`));
}
// Reviewed guidance successors: these exact bytes stand for their predecessor at `revision`, so every existing pin
// keeps checking the same chain. Altered bytes are never projected.
// - 3.3.0 multi-workflow guidance (docs/archive/ags30-phase-check-design.md 7.5)
// - 3.4.0 JEV layer paragraph (docs/release-notes/release-notes-v3.4.0.md): JEV is the advisory slot, TypeSafe one implementation.
// - 3.5.1 intake line (docs/release-notes/release-notes-v3.5.1.md): separate tasks start separate workflows with non-overlapping writeTargets.
// - 3.5.2 mutation-risk-preflight overwrite line (docs/release-notes/release-notes-v3.5.2.md): ask before overwriting user state that cannot be backed up.
// - 3.5.2 intake line (docs/release-notes/release-notes-v3.5.2.md): ask once before the first write on an undetermined premise that changes the structure.
// - 3.6.0 intake lines (9c438be1): name checkpoint_context instead of the retired context-continuity skill, re-check
//   skills each message, reconcile plans; coordinate-subagents gives a verification agent an independent judgment.
// - 3.6.0 orchestrator stage line (155c3d15): a stage's provider is the contract its result is recorded under and does
//   not limit the skills used in the stage.
// - 3.8.0 intake role line (AGS3-D-0002/0003/0030): a session writes the role its user gave it, hands a request outside
//   it to the session holding that role or asks the user, and reviews delegation for independent units with the brief
//   rules; coordinate-subagents checks the net-benefit conditions instead of keeping work local by default.
// - 3.8.0 intake text (AGS3-D-0031/0032): the shared intake merges repeated sentences without dropping a rule and adds
//   the line that checks whether a target's purpose was already met before closing, deleting, reverting or replacing it.
// - 3.8.0 intake move (AGS3-D-0032): the intake block moves unchanged from SKILL.md to references/intake.md (a reviewed
//   addition below), SKILL.md keeps a one-line pointer, and entry-details.md links the moved section.
// - 3.8.0 field-neutral wording (AGS3-D-0038): nine general skills drop words that tied them to code work (구현,
//   테스트, diff, CI, 브랜치, 저장소 ...) or show them as one example; no line moves, spans keep their text bounds.
// - 3.8.0 intake blocked step (AGS3-D-0031, formerly D-0034): one rule holds only a blocked step and the steps that depend on it, says
//   what is blocked and who is waited on, and keeps the rest of the work going; the three narrower sentences merge into it.
// - 3.8.0 intake verify and ask (AGS3-D-0031, D-0036, D-0039, D-0040, D-0041): verification cases fixed before the work and
//   run at the user's real entry point, specific requests to the user, follow-up repairs inside an approved goal, and a
//   peer's blocker inside this session's role handled in that turn (intake lines 12 and 13).
// - 3.8.0 parent accountability (AGS3-T-0020): the role/delegation line keeps child results, records and mistakes with
//   their creating parent, requires direct checking/correction, and adds no unnecessary child-only control layer.
// - 3.8.0 D0006/D0020/D0029: statement-bound criteria, frame-target binding and observed board callers.
//   Only these five reviewed documentation deltas project onto the unchanged a2811393 context.
// A successor of an earlier successor projects onto it first, then along the earlier entry to its predecessor.
const GUIDANCE_SUCCESSORS = Object.freeze([
  // D0006/D0029 classification source bindings and the D0007 shared declaration move.
  // These exact successors retain the preceding context oracle; the runtime declarations
  // are independently pinned below so a re-export cannot hide changes to its contract.
  Object.freeze({
    // Root integration ancestor, not the byte-identical worker commit that is absent from clean release clones.
    revision: "c4121acbf1528a44ead7fd34f617afd7a25df814",
    hashes: Object.freeze({
      "skills/acceptance-evidence-validator/classification.json": ["0f014b4abc19bfb98a78e9b736afd0785b59d97a6f24b8f5b3febced73880a8c", "4ce9af6edc26969b41c776135e591bc0674f5d366445207083baf73d2899aff7"],
      "skills/session-board/classification.json": ["7df8a0d55377d9315899955ccae63d9623113517fdd49e91adb6201d2c25442e", "858968497e4d721fb34328db0ac67b3d27c19d97fe7bf9837b4ccfc4f6653e8a"],
      "skills/acceptance-evidence-validator/scripts/core.d.mts": ["5ad79b91fd34d6d4f07321b1011e2b48b5311a89296d10c360ed108ed92f45cf", "f8252d0f9e1903b050707c04b07ed836ee73877ff4d05867d250f812727162f6"],
      "skills/session-board/scripts/board-store.d.mts": ["87c8cbd745da273bee3bb9419b487173841d29f9f0bf83fe002f1d2ebd2ae1fe", "7df74618dd93dde5c8887145f216171a5764dab47ed6b5c1c0911e4b86cacec9"],
      "skills/orchestrator/scripts/collaboration-decision.d.mts": ["2d7bac5952b67b52e4aaa23934cd396eda1ad9aa864f30bcd2eae455f4c50650", "811fe56a56d85bdd10abd1c9e78928f98e955cae64c29d7133aa7df5cc561104"],
    }),
  }),
  Object.freeze({
    revision: "a281139387af096e696f8d50cc089ad09e9291fc",
    hashes: Object.freeze({
      "skills/acceptance-evidence-validator/README.md": ["278bb4e1190abfab15d2206eddd0dc8699ed0437ed619be8f1545568f07f371a", "4f49e5d001f337b03560a4d9fb2e4005be95f2fdf98f848aa71f9d2a92bb4674"],
      "skills/acceptance-evidence-validator/references/entry-details.md": ["2170380d980dbefbc306d256edad72b594ea27fc4de2fb58e6f7845343a64991", "34b8087c91fbd8b253e8753b62c5216c8a75d65dd40f0952b0929c87456d1a81"],
      "skills/acceptance-evidence-validator/references/evidence-protocol.md": ["f34164f4fec2dd2ee896a26dd8fbe5bbb9a07ed63a24a9c9593d35ee8ba40031", "85105dae431ae773e6f845c1b206b5f8098a7a08402db3d7ad1842d03b5fe094"],
      "skills/iteration-frame-auditor/references/review-protocol.md": ["c65692186d03c13973cd56bed09ce5f7f263038acc0de1b1720cb3499e1906a7", "ff51d095ccb9a2ce3484c818986f03a37d5e6dd73d6c8af94f288cf751047658"],
      "skills/session-board/references/entry-details.md": ["b89b50e2bacf86ca9268505d244336d5cbb212a7894ce629125201f512b8efce", "4c0571608a124e96da1b27510a8c42775b3c84396c46abb11a915f57f103a196"],
    }),
  }),
  Object.freeze({
    revision: "92f22e25d21eddff22c2400dabc0699d73700927",
    hashes: Object.freeze({
      "skills/orchestrator/references/convergence-guard.md": ["cb8bbae8f94c18a9c6dc4a90bec8bcaf0b91e414ffb223d1a514ab92d3bdb70f", "ad162b606d35a84995b579902f523e1a0ff426b6988fddf93cf263141466aca5"],
      "skills/orchestrator/references/mcp-execution.md": ["7106404c5bf8cacb3bb4ab2d63af0c0ac955a8ee9f3eb53462c1062e2ebd221a", "d32a61ac3c1da7017e2f1bcc312c6e412a32de7e7107b437b53fb80574444dd1"],
    }),
  }),
  Object.freeze({
    revision: "b0fc2b4d69e2fee195e4146cf9fbd3de2f94fa5b",
    hashes: Object.freeze({
      "skills/orchestrator/references/skill-classification.md": ["f33cce4afc3ef2480c94799f46ae78e133c1576e3b57a257c1046f6956d811c9", "ccf0c8829325f2874447c67993f2c04edb02ea462713de10f3733eabc892c6ac"],
    }),
  }),
  Object.freeze({
    revision: "54ef451f2944a6d1b46033d233690238c7ca84a9",
    hashes: Object.freeze({
      "skills/orchestrator/SKILL.md": ["02b979178d585cd3396865a86703c4a1102263ff52c8c9739163ea763a03ce25", "59977f4d215a5a67192c010016c049e65fafdd38c7e12b528e60a1ca8167e31d"],
      "skills/orchestrator/classification.json": ["fb1741dda17b431dd0a8c02935ba0a0b6f72989846ebc7df3761ef01ec04c487", "0bfffe499ca0d60c444f92205f3f8dbfff328e9070ae6ee551ab1c219d871f1d"],
    }),
  }),
  Object.freeze({
    revision: "a3ff66402860c508c80f7a996d1875ffa8700702",
    hashes: Object.freeze({
      "skills/mutation-risk-preflight/SKILL.md": ["00b8848c38e5eb3f8175f70b8c615d663b2a036a751603266502e3dbd48522ad", "03661acd0d0690a2576d77c0abd9e2baa8a7a0294d80760d50c617ea4f5bfa15"],
      "skills/mutation-risk-preflight/classification.json": ["045eb47dcd98736fdd763f06535d8d8b9c95aa9f5000fb7677d39548641eec3a", "984e917b95b59a090bb68e441fc9455b7a432c081997e90598f4d191fab43725"],
    }),
  }),
  Object.freeze({
    revision: "fc5ea360bbafafc8f5e54d466eb04f0d3ceba1bb",
    hashes: Object.freeze({
      "skills/orchestrator/SKILL.md": ["59977f4d215a5a67192c010016c049e65fafdd38c7e12b528e60a1ca8167e31d", "b4fea1a91eaa7dbff3049749d441c366baa962ad66a9e7d65cdcc55467b22604"],
      "skills/orchestrator/classification.json": ["0bfffe499ca0d60c444f92205f3f8dbfff328e9070ae6ee551ab1c219d871f1d", "887c5a38a041681a71e419b9a9e087f884ff8370cb5142c24ab80f290d4ab57f"],
    }),
  }),
  Object.freeze({
    revision: "e6e313864a4fe1be15ac2b199fb56284dbc327a9",
    hashes: Object.freeze({
      "skills/coordinate-subagents/classification.json": ["9ee93e2b274e672d3f5d707d1236e74928a814de787ff7d2bac33f84c49381e6", "e39a699e1bf8a024513fc79de21cd3b960f345af068cd1e4d761474b570e65a0"],
      "skills/coordinate-subagents/references/entry-details.md": ["4f29865da0ca78b114e038120d0a3165e5d22d339d0a81b9e11c1c1ce726577a", "5769d6ee39c9396cac4e55ace84257a93219c0fc3e8b293f67c9973747a0dc88"],
      "skills/orchestrator/SKILL.md": ["b4fea1a91eaa7dbff3049749d441c366baa962ad66a9e7d65cdcc55467b22604", "03ca8869bbf594118eb2020868d19e3c1e5bf1f8be4ec0ec071f2f237b8b122e"],
      "skills/orchestrator/classification.json": ["887c5a38a041681a71e419b9a9e087f884ff8370cb5142c24ab80f290d4ab57f", "7396c12527514eb07a892499cc9f2d55250228a06de7d6ba042a6a7b01fe2642"],
    }),
  }),
  Object.freeze({
    revision: "155c3d1568e7e64a0b6640c80afc4bbf39d7cab3",
    hashes: Object.freeze({
      "skills/orchestrator/references/entry-details.md": ["d9bf7de0283d671735e7c4f4e9994df12a0d24bd6f3be97182394c5c247016ab", "9827e50e480fbd70813e9c6f9643029e17e6b50d577bebd38d14b0e803a775fa"],
    }),
  }),
  Object.freeze({
    revision: "4849bdd43fded206f6661b0fc952c398a0682856",
    hashes: Object.freeze({
      "skills/orchestrator/SKILL.md": ["03ca8869bbf594118eb2020868d19e3c1e5bf1f8be4ec0ec071f2f237b8b122e", "ff64ea71c558540a990a8be07e75af5259b79fd390c104eb39d961fdc5174e10"],
      "skills/orchestrator/classification.json": ["7396c12527514eb07a892499cc9f2d55250228a06de7d6ba042a6a7b01fe2642", "7672db7d4e40ec4a8b8deb9f46ca8f0c8fe4253e9a537158de95de30b8712077"],
      "skills/coordinate-subagents/classification.json": ["e39a699e1bf8a024513fc79de21cd3b960f345af068cd1e4d761474b570e65a0", "c474abe1127e6206ed72c94902c24691c0d106ae4395ea7bbcbc92006a84de8a"],
      "skills/coordinate-subagents/references/entry-details.md": ["5769d6ee39c9396cac4e55ace84257a93219c0fc3e8b293f67c9973747a0dc88", "266ceb4fb5d7d3c553ef85485c93ac87c4df1bf0df5e2219fd99cc9a146bf882"],
      "skills/orchestrator/references/collaboration.md": ["e590f6cd87e5a352c27740f60329dae51a6ba95505747d9edaae59e3557f2f0d", "5f4aa4dedb3019a4c3f3515dd1fdfd03f78e136de0bded19c3b0ce46b99ce22a"],
    }),
  }),
  Object.freeze({
    revision: "d068dfd6ed0546c2f9ec422f3ecde73c48ddf610",
    hashes: Object.freeze({
      "skills/orchestrator/SKILL.md": ["ff64ea71c558540a990a8be07e75af5259b79fd390c104eb39d961fdc5174e10", "a491ab1d9ebf022a98d66713c8f4430b82eddb506424e9605659506825a0d39e"],
      "skills/orchestrator/classification.json": ["7672db7d4e40ec4a8b8deb9f46ca8f0c8fe4253e9a537158de95de30b8712077", "fdd6a12c9ef4916a1a65d91306544631af8ade845a499869464d9e187e8b300d"],
    }),
  }),
  Object.freeze({
    revision: "bdcb07922ffab9b40a166a6c15ef42db184fbe5f",
    hashes: Object.freeze({
      "skills/orchestrator/SKILL.md": ["a491ab1d9ebf022a98d66713c8f4430b82eddb506424e9605659506825a0d39e", "bffef87a7f7a2c88be3a5d778cb8dac01fcd25f11c2c55bf142da80a7031652f"],
      "skills/orchestrator/classification.json": ["fdd6a12c9ef4916a1a65d91306544631af8ade845a499869464d9e187e8b300d", "8af0e814b6cdc128de65a392274d718ba14ce3e34061d8c0492164e8d883109e"],
      "skills/orchestrator/references/entry-details.md": ["9827e50e480fbd70813e9c6f9643029e17e6b50d577bebd38d14b0e803a775fa", "abce8a5addf52b66c361561000a0f0db5c31f93fff9ad09a9fc8c2cc02988e41"],
    }),
  }),
  Object.freeze({
    revision: "86933a331d9356c3197708833da46b66b04aabdc",
    hashes: Object.freeze({
      "skills/orchestrator/classification.json": ["8af0e814b6cdc128de65a392274d718ba14ce3e34061d8c0492164e8d883109e", "478364b9bbd1cfd3b0c9102e4949d302abcca1b061a998321a40d37908be0c4d"],
      "skills/orchestrator/references/intake.md": ["77b5496ce490207317d016d2ca9f6a467dbd85bcfc39df86c561dec8d5a685b1", "0f9be58edcaa80ad7bd6a51ff7f49b39026bfa88e8955abf5d400ef11b4c6d80"],
    }),
  }),
  Object.freeze({
    revision: "e7990a87e1524b4114a5bb20bc520afcceab24a8",
    hashes: Object.freeze({
      "skills/orchestrator/classification.json": ["478364b9bbd1cfd3b0c9102e4949d302abcca1b061a998321a40d37908be0c4d", "62b52946ac5b7a07b98d66de34efac60b0e80d331deb00d8abc70aef71718463"],
      "skills/orchestrator/references/intake.md": ["0f9be58edcaa80ad7bd6a51ff7f49b39026bfa88e8955abf5d400ef11b4c6d80", "862109098be9ae581ab6fe7f99c57060862818bc966ae5d3a62fd0d1ed288410"],
    }),
  }),
  Object.freeze({
    revision: "2133f629fa74400a961465178905be8d001a52f2",
    hashes: Object.freeze({
      "skills/orchestrator/classification.json": ["62b52946ac5b7a07b98d66de34efac60b0e80d331deb00d8abc70aef71718463", "779ab8157b1fc358739858c122d39186f7828f9912ec89dc0c0f34435187b294"],
      "skills/orchestrator/references/intake.md": ["862109098be9ae581ab6fe7f99c57060862818bc966ae5d3a62fd0d1ed288410", "8f0860a4efbd975887727b4e284d550af2f9ceb412f7f0a178cdb5f11967bff9"],
    }),
  }),
  Object.freeze({
    revision: "6ce31f6773d9617c321ba28972532578d1329ede",
    hashes: Object.freeze({
      "skills/acceptance-evidence-validator/SKILL.md": ["24cee8ff520bcd394af0b3d3aa9d28d8147838191660373b3ce9f3fbd8e8d02f", "a67f069130fa3e03b93287088b035f4c2e7c663083d60e2bc5ec865e3032acb2"],
      "skills/acceptance-evidence-validator/classification.json": ["99894b6b18ab993c8a9b375961e1f303b77337548358bec3a15058ea79529949", "0f014b4abc19bfb98a78e9b736afd0785b59d97a6f24b8f5b3febced73880a8c"],
      "skills/blocker-diagnostician/SKILL.md": ["45a4607b88363a062ea0fe30298dbd45c27912d2227bb34e3bb392a0fd54af2f", "16ff661fbbbc380a3fdb711ebef884b44d5d06a891e7066c2e1e290c949d6862"],
      "skills/blocker-diagnostician/classification.json": ["7cc63979194e79cd4a7889b5e25203cd03144f2290510b866ec38c1eb0efa0fb", "84fefbfb294d72598f48b1c63832f7e3594bcec7caef899b1b0c595ddadabbce"],
      "skills/coordinate-subagents/SKILL.md": ["2083c3a6ac114a34fea4014d6dda913e78670347cae9685e894fd7a0473aea8f", "9dfea8d94be467700ea4e8dac86a21040b57c1161ff46ddc0cf63cef97e305e7"],
      "skills/coordinate-subagents/classification.json": ["c474abe1127e6206ed72c94902c24691c0d106ae4395ea7bbcbc92006a84de8a", "bd2fd05d3e93cd4f4b08af021a0fa77ef3787b57550e17f75fbbe3ecdd629957"],
      "skills/independent-audit-gate/SKILL.md": ["601e00c54a44ec31f472c4cc447441c9a8167769f8721d349591b47feeb92aab", "8ce58c59628bb7cff11f508e5bfebf7e2d2bf37b7fadea1890f41d7ed370c669"],
      "skills/independent-audit-gate/classification.json": ["2d6752feb9ec2751e166e33b7e3f1b2c6b3c977a4e7332362c60a4306d17bda9", "9e5773f0b7eec9d9d8b4cf3ef5cc3d7eea00a737832c5a82a9d9394f130faeb3"],
      "skills/iteration-frame-auditor/SKILL.md": ["b7ac836ba1d362d85450a62ffd3470fc21652389caa600b1bafdd52245ce4162", "5557007286bec1081302f175b0047a4a2a8ce1aa2b66779ee93b43c698143f0c"],
      "skills/iteration-frame-auditor/classification.json": ["253a1f8029ef051f0f3812b416705c26575562a991dae5f07350fbe0dc2f31f1", "2b418a3da47aa4b07170cfb4b357a54a98a4b7747b3c9385b4158bddf948730f"],
      "skills/mutation-risk-preflight/SKILL.md": ["03661acd0d0690a2576d77c0abd9e2baa8a7a0294d80760d50c617ea4f5bfa15", "65647ea80f4d7546f76f8691def730b240ca2e8a892aeb69cfd10d855ff1f557"],
      "skills/mutation-risk-preflight/classification.json": ["984e917b95b59a090bb68e441fc9455b7a432c081997e90598f4d191fab43725", "d4ec110556065740a3469c894f48781ac673a13c46cd46bf8e75fe953f92fdff"],
      "skills/prompt-engineering/SKILL.md": ["9acdb598fcb0e559bf66ebb41e5c132d9f11bd9eb4af0b21085be98ff553a06b", "f6f48836e02c7940798a39f458a92d54836d6ce270e6f41db1d509a17970e46e"],
      "skills/prompt-engineering/classification.json": ["5b24ea34f89e9548362f42def75e286048c8b1d90920cafbebf439b76ffc087d", "df16346b0c5ad95902636b88287e8f67d80bdff8da40aeb9ed3a422ac079a589"],
      "skills/session-board/SKILL.md": ["f244a6238e7d5e65bcf2418e1f70b61a82372f9b045d3f53947181b1d614efb7", "b1c3965810498674df78fe6f7c60290bd83aef03d7f07cc9e4313920524005a4"],
      "skills/session-board/classification.json": ["3dfe3113ab8908d6b10a67f9e33e1805b7d06a91e58267311371d70509e575f5", "7df8a0d55377d9315899955ccae63d9623113517fdd49e91adb6201d2c25442e"],
      "skills/task-contract/SKILL.md": ["3978551c31daa62bc88893621ad05fd8f86a5e3e06df2b2b6a4d6d72721bfef2", "92b529e3423386cce32d3b2eb6302c42b6aba344624604d413fc0e90f86ef61b"],
      "skills/task-contract/classification.json": ["3a707ca184ba512bd016f5e5fcc10f033e28e51dec122889b98e9ccadaba1dda", "cabfe58da82a63612b826fd9637ca20418b0d061b8c978218309733baeaa1aac"],
    }),
  }),
  Object.freeze({
    revision: "4339cd0bc37a1cacc6151865a949697aaf4ec4f9",
    hashes: Object.freeze({
      "skills/orchestrator/classification.json": ["779ab8157b1fc358739858c122d39186f7828f9912ec89dc0c0f34435187b294", "f5d7143c822ca8bdea4afe5761a762c1844501645ba1db81d11c9423d8575983"],
      "skills/orchestrator/references/intake.md": ["8f0860a4efbd975887727b4e284d550af2f9ceb412f7f0a178cdb5f11967bff9", "1f43c151e74e25aeea37df534b048d2ca51b159a3c83e47ef07c9152256a9e49"],
    }),
  }),
  Object.freeze({
    revision: "7652c71037c07c4744b9d8f37f0a327d454d8c53",
    hashes: Object.freeze({
      "skills/orchestrator/classification.json": ["f5d7143c822ca8bdea4afe5761a762c1844501645ba1db81d11c9423d8575983", "16c5f554f7e727507ad7b60a9a13da5919bebb3f67039ea2b82d02d9f7ab47c7"],
      "skills/orchestrator/references/intake.md": ["1f43c151e74e25aeea37df534b048d2ca51b159a3c83e47ef07c9152256a9e49", "97e76065910f25aceaa895c7d24e70da7d3f30a8b32679870932ed22a9958c0c"],
      "skills/test-engineering/classification.json": ["3e603b14e5f27eb21506d03b33afab40b4cf1ce6cc070e0936b6690c745e636f", "b82827922ae2990887ed35b34e9c26c4668a367e05bc90dc5b5d46e9cecf036a"],
      "skills/test-engineering/SKILL.md": ["75e60228fe7307be776ed4925ea18a830f0e59d99a2d6a22715252731b37a3cc", "5dd09730e500965b8f64ef3cfde867b2231934dddbe0a454aa11c431a1723bd6"],
      "skills/orchestrator/references/engineering-practices/cli.md": ["c23134f4ebce972f891e7b7bf93f9ac24a5c340e856e3f1192e58fb33aff3b2b", "3d3199bd429e074903e6b99385c5c82677d0c6a4a5ffce696f745000db393b65"],
    }),
  }),
  Object.freeze({
    // Release ancestor r32 bytes; four CLI example comments leave all six selected clauses unchanged.
    revision: "d2ffc9af54cd1cb3f7a85061a3e7788287863654",
    hashes: Object.freeze({
      "skills/test-engineering/classification.json": ["b82827922ae2990887ed35b34e9c26c4668a367e05bc90dc5b5d46e9cecf036a", "1f0fd5742354b7d23d8656b34618786ff7502e08e4871595c08633df8c477d8c"],
      "skills/test-engineering/SKILL.md": ["5dd09730e500965b8f64ef3cfde867b2231934dddbe0a454aa11c431a1723bd6", "2541f44e4683adec7ca7037e088943bc01da17e6f6cca844be22a992d64a076b"],
    }),
  }),
  Object.freeze({
    // Canonical r33 ancestor; reviewed D32 intake shortening keeps historical budgets and oracles frozen.
    revision: "be0a71858068fce5696a11c902ae628512ac4ca9",
    hashes: Object.freeze({
      "skills/orchestrator/classification.json": ["16c5f554f7e727507ad7b60a9a13da5919bebb3f67039ea2b82d02d9f7ab47c7", "55b45c480970e43bc761fc48064bb69e384ec784e59d97e7105dce84852827a7"],
      "skills/orchestrator/references/intake.md": ["97e76065910f25aceaa895c7d24e70da7d3f30a8b32679870932ed22a9958c0c", "acc512bfe3a6ff383ce66d0a937a79017b4c568e59aaba1644e5a2420dd7c045"],
    }),
  }),
  Object.freeze({
    // Canonical r34 ancestor; D36 changes only the case-recording verb, preserving historical budgets and oracles.
    revision: "e96805c348f5a509a2185898ae517c21e45d3f49",
    hashes: Object.freeze({
      "skills/orchestrator/classification.json": ["55b45c480970e43bc761fc48064bb69e384ec784e59d97e7105dce84852827a7", "18dcd746b815d7e07d6948e2e7ed7fda064b4a2749a698f0a47b7efff657cfb1"],
      "skills/orchestrator/references/intake.md": ["acc512bfe3a6ff383ce66d0a937a79017b4c568e59aaba1644e5a2420dd7c045", "afad5fabebd6dbc31d0f4622727a16bfa5b62ccefafa5137454352eada38b7db"],
    }),
  }),
  Object.freeze({
    // Canonical r35 ancestor; r36 exposes shared case preparation without changing historical budgets or oracles.
    revision: "14a7278b396542db073e4a48314ab1cec182edf9",
    hashes: Object.freeze({
      "skills/orchestrator/classification.json": ["18dcd746b815d7e07d6948e2e7ed7fda064b4a2749a698f0a47b7efff657cfb1", "d49407e5fe8f6b2db407a52aedaddd90f3ba4d9ece5cc0fc2371982820647843"],
      "skills/orchestrator/references/intake.md": ["afad5fabebd6dbc31d0f4622727a16bfa5b62ccefafa5137454352eada38b7db", "1e1bddfaa4c294815a2ab2da4b071ecd2281a72c7b1e8f7bc72bb5ac585a6c71"],
    }),
  }),
  Object.freeze({
    // D38 required-reference wording keeps the r36 producer and every historical oracle frozen.
    revision: "1aed980a829d2328fffe96695d635c0fc058b29a",
    hashes: Object.freeze({
      "skills/independent-audit-gate/classification.json": ["9e5773f0b7eec9d9d8b4cf3ef5cc3d7eea00a737832c5a82a9d9394f130faeb3", "815aacf8b682844c54f8d1ddd14401aa422b169a3e890f607e4056ec1e0fe3ea"],
      "skills/task-contract/references/entry-details.md": ["401c494535eb2d62d0ec80810f1610c12071fcf5e3ed2c1cef23b23ba09440c2", "68fc79a16f61c7fa6b3a4409dee4f2ddccd6cb2a8bf5ea5739cec0575247313b"],
      "skills/independent-audit-gate/references/entry-details.md": ["61297d9377a5dc3ed9765f52bb5c96cea40fe7c2e8476ba8544540d99d015c84", "35b187b6351a72930ccc859fda06e416371ff60cb2c35832bce7ed2ee776d46a"],
      "skills/independent-audit-gate/references/audit-protocol.md": ["a34c9e5f9d82f5e0257614a119c05ac966bea04ee8fa374c88b010faea549dc4", "1d6e57296f14bdc0f99d2b7bcf02d5dfeb8becef8f268532a2204e0ddf0b2d3a"],
      "skills/independent-audit-gate/references/orchestrator-integration.md": ["3d14b4944f34c5e071cec027dcf483adf6fe5229e1a6ad17ea39202aa17d2fef", "ab82ba48be44d622dbed30412712ba4138e22e87f1bede5c82adb78b370782f0"],
    }),
  }),
  // 3.9.0 WP-F (AGS3-D-0032/0038/0042-0055) successor: start
  // Intake shortened and moved to its delivery paths, field-neutral targets and references; historical budgets and
  // oracles stay frozen because these exact bytes project onto the 3.8.0 release bytes at BASE.
  // The same 3.9.0 successor carries the AGS3-D-0038 reference wording (c90c78ca..e885dc90), the AGS3-D-0058
  // model-effort-advisor wording (6a313725), the AGS3-D-0062 direct-call section (8ff0fc37) and their span digests.
  Object.freeze({
    revision: "a50fbc2c20c20f52dd59643bb929b5b4c88d6f3a",
    hashes: Object.freeze({
      "skills/acceptance-evidence-validator/classification.json": ["4ce9af6edc26969b41c776135e591bc0674f5d366445207083baf73d2899aff7", "4667c120a88582c292863a36d4406e68d54f3e4eb2286082ad00d4cc1e03cd1c"],
      "skills/acceptance-evidence-validator/references/entry-details.md": ["34b8087c91fbd8b253e8753b62c5216c8a75d65dd40f0952b0929c87456d1a81", "aa2a6feb72601bb9f660c9e561fd5772d1e8c7e767b7c56c9e11655c47a8d343"],
      "skills/acceptance-evidence-validator/references/evidence-protocol.md": ["85105dae431ae773e6f845c1b206b5f8098a7a08402db3d7ad1842d03b5fe094", "82d197ab17abef4c94b59c3ef92186a3a0bdbfe865cd38bb4f94e0df7de0f9e2"],
      "skills/blocker-diagnostician/classification.json": ["84fefbfb294d72598f48b1c63832f7e3594bcec7caef899b1b0c595ddadabbce", "d406a448dc61ddfe51db6d715cee4c492e42a4204a77888bf0e3350a9c8ed762"],
      "skills/blocker-diagnostician/references/diagnosis-protocol.md": ["a57d43df0a69b58a952f985b53c454b8d91159eb6a77f1fd151986fcb76e7a0f", "bbf76b4453c82267d12e3910f3110b13f3d7518a8e6641bb3b25f920b950164f"],
      "skills/blocker-diagnostician/references/entry-details.md": ["ddcfe8425096b30f6c0d0f58900af39e7b8756e2594b35cd596601215ffa3a01", "97eba0cfb2b0ac8e8116c2f8c8e2adca5ae3982530c26c6f46bc103b13357da1"],
      "skills/coordinate-subagents/classification.json": ["c899d68736407ed7f351345eb620bc0167e15ae93a1c3aa0cf3b010ddd99ae5f", "1353938a8500fd23852ac71d64adcde2a9cd1275c22958823bf3d5c1dccc94af"],
      "skills/coordinate-subagents/references/delegation-playbook.md": ["55b9b7fe79d90096c3af3a8ad1fbdd71c7f58c96ceea88fed457595c525c03d0", "6aaa7414327ff93a36fc3732441c92ee8054ffdf7d6b4ecfa43f7b2a1b9022e8"],
      "skills/coordinate-subagents/references/entry-details.md": ["0bca6a11311aedec9bb7c9d4583092ff246452a664686a51041d0c90c6a5b404", "301054a8d9a4a6e254315fbcc8eef1068cbed627afccc4d2f1dfc8e6bb799e46"],
      "skills/coordinate-subagents/references/live-dispatch-check.md": ["873ee07aa7176464bb88e8bb402ce29e704308378d01c0fd36f68880dd5e74e4", "54cb457af763fc54507afae0667f80e3977cbb97ce03e936ee82c65cd76df5be"],
      "skills/coordinate-subagents/references/model-routing.md": ["92f50c1b7a3d9ac204baaa903f1a4589ad1c48cacb0f0cf2b4e7d14d13a7ac2e", "6db965eac7706480206d8558a83fd3d6cd4d1e83be5ef3800871d18491067b3d"],
      "skills/evaluation-validity-auditor/classification.json": ["9c3a46c657096918959313cf29ea86482a0d893e381f1b10348c482dee2ca01b", "53aa8cb62e1caf1972224de5d8b1cdc80e4e4687f3f0fec467f7db59371aabf7"],
      "skills/evaluation-validity-auditor/references/entry-details.md": ["3788c88d6522139cdbd18c34a2386b0706d0ecf3fe47f51824708c01e289b184", "80150164f5027060fc0bc0b6b38ebdfb3636d565677430fe56bf6452eee6506b"],
      "skills/independent-audit-gate/classification.json": ["815aacf8b682844c54f8d1ddd14401aa422b169a3e890f607e4056ec1e0fe3ea", "95dc4179c5f20b705957f236b377c5356cce183906fbaeb37745695a658e8332"],
      "skills/independent-audit-gate/references/audit-protocol.md": ["1d6e57296f14bdc0f99d2b7bcf02d5dfeb8becef8f268532a2204e0ddf0b2d3a", "f76af34c1f01d278550cdffc80b938ad76220668f16022ef687cbc18b63fff6c"],
      "skills/independent-audit-gate/references/entry-details.md": ["35b187b6351a72930ccc859fda06e416371ff60cb2c35832bce7ed2ee776d46a", "723250bab67020e2d5d35461266cb2d0bc6c579606748b7f952fa3e3e82d5b88"],
      "skills/independent-audit-gate/references/orchestrator-integration.md": ["ab82ba48be44d622dbed30412712ba4138e22e87f1bede5c82adb78b370782f0", "f44ddb31071f86b7c6974a2b1008c7ebe2131fbb4b35d8d39fa3a224039ac207"],
      "skills/independent-audit-gate/references/specialist-behavior.md": ["fc1107c28eac3dc9d2bb69442b695a4164c6d4d9980a237fc1967fe39a5ac50d", "812bceeae2dab14fc0928a282189c8e9bed6a02d29074aab47865d4a9a65b236"],
      "skills/independent-deliberation-panel/references/entry-details.md": ["6d8bf85e8701dedbd5a5e4e0304011e516c0f8e81369756bc1aa5b2ab858502e", "f7a944dd3d412ffd1efe44d0487f6ff8e1218cdf6211d6ad2951074c7e656642"],
      "skills/independent-deliberation-panel/references/evidence-and-verdict-schema.md": ["644fe1ead2962af0968ffa06fb248b55fb68d0ba15f229e9b9218e0696653336", "814ad622d94024f9a2e7b54cc90e353cae9102baf4806edb25269bb1c83ec234"],
      "skills/independent-deliberation-panel/references/integration-contract.md": ["39a8746dd1358baf81d1b7242810c970c8fcf98152a5b3155975f9e75019421f", "0d5b82187fadab3b20fc2c321cb9d03890ff8d561787625953ce9a1a68f0ba0f"],
      "skills/independent-deliberation-panel/references/orchestration-policy.md": ["ff72d35b11196ccb73e85fe73eda04caf26380f7c264fb800357c9f55c0b62c1", "07916ebd3d5c66f0f46fc66583226673d9a8ec62d055a46e48dae9f0e5138649"],
      "skills/independent-deliberation-panel/references/role-catalog.md": ["18d8d9b6c65bc6925c1dfe3cbce86055bbf44f274a1c406ab4be5cf7c7a6ada5", "68b346e02a3b192697dea12def59323172f7a21e8003b747484932833ba92152"],
      "skills/iteration-frame-auditor/classification.json": ["2b418a3da47aa4b07170cfb4b357a54a98a4b7747b3c9385b4158bddf948730f", "b8e50685024cbc3c9be4d37141ae377aa9aa383e1fcd511ddb59d029d04c7063"],
      "skills/iteration-frame-auditor/references/entry-details.md": ["e24b38f7ef5af28b09fb063df5438d98fa4e354dd165c00ebaae4463fe279432", "3e48e57f226faa44deaaaa72bd55d82c80598b29d92dc80087c091b4d2e4d35d"],
      "skills/iteration-frame-auditor/references/review-protocol.md": ["ff51d095ccb9a2ce3484c818986f03a37d5e6dd73d6c8af94f288cf751047658", "c839836656ff61e925297b7c6db9004a48a9616564d3e976ea4e97686047de2f"],
      "skills/model-effort-advisor/SKILL.md": ["3e47fe6b94f671e9b7e91dc57c074078e582556e056b2d66889ec61ea850453d", "5d554bb4fdb11ca9a2c833ff0a3403f23aaf28d5a9c459005a5222fb21cdd0ce"],
      "skills/model-effort-advisor/classification.json": ["fec98b3623b3f8984dcf780beb2f535eb9c22eb25953c44d38efbda8af6f4590", "0e9f097f63f79e27dde80b433eb469df1fbe1a6decbbba2ad39c973f3c52eb21"],
      "skills/model-effort-advisor/references/entry-details.md": ["3ac91a94b02ae8dc775702dfe611215106e2718bc1f3f922327655df34ef2b9d", "d73c768994f308913637771057c8a5f2459a24bbd868a926703c0d66d1a1af8b"],
      "skills/mutation-risk-preflight/SKILL.md": ["65647ea80f4d7546f76f8691def730b240ca2e8a892aeb69cfd10d855ff1f557", "f029843b9eb899e3aa47f732db76476ba557e7f5d4604db6229fd260ca8acbc1"],
      "skills/mutation-risk-preflight/classification.json": ["d4ec110556065740a3469c894f48781ac673a13c46cd46bf8e75fe953f92fdff", "57535b32573ddc20846c419ce6c40700436e2e5b162b6ec5bcb97a29f1d6902a"],
      "skills/mutation-risk-preflight/references/entry-details.md": ["027c08a08a559af62f945c00dab640e79deb88d6d9afe2042d1271d6ddd04f54", "05f835e73dbd23850c18bbb4753cae299d787fe3ad6c25c51a990826f9847855"],
      "skills/mutation-risk-preflight/references/recovery-requirements.md": ["eea0b3129263b17d12d7f05ecd823b6882ca35cc6211e5613431b429875e3842", "91bc05994088688a37a439b76b06b6427eae86a4734b5d6cd6ee1105418de55e"],
      "skills/orchestrator/classification.json": ["d49407e5fe8f6b2db407a52aedaddd90f3ba4d9ece5cc0fc2371982820647843", "1ecc972babc27508f73c0f449f51b031dcd4279196198966eb9800428e3b66ef"],
      "skills/orchestrator/references/collaboration.md": ["5f4aa4dedb3019a4c3f3515dd1fdfd03f78e136de0bded19c3b0ce46b99ce22a", "6099020a85f6ac170909163483d589e633318c4ee3df75854868b6c820e88402"],
      "skills/orchestrator/references/convergence-guard.md": ["ad162b606d35a84995b579902f523e1a0ff426b6988fddf93cf263141466aca5", "3081f282b5c458c807ef7a36251b42e0cfc16dfe6a8b6a64ce1c801e7f7d3b8c"],
      "skills/orchestrator/references/entry-details.md": ["bb5cc33814cf9e83a6255e40bc368937e40b7123990bc9507818cd9f906f8d85", "423e73afae8256f9834d149967aba3c818ef896597b08a3dd7c7fd67ae41cc20"],
      "skills/orchestrator/references/input-origin.md": ["d5375c58b657dfb35e07c465ab7220056c59af51330b24239448851463248927", "81ac4e225c2d4b50f525b90001afc95a5e2085c5c52023319597cc9d9aac034a"],
      "skills/orchestrator/references/intake.md": ["1e1bddfaa4c294815a2ab2da4b071ecd2281a72c7b1e8f7bc72bb5ac585a6c71", "7fca57e5d1538ecb0ccf9a2adc67a7494c35e9978eef0600b31e8751d40a319d"],
      "skills/orchestrator/references/mcp-execution.md": ["d32a61ac3c1da7017e2f1bcc312c6e412a32de7e7107b437b53fb80574444dd1", "1f515f4c853ad49495f72b179db699ead1ce34bd849c22a646a90180aa93f9f3"],
      "skills/orchestrator/references/skill-classification.md": ["ccf0c8829325f2874447c67993f2c04edb02ea462713de10f3733eabc892c6ac", "7bb370144a5aeb3f67b7920e4d0d9ac415020ca6bc69a4816f6d39aece07ad8a"],
      "skills/orchestrator/references/specialist-handoffs.md": ["9767d9d899acdd3fabf57d094c16bf64788dddf324a1bf001d6b970d285fecd9", "2c8b01c5bad7c58446ce42ca613f866fc6fa0a97665e6dac021735978938d455"],
      "skills/prompt-engineering/references/ags-boundaries.md": ["4d8f6e357d9d65c4723571e3ec1d14ca62f56365fb58c61b43b1cd0bf475c7df", "5f6dc08235b68e904c8d9624d28741d2bc4b4a18eed0d8903d21da59b8023807"],
      "skills/prompt-engineering/references/design-playbook.md": ["4b12f2d3c7a2a8e18dd08384aa6a1748c2396b82326219f5660e305f3eb4c163", "cf98a3499e19371d5cdb4f603a126de9fdb71418ebf47dfbbfbcdc30502d666e"],
      "skills/prompt-engineering/references/evaluation.md": ["43d7922227cfe4f2b119fb6b0de30e4ec940d3f7b7da8cf789a07dcbf6d01827", "48f176ccca6f5a9e8221cee57bb4398063a3f6bef69d7ff4bcee7fe0a55649b4"],
      "skills/prompt-engineering/references/output-contract.md": ["5ce53a4df15c966d626fbbe5d57bb0dd5a2e687e51b9ef1f3ffbced6b21366cb", "e9cad265f27720f13d400389fa478c94c6d4fd1eb03b6f709b23ba95f8ec5101"],
      "skills/prompt-engineering/references/provider-notes.md": ["cb64f823fda37e612fe25eab0cb0d8b2a332fc7e2fdeb196c080a57f585da6a7", "a5fede8f65728d5f8caff52f0c71bc49f967119a1ddf8e6c35c46350b7a195d9"],
      "skills/prompt-engineering/references/sources.md": ["3f3f7b5280b8648ae6fce77ad2fabf69be1f07aa506e7fb0fc91046fc148f93e", "766e4ff87327afe0f841ae93d6a3107a3fb62d62d079fa49d1b7b587c8f0acf6"],
      "skills/recovery-strategy-selector/classification.json": ["cbf6dda5aca35fe316599f673c0ab09f9915af931f0cc0c41e386cc8d473b7d4", "18879dd13ad1211d37bde3d4f8b24431e593947278cd0277f97d4c0c6500ada7"],
      "skills/recovery-strategy-selector/references/entry-details.md": ["5939abcfcf5412dc82ccf39571ee2e225723fa4be1956363a0b24b4e50cab48a", "27a03ac5e76c4d0ed75c2b7389ce10e7b1ae5bfa5b9219a32f8b8466aadc0b49"],
      "skills/session-board/classification.json": ["858968497e4d721fb34328db0ac67b3d27c19d97fe7bf9837b4ccfc4f6653e8a", "b5ba10e642f740e0b40acab750c0909a88bfc6de2bfe5b24388863cd6334d63c"],
      "skills/session-board/references/entry-details.md": ["4c0571608a124e96da1b27510a8c42775b3c84396c46abb11a915f57f103a196", "7120d21bac24b73f86222a213aaeb269d2603e6ab946a28f37a8856f991cf676"],
      "skills/task-contract/references/acceptance-criteria.md": ["55e07c6e2ea67a566f08644668b806b2ed50acca067f39969dd6f6738a9d37fe", "0876de396aa9e1b84cea25a4f84be3edd3d9f3e9a28344412991b5a017bbb9a1"],
      "skills/task-contract/references/field-guide.md": ["09083264f2f4746dcda5e9f342d0a0ec27ca21cb692965d036121dc882bc1ac7", "127ff992eb575496b18fd2457603dd1988c630b72da7612fd63c2a11e06e2f26"],
      "skills/task-contract/references/risk-and-authorization-rubric.md": ["cb68f324145df13772be3abd6429971afdf85f1385c53bb98e63e3c59c43a254", "0a1e9a349c3f815aff80ee21d2cddb8854490934459783caaedee42d078f69c8"],
      "skills/ui-ux-design/references/ags-boundaries.md": ["cd5f6b287aa418ffe60ad258b56313ee8c5ee3420ce351c3f221717536b6ae9f", "4f0dca70982e3a43760e05dcfc6e3f983800d06673c9beed0ac4af8d5044489d"],
      "skills/ui-ux-design/references/design-workflow.md": ["b117ce1dadc278a8a213560115c54795a3a2ffd12d26736037021bfa4ddfa2fd", "1b83751e365fe409e2614c61ef695fc7ecd8a2d1a0589e1c8aee68dd620090b2"],
      "skills/ui-ux-design/references/output-contract.md": ["c8f4d41577a6c3078b161c47fdde520be6e913315762d284cdbbeac1474ffeee", "074039649403d5f3e735dc0be3b6ae395e6c3221eab96f692153da67d06fe65d"],
      "skills/ui-ux-design/references/sources.md": ["6f7bded1b18cf47b89092fe18cc005bd23befb3df40527c73f72161bae2b842d", "05b52f392b8d6168702c7ae5db81684c4da3005b9b92c7f91311e30803240522"],
      "skills/ui-ux-design/references/verification.md": ["703b4a1ebebb9c0b355e1db13484953b2dac87f518915469a4da9fbe0d8d46ac", "d9fe565ef5a969cdfb3fe79f48caf4f255c15baeeaeb84d5b2a5a2dcc58976ae"],
    }),
  }),
  // 3.9.0 WP-F successor: end
  // 3.9.1: the JEV budget is the person's limit; the server no longer caps it at 5 USD.
  Object.freeze({
    revision: "ca6ac8b41dc12a34ef381db021eaaa9b447573ff",
    hashes: Object.freeze({
      "skills/orchestrator/references/skill-classification.md": ["7bb370144a5aeb3f67b7920e4d0d9ac415020ca6bc69a4816f6d39aece07ad8a", "e0ed92eeab8977f4bb8189ff517ad4e4b44e020c38f4aae1c177cc87c2971439"],
    }),
  }),
  // 4.0.0: the MCP server manages JEV from the admin page's signed settings; no qualification gate, opt-in fallback.
  Object.freeze({
    revision: "8104ce977f06a17bb1e938117c09460bf4070f19",
    hashes: Object.freeze({
      "skills/orchestrator/references/skill-classification.md": ["e0ed92eeab8977f4bb8189ff517ad4e4b44e020c38f4aae1c177cc87c2971439", "2316ceffe343e2e65a67f3976dfee81f9279ed33167454b2473e7ef23aca37e4"],
    }),
  }),
]);
// 3.9.0 (AGS3-D-0007, AGS3-D-0018): core owns these former skill files. A removal is allowed only while the skill
// path is absent and core holds the file, so a copy left in the skill or a lost core file is still reported.
const MOVED_TO_CORE = Object.freeze({
  "skills/coordinate-subagents/references/model-routing-presets.json": "runtime/model-routing-presets.json",
  "skills/korean-prose-editor/resources/glossary.seed.jsonl": "runtime/korean-prose-glossary/glossary.seed.jsonl",
  "skills/korean-prose-editor/resources/korean-prose-glossary.sqlite3": "runtime/korean-prose-glossary/korean-prose-glossary.sqlite3",
});
function movedToCore(relative) {
  if (!Object.hasOwn(MOVED_TO_CORE, relative)) return false;
  const present = path => { try { readFileBytes(join(ROOT, path)); return true; } catch (error) { if (error?.code !== "ENOENT") throw error; return false; } };
  return !present(relative) && present(MOVED_TO_CORE[relative]);
}
const guidanceSuccessor = relative => GUIDANCE_SUCCESSORS.find(successor => Object.hasOwn(successor.hashes, relative));
// Reviewed new context files: a file that had no predecessor is allowed only while it holds these exact bytes, or
// reviewed successor bytes that project onto them.
// - 3.8.0 (AGS3-D-0032): the shared intake block, moved without a byte change from skills/orchestrator/SKILL.md at
//   bdcb0792 (its lines 15-31), so invoking the orchestrator skill does not load it a second time.
const GUIDANCE_ADDITIONS = Object.freeze({
  "skills/orchestrator/references/intake.md": "77b5496ce490207317d016d2ca9f6a467dbd85bcfc39df86c561dec8d5a685b1",
});
/** True only for a reviewed addition that holds its exact reviewed bytes (a reviewed guidance successor reads as them). */
function isReviewedGuidanceAddition(relative) {
  if (!Object.hasOwn(GUIDANCE_ADDITIONS, relative)) return false;
  let bytes;
  try { bytes = readFileSync(join(ROOT, ...relative.split("/"))); } catch { return false; }
  return createHash("sha256").update(bytes).digest("hex") === GUIDANCE_ADDITIONS[relative];
}

// Retired skills. context-continuity is no longer a skill: continuity is the MCP tools checkpoint_context,
// inspect_context, load_context, suppress_context_restore and purge_direct_context plus the hooks. The tree holds none
// of these paths; every pinned check reads each one at `revision` with its exact digest. A path that reappears in the
// tree, a file missing from these pins or altered history fails.
const RETIRED_SKILLS = Object.freeze({
  revision: "e6e313864a4fe1be15ac2b199fb56284dbc327a9",
  skillIds: Object.freeze(["context-continuity"]),
  hashes: Object.freeze({
    "skills/context-continuity/SKILL.md": "338dec78ba593585a046887c411a3aacd3c12c4d601e052ef71f912593266330",
    "skills/context-continuity/agents/openai.yaml": "fbeeced183253cf5cc7bf1dd02b21a5089333e221b3f1700c74d42f567d91224",
    "skills/context-continuity/classification.json": "ca054eefa1fdbfbd7bf47e4652f6fc58a9c35010612e7772e233dc2d8d59c049",
    "skills/context-continuity/references/entry-details.md": "1f2a60899a145e349d37db84b8de7c8635fec8634036b09a8516d5895e5b4eca",
  }),
});

// Explicit removal requested by the user. Keep the older retirement and optimization pins unchanged.
// Executable source is absent too, but its history is outside this context-only evaluation.
const RETIRED_TOKEN_ANALYZER = Object.freeze({
  revision: "14549a2e83fd9143cf8184bd71979db23fd43172",
  skillIds: Object.freeze(["codex-token-usage-analyzer"]),
  hashes: Object.freeze({
    "skills/codex-token-usage-analyzer/LICENSE": "849a4e8cf657531b138680d6dbdad4466622b4fcd79de703bce7dd8208820c02",
    "skills/codex-token-usage-analyzer/SKILL.md": "0de104afb13d2095c585ec64ca8a326dc8392f03749c70f0a21affab5e060e18",
    "skills/codex-token-usage-analyzer/agents/openai.yaml": "c1fada1a8914ac00faafd91ebd3bf798c225ff402ce870b1b8150ba77b28a5b8",
    "skills/codex-token-usage-analyzer/classification.json": "b9c2eca1a447e64000e57a8c25cd1faa279ad9487c6250b8fb44a15edba39082",
    "skills/codex-token-usage-analyzer/contracts/token-usage-report-request.v1.schema.json": "e9d418c702b8f764e515a925f5511d6203c37d13d23c130e3b9df86472a838b4",
    "skills/codex-token-usage-analyzer/contracts/token-usage-report.v1.schema.json": "0a3306633ed0c192e6bfc3b269df0b35b4e2a72492c5fc1cd7dad7f5f0d37612",
    "skills/codex-token-usage-analyzer/integration/provider-result.v1.schema.json": "0e8cc867092b27a8336acab857c32afada525ee06c4aa2f13ba0f1c981015d9f",
    "skills/codex-token-usage-analyzer/integration/skill-descriptor.json": "e2364fee9ef778fdf66bbffb8bb5cb666b65aafb64be1d73b1b9561b381efa72",
    "skills/codex-token-usage-analyzer/references/entry-details.md": "969fe68d7a60c1f16d84c04df9c9cdb691146b774390d39e7a6b030541c109af",
  }),
  removedExecutables: Object.freeze([
    "skills/codex-token-usage-analyzer/scripts/cli.mjs",
    "skills/codex-token-usage-analyzer/scripts/core.mjs",
    "skills/codex-token-usage-analyzer/scripts/schema-validation.mjs",
  ]),
});
const RETIREMENTS = Object.freeze([RETIRED_SKILLS, RETIRED_TOKEN_ANALYZER]);
const retiredPaths = retirement => [...Object.keys(retirement.hashes), ...(retirement.removedExecutables ?? [])];
const retirementFor = relative => RETIREMENTS.find(retirement => retiredPaths(retirement).includes(relative));

// This is an approved purpose change, not a semantics-preserving optimization successor.
// Exact live sources are checked separately. Only the old evaluation reads their pinned predecessors.
const PURPOSE_CHANGE_SUCCESSOR = Object.freeze({
  revision: "subagent-model-selection-2026-11-07",
  baselineRevision: "14549a2e83fd9143cf8184bd71979db23fd43172",
  changeKind: "user-requested-purpose-change",
  historicalEvaluationScope: "predecessor-only",
  modelBehaviorValidated: false,
  authorityEffect: "none",
  hashes: Object.freeze({
    "skills/coordinate-subagents/classification.json": Object.freeze(["bd2fd05d3e93cd4f4b08af021a0fa77ef3787b57550e17f75fbbe3ecdd629957", "c899d68736407ed7f351345eb620bc0167e15ae93a1c3aa0cf3b010ddd99ae5f"]),
    "skills/coordinate-subagents/SKILL.md": Object.freeze(["9dfea8d94be467700ea4e8dac86a21040b57c1161ff46ddc0cf63cef97e305e7", "f5acb926234feda269ec7f0c5faa444fe31cc5f257ba854c505cd37fa4efe881"]),
    "skills/coordinate-subagents/references/entry-details.md": Object.freeze(["266ceb4fb5d7d3c553ef85485c93ac87c4df1bf0df5e2219fd99cc9a146bf882", "0bca6a11311aedec9bb7c9d4583092ff246452a664686a51041d0c90c6a5b404"]),
    "skills/coordinate-subagents/references/model-routing.md": Object.freeze(["49b0e564b80a52475670e850c8272f0c348626ef5d32e4746fd484a262023fe5", "92f50c1b7a3d9ac204baaa903f1a4589ad1c48cacb0f0cf2b4e7d14d13a7ac2e"]),
    "skills/model-effort-advisor/SKILL.md": Object.freeze(["f1142996644991ca8d444a4e4004aa8650f4c00a8d9e9e0eecd5d7672b773595", "3e47fe6b94f671e9b7e91dc57c074078e582556e056b2d66889ec61ea850453d"]),
    "skills/model-effort-advisor/agents/openai.yaml": Object.freeze(["64b36b7840823a5e389a97689c7e5baa3f598faa2ebec720b1d96271f07681fa", "a8cce4b59156031226c66091266badedade8eb0dd311293cc589b56334ca2226"]),
    "skills/model-effort-advisor/classification.json": Object.freeze(["2794ab01288c3d531c49b31704ba565bb554b64fb59369946c39237237038faf", "fec98b3623b3f8984dcf780beb2f535eb9c22eb25953c44d38efbda8af6f4590"]),
    "skills/model-effort-advisor/references/entry-details.md": Object.freeze(["4fd8153834b5ab19ea12af67634e5ac8b06a5645f7cafc62c9fca2289d18368f", "3ac91a94b02ae8dc775702dfe611215106e2718bc1f3f922327655df34ef2b9d"]),
    "skills/orchestrator/references/entry-details.md": Object.freeze(["abce8a5addf52b66c361561000a0f0db5c31f93fff9ad09a9fc8c2cc02988e41", "bb5cc33814cf9e83a6255e40bc368937e40b7123990bc9507818cd9f906f8d85"]),
  }),
  additions: Object.freeze({
    "skills/model-effort-advisor/contracts/subagent-model-advice.v1.schema.json": "ab29e4885268bd43f7a1e49d8ea0cd4c306349b8176664ac443d3f54ca3a14fe",
    "skills/model-effort-advisor/contracts/subagent-model-request.v1.schema.json": "49f78a3a6fb204dfcd6ca5b4000a62e731b28b7605370567d5f409f320b4a081",
    "skills/model-effort-advisor/scripts/advise.d.mts": "32ee9c299181ec2d39d25649ef2958875c04842322939090c68318fb05541232",
  }),
  registryDescriptorSha256: "e7e00299584b37bfde8655b3a127593bc683e4b8fdf524fbd0293e162ac49c59",
});

function purposePredecessor(relative) {
  const expected = PURPOSE_CHANGE_SUCCESSOR.hashes[relative][0];
  const bytes = git("show", `${PURPOSE_CHANGE_SUCCESSOR.baselineRevision}:${relative}`);
  if (contextDigest(bytes) !== expected) throw new Error(`Purpose change predecessor bytes differ: ${relative}`);
  return bytes;
}

function matchesPurposeChange(relative, bytes) {
  const expected = PURPOSE_CHANGE_SUCCESSOR.hashes[relative]?.[1] ?? PURPOSE_CHANGE_SUCCESSOR.additions[relative];
  return expected !== undefined && contextDigest(bytes) === expected;
}

function beforePurposeChange(relative, bytes) {
  return Object.hasOwn(PURPOSE_CHANGE_SUCCESSOR.hashes, relative) && matchesPurposeChange(relative, bytes)
    ? purposePredecessor(relative) : bytes;
}

export function checkPurposeChangeSources() {
  const errors = [];
  for (const relative of [...Object.keys(PURPOSE_CHANGE_SUCCESSOR.hashes), ...Object.keys(PURPOSE_CHANGE_SUCCESSOR.additions)]) {
    let bytes;
    // A later reviewed guidance successor stands for the exact purpose-change bytes it replaced.
    try { bytes = beforeMultiWorkflowGuidance(relative, readFileBytes(join(ROOT, relative))); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      errors.push(`purpose change source missing: ${relative}`); continue;
    }
    if (!matchesPurposeChange(relative, bytes)) errors.push(`purpose change source bytes differ: ${relative}`);
    if (Object.hasOwn(PURPOSE_CHANGE_SUCCESSOR.hashes, relative)) purposePredecessor(relative);
  }
  return { ...PURPOSE_CHANGE_SUCCESSOR, validationScope: "exact-live-context-and-separate-historical-replay", pass: errors.length === 0, errors };
}

/** The exact bytes a retired path had at its retirement revision. */
function retiredBytes(relative) {
  const retirement = retirementFor(relative);
  const bytes = git("show", `${retirement.revision}:${relative}`);
  if (createHash("sha256").update(bytes).digest("hex") !== retirement.hashes[relative]) throw new Error(`Retired skill history differs: ${relative}`);
  return bytes;
}

/** Tree bytes; a missing retired path reads as its retirement bytes, any other missing path still throws. */
function readTracked(path, relative) {
  try { return readFileBytes(path); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (!retirementFor(relative)?.hashes[relative]) throw error;
    return retiredBytes(relative);
  }
}

/** Skill directory names as the pinned checks see them: the tree's directories plus the retired skills. */
function skillDirectoryNames() {
  const present = readdirSync(join(ROOT, "skills"), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  return [...new Set([...present, ...RETIREMENTS.flatMap(retirement => retirement.skillIds)])];
}

/** Project only exact purpose-change bytes or an explicitly removed path onto its predecessor's change list. */
function projectRetiredChanges(base, paths) {
  return paths.filter(relative => {
    if (Object.hasOwn(PURPOSE_CHANGE_SUCCESSOR.hashes, relative) || Object.hasOwn(PURPOSE_CHANGE_SUCCESSOR.additions, relative)) {
      try {
        if (matchesPurposeChange(relative, beforeMultiWorkflowGuidance(relative, readFileBytes(join(ROOT, relative))))) return changedBetween(base, PURPOSE_CHANGE_SUCCESSOR.baselineRevision, relative);
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    const retirement = retirementFor(relative);
    if (!retirement) return true;
    try { readFileBytes(join(ROOT, relative)); return true; }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    return changedBetween(base, retirement.revision, relative);
  });
}

/** A retired skill stays out of the tree and the index, and its pins cover exactly its files at the retirement revision. */
function checkRetiredSkills() {
  const errors = [];
  const present = new Set(readdirSync(join(ROOT, "skills"), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name));
  for (const retirement of RETIREMENTS) {
    const scopes = retirement.skillIds.map(skillId => `skills/${skillId}`);
    for (const skillId of retirement.skillIds) if (present.has(skillId)) errors.push(`retired skill directory present: skills/${skillId}`);
    for (const relative of retiredPaths(retirement)) {
      try { readFileBytes(join(ROOT, relative)); errors.push(`retired skill source present: ${relative}`); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (Object.hasOwn(retirement.hashes, relative)) retiredBytes(relative);
    }
    const tracked = git("ls-files", "--", ...scopes).toString("utf8").trim().split(/\r?\n/u).filter(Boolean);
    if (tracked.length) errors.push(`retired skill paths still tracked: ${tracked.join(", ")}`);
    const historical = git("ls-tree", "-r", "--name-only", retirement.revision, "--", ...scopes).toString("utf8").trim().split(/\r?\n/u).filter(Boolean);
    if (!sameSet(historical, retiredPaths(retirement))) errors.push("retired skill pins differ from its files at the retirement revision");
  }
  return errors;
}

/** A reviewed guidance successor stands for its exact predecessor; any other bytes are returned as they are. */
function beforeMultiWorkflowGuidance(relative, bytes) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  const successor = GUIDANCE_SUCCESSORS.find(entry => Object.hasOwn(entry.hashes, relative) && entry.hashes[relative][1] === digest);
  if (!successor) return bytes;
  const projected = git("show", `${successor.revision}:${relative}`);
  if (createHash("sha256").update(projected).digest("hex") !== successor.hashes[relative][0]) throw new Error(`Guidance successor predecessor bytes differ: ${relative}`);
  return beforeMultiWorkflowGuidance(relative, projected);
}

/**
 * Projects exact reviewed successors onto their predecessors until none applies. A guidance successor can follow the
 * purpose change (3.9.0 rewords model-effort-advisor and coordinate-subagents after it), so neither order is fixed.
 */
function beforeReviewedSuccessors(relative, bytes) {
  for (;;) {
    const projected = beforeMultiWorkflowGuidance(relative, beforePurposeChange(relative, bytes));
    // A read may hand text instead of a Buffer (an injected fs); compare the bytes either way.
    if (Buffer.from(projected).equals(Buffer.from(bytes))) return projected;
    bytes = projected;
  }
}

/** Test hook: the exact predecessor a reviewed guidance successor stands for; any other bytes are returned as they are. */
export function beforeGuidanceSuccessor(relative, bytes) {
  return beforeMultiWorkflowGuidance(relative, bytes);
}

/** Reads a file as the pinned checks see it: a reviewed guidance successor reads as its exact predecessor. */
function readFileSync(path, encoding) {
  const relative = relativePath(ROOT, String(path)).replaceAll("\\", "/");
  const projected = beforeReviewedSuccessors(relative, readTracked(path, relative));
  return encoding ? projected.toString(typeof encoding === "string" ? encoding : encoding.encoding) : projected;
}
const BASELINE = "7bc7753012227938be2a46f68bf3e29d29d5ef34";
// Context-only successor. Current source checks require the exact after bytes;
// historical checks project them onto this separately verified predecessor.
// These pins issue no execution authority and do not evaluate model behavior.
const SPECIALIST_BEHAVIOR_SUCCESSOR = Object.freeze({
  revision: "specialist-behavior-2026-11-03-r01",
  baselineRevision: "480b8dfc143d15c7fb9fdab349d698d75f009893",
  scope: "skill-context-only",
  authorityEffect: "none",
  skillIds: Object.freeze([
    "acceptance-evidence-validator", "blocker-diagnostician", "change-scope-guardian",
    "code-review", "codex-token-usage-analyzer", "context-continuity", "coordinate-subagents",
    "cs-engineering", "evaluation-validity-auditor", "independent-audit-gate",
    "independent-deliberation-panel", "instruction-scope-resolver", "iteration-frame-auditor",
    "korean-prose-editor", "model-effort-advisor", "mutation-risk-preflight", "orchestrator",
    "ponytail", "prompt-engineering", "recovery-strategy-selector", "session-board",
    "software-security-auditor", "solid-design", "task-contract", "test-engineering",
    "workspace-convention-profiler",
  ]),
  // Exact candidate context bytes; historical pins above/below stay unchanged.
  hashes: Object.freeze({
    "skills/acceptance-evidence-validator/SKILL.md": Object.freeze(["934cc5ef2e5d187c31e2eef086c61ff03b5e76cec50bf82be648eda87e228fda", "24cee8ff520bcd394af0b3d3aa9d28d8147838191660373b3ce9f3fbd8e8d02f"]),
    "skills/acceptance-evidence-validator/classification.json": Object.freeze(["1fd5e0c18593382cd7114cd110f073fd3a6ee1520e4740f790e6916ec0e34c8a", "99894b6b18ab993c8a9b375961e1f303b77337548358bec3a15058ea79529949"]),
    "skills/acceptance-evidence-validator/references/evidence-protocol.md": Object.freeze(["229d6f16a1b560b8482d3283f5a46f74f86a405d47c0bdf592d18f3f3e3897d0", "f34164f4fec2dd2ee896a26dd8fbe5bbb9a07ed63a24a9c9593d35ee8ba40031"]),
    "skills/blocker-diagnostician/SKILL.md": Object.freeze(["0b2ed15e57c2c344661a3ae64073181d6f7b8940b7ef4e315daf010629c7f0de", "45a4607b88363a062ea0fe30298dbd45c27912d2227bb34e3bb392a0fd54af2f"]),
    "skills/blocker-diagnostician/classification.json": Object.freeze(["3c18e212dfa724027c245ec1692cd39addd12e762cc635f3cb9c5cf09dc73eec", "7cc63979194e79cd4a7889b5e25203cd03144f2290510b866ec38c1eb0efa0fb"]),
    "skills/blocker-diagnostician/references/diagnosis-protocol.md": Object.freeze(["4d7d9e47a2549d2af39565646aa8ce8e7da3c52006367cafb7fc34d243749610", "a57d43df0a69b58a952f985b53c454b8d91159eb6a77f1fd151986fcb76e7a0f"]),
    "skills/change-scope-guardian/SKILL.md": Object.freeze(["4628178a929e8be1da1f36e7cdc553b7fc6a5ed932ad3f30f5bdc075228ca60e", "c40977808a57ee10e97c4945caa8f5f9363140e745f2dbac002ece68cba6d7ca"]),
    "skills/change-scope-guardian/classification.json": Object.freeze(["52103f0dde99c31e42dd548e6234a5198d9a1a5b7d639087dd54a52ae304ff0f", "e42a9918e6bc6990352b532e24f905726516aa77922c23a143845c74e1eb7542"]),
    "skills/code-review/SKILL.md": Object.freeze(["19825762e948103a2ebc1adebd4afef9912370c670bf7b8590470d8893c66ebd", "e452e63ee1047d5162b348f16fa86a8c2464d054469ba7e1144960ef018cf2a6"]),
    "skills/code-review/classification.json": Object.freeze(["d4253d69e8ebf8f384f5e5a93e375f128546e06a72c54220eea0c28f99521ac4", "7119963aff673aa5d95247ec90d77be9ebddf2ae64b9aba353e30a488a6b1510"]),
    "skills/codex-token-usage-analyzer/SKILL.md": Object.freeze(["81e119d5c8ef11d8f2c928f8c3c9d518941643ae9c88c03cdb8a6ece09f80f1f", "0de104afb13d2095c585ec64ca8a326dc8392f03749c70f0a21affab5e060e18"]),
    "skills/codex-token-usage-analyzer/classification.json": Object.freeze(["1f52246a9a1e8cd22c811d6ed26409910a7d844f4d4f67ca5d639f00d2ca03d3", "b9c2eca1a447e64000e57a8c25cd1faa279ad9487c6250b8fb44a15edba39082"]),
    "skills/codex-token-usage-analyzer/references/entry-details.md": Object.freeze(["95d3acae36c832218dcaa0d31fbbc1c89b572ba013dff2ab07525910601ac5d4", "969fe68d7a60c1f16d84c04df9c9cdb691146b774390d39e7a6b030541c109af"]),
    "skills/context-continuity/SKILL.md": Object.freeze(["99e064693b3f0003f3b391f81f5173b79a28060e7f46ec81081923e75e646f41", "338dec78ba593585a046887c411a3aacd3c12c4d601e052ef71f912593266330"]),
    "skills/context-continuity/classification.json": Object.freeze(["86988758d42dae54f6379a1cf3a3f1e7053dc7510727e2da43a58b3c1f47ee87", "ca054eefa1fdbfbd7bf47e4652f6fc58a9c35010612e7772e233dc2d8d59c049"]),
    "skills/context-continuity/references/entry-details.md": Object.freeze(["3089f69c1a8738e63537ddfbbad0f757fd3d269248c47a42d694d77a7b62e660", "1f2a60899a145e349d37db84b8de7c8635fec8634036b09a8516d5895e5b4eca"]),
    "skills/coordinate-subagents/SKILL.md": Object.freeze(["6ba85d995e098afe3cdeb8d20a0b130d383447a5ac6d1781c87e6b52461a7e2e", "2083c3a6ac114a34fea4014d6dda913e78670347cae9685e894fd7a0473aea8f"]),
    "skills/coordinate-subagents/classification.json": Object.freeze(["dacd0c4e2c57c8766a261f7235331055537a9344a9fe09528611810070ea994b", "9ee93e2b274e672d3f5d707d1236e74928a814de787ff7d2bac33f84c49381e6"]),
    "skills/coordinate-subagents/references/delegation-playbook.md": Object.freeze(["3215b5e38f7881ddaa5e8262de280642c3560a4236f38e15b3a6fabc176d80aa", "55b9b7fe79d90096c3af3a8ad1fbdd71c7f58c96ceea88fed457595c525c03d0"]),
    "skills/coordinate-subagents/references/entry-details.md": Object.freeze(["2ace1181d7483e37ecd63e5b80c768ce376504ed9982142f0b519c76a08814df", "4f29865da0ca78b114e038120d0a3165e5d22d339d0a81b9e11c1c1ce726577a"]),
    "skills/cs-engineering/SKILL.md": Object.freeze(["435939d54f74626d07cbfbedd87fcb1a8e13338bc6c0e46d5233d80a7733d681", "624d0365164ef23d9e2d5e749e9cd9309cd92b2335767abd7df95f29ec977f51"]),
    "skills/cs-engineering/classification.json": Object.freeze(["9656b3af5a26f9fb4b5e7e0104d429889a7669e683a61a541b07b88d0d5cf610", "8eb3ed74d4d88977b9392a786f7ca23b3917ded3f584c377397b4a333a1003da"]),
    "skills/evaluation-validity-auditor/SKILL.md": Object.freeze(["eba09d8fd9d7ae08a58cf0ae640041beb1ac084b97fadbfc1af89efe0fd74230", "de0f1e1f294fdf0ec84844375816918f23431dddf92f43c2a18bbdf5ab3ba53d"]),
    "skills/evaluation-validity-auditor/classification.json": Object.freeze(["46b94a039e643a333f021f4792f92edb3b19263e47206c1f1b75e1afcbbbb9df", "9c3a46c657096918959313cf29ea86482a0d893e381f1b10348c482dee2ca01b"]),
    "skills/independent-audit-gate/SKILL.md": Object.freeze(["abb5d4c1fa0607851018cd6f6a2f3ecf314cc829149ea0d15c5474ed9afd2a18", "601e00c54a44ec31f472c4cc447441c9a8167769f8721d349591b47feeb92aab"]),
    "skills/independent-audit-gate/classification.json": Object.freeze(["6295cdc92ab7f3fa381023f7d7e363115f212f5dc128d02e90f518ad39142f10", "2d6752feb9ec2751e166e33b7e3f1b2c6b3c977a4e7332362c60a4306d17bda9"]),
    "skills/independent-audit-gate/references/entry-details.md": Object.freeze(["0c390f9b8ccb7a3ef01f77dea4f92cec25d785e28b917e7305f76fdb42f05af9", "61297d9377a5dc3ed9765f52bb5c96cea40fe7c2e8476ba8544540d99d015c84"]),
    "skills/independent-deliberation-panel/SKILL.md": Object.freeze(["eb21677b0f377116250691a8cf84b44ec853c4de9c56e27ea17585016a151f54", "9af2cea03f08d3494ca4f5cd0c857e88def422ec7bef58238873243c8e15caf9"]),
    "skills/independent-deliberation-panel/classification.json": Object.freeze(["71ecafe2dc7eab91bb7ee5ebac230f2b0d3a7e58b9ff15c8cfdc3517a0aa21fd", "0670008787912ad6e46c79ea8bc33e21726a14a23d0ee43069306bf11158bd03"]),
    "skills/independent-deliberation-panel/references/entry-details.md": Object.freeze(["f7fcfd9206f63c282a51c01446250dfc97eb7c65e576c00131030d1e0e2dbd65", "6d8bf85e8701dedbd5a5e4e0304011e516c0f8e81369756bc1aa5b2ab858502e"]),
    "skills/instruction-scope-resolver/SKILL.md": Object.freeze(["5884f45b804b2b50dbfd060e73f2412940fa4e23b66b28eb256a71af4111d0cb", "9873f1f03764a68e4f8c123510287308e229c156bdf5ed9fe5eec5306d729b8b"]),
    "skills/instruction-scope-resolver/classification.json": Object.freeze(["260ffec71166aa7a6403d78f98b3a2e41bac4f0eebc66ce242ac7d0618c453dc", "eeed71b8551ec9fda0ed5aec40afa54de2e63b2c58a6bc1a9fe27d26673655a5"]),
    "skills/instruction-scope-resolver/references/entry-details.md": Object.freeze(["f40835131e257fff01e5913ae979d55af4546ed503e925e74dad716b432f90c3", "b2232aeb5f30d7efcb222fb7c4ea8a6106e1515a03a766839e0ac7f480c50116"]),
    "skills/iteration-frame-auditor/SKILL.md": Object.freeze(["e83cf0abff280adfca9f12c35afd67e3787c75ce4e7866f7d1e402f59211945f", "b7ac836ba1d362d85450a62ffd3470fc21652389caa600b1bafdd52245ce4162"]),
    "skills/iteration-frame-auditor/classification.json": Object.freeze(["bfe14a5aa19ba5711963f4b93abce34e44ac4809bcb16c1f5fe7f8ce7dce5a59", "253a1f8029ef051f0f3812b416705c26575562a991dae5f07350fbe0dc2f31f1"]),
    "skills/iteration-frame-auditor/references/review-protocol.md": Object.freeze(["1abfd6a06a67d11277e24db17ee2e9fe8c2597e37304202378f782b959472793", "c65692186d03c13973cd56bed09ce5f7f263038acc0de1b1720cb3499e1906a7"]),
    "skills/korean-prose-editor/SKILL.md": Object.freeze(["f8e43316850730a78febb8e440e81421a81f9549b08f064f0316e0493fcd9ae7", "79e2d73edeab4edfe39d5b3663a67990aeeee47fcd65fbee8dcf176457cd9a25"]),
    "skills/korean-prose-editor/classification.json": Object.freeze(["8f49189dcf8106d2f242a186b8ebf46238ae5ed54101e43e7860dc7eedfe0ceb", "0ed8b69e72dc6b156de412743084e7600a84d466f9d113cdc4c792608d768701"]),
    "skills/korean-prose-editor/references/entry-details.md": Object.freeze(["26ce188795767864370bbd07ae06ba5e164ff802b301656daa3759626996a9a1", "35986d36d80f376f655f8feb933efb533ffa8542d64dc4f2b6c4c52b38fa264b"]),
    "skills/model-effort-advisor/SKILL.md": Object.freeze(["fa84d128bf1d9a6742b74f13080db98f304803e84168b8de39a9e120a01a9a6a", "f1142996644991ca8d444a4e4004aa8650f4c00a8d9e9e0eecd5d7672b773595"]),
    "skills/model-effort-advisor/classification.json": Object.freeze(["9dee08d541f2a0dae21352cbbd4d1e8c3cbf7cdaefcf7db94bf0cf8598f17518", "2794ab01288c3d531c49b31704ba565bb554b64fb59369946c39237237038faf"]),
    "skills/model-effort-advisor/references/entry-details.md": Object.freeze(["806874cf4ff417e5e5416a48df8f373ba7483591dbc916ce5edb3868280255de", "4fd8153834b5ab19ea12af67634e5ac8b06a5645f7cafc62c9fca2289d18368f"]),
    "skills/mutation-risk-preflight/SKILL.md": Object.freeze(["f3975e529669c17acd83a951b816aa57efa7c8fef469130726200b057e131188", "00b8848c38e5eb3f8175f70b8c615d663b2a036a751603266502e3dbd48522ad"]),
    "skills/mutation-risk-preflight/classification.json": Object.freeze(["257f8f3affdc01511c44052de26e0c7e65076f61663ebce0d7871ca9550ce25e", "045eb47dcd98736fdd763f06535d8d8b9c95aa9f5000fb7677d39548641eec3a"]),
    "skills/orchestrator/SKILL.md": Object.freeze(["e9be18c4d7f14a8aca9a3ce521501e6a673626a96d5bb07735f562e11c153001", "02b979178d585cd3396865a86703c4a1102263ff52c8c9739163ea763a03ce25"]),
    "skills/orchestrator/classification.json": Object.freeze(["52d8d444e8c8fdadd4786d730191b37c6430c97993dcb93e447cccb5c69dfe02", "fb1741dda17b431dd0a8c02935ba0a0b6f72989846ebc7df3761ef01ec04c487"]),
    "skills/orchestrator/references/entry-details.md": Object.freeze(["86af016cfc8399a656181f5253189c098b53434aaa8b7d4fd1353d586248333f", "d9bf7de0283d671735e7c4f4e9994df12a0d24bd6f3be97182394c5c247016ab"]),
    "skills/orchestrator/references/mcp-execution.md": Object.freeze(["e5521ac3485c022342deab25a65bf61f66578e6623beda0490f797439ebc48a0", "7106404c5bf8cacb3bb4ab2d63af0c0ac955a8ee9f3eb53462c1062e2ebd221a"]),
    "skills/ponytail/SKILL.md": Object.freeze(["2ce28db45c1a84e63fa2af7079e58a3803fc26b16ab7073436efd55b1e1214f9", "705c6f5aeff30330a5de661b4a28370a0e071e5fecd76cc6e8e88b074a96c250"]),
    "skills/ponytail/classification.json": Object.freeze(["add19e4199c76e6dbd9fc128763b4b71da7dd93d3b03f71a7344092132ca1191", "6f263e26ab1bb4b49ebe751395f5323fed4f8074a72089fc8aa28b6a17765f18"]),
    "skills/prompt-engineering/SKILL.md": Object.freeze(["8f613fa02ddb64f272fc86c5dbeffd4258bb32d9b2ced5b121b5b3bf8b7cec04", "9acdb598fcb0e559bf66ebb41e5c132d9f11bd9eb4af0b21085be98ff553a06b"]),
    "skills/prompt-engineering/classification.json": Object.freeze(["df00228c13434c02834092b71d6dbb4eec9bc9da3c10719b8fb360bd4d3fa90e", "5b24ea34f89e9548362f42def75e286048c8b1d90920cafbebf439b76ffc087d"]),
    "skills/recovery-strategy-selector/SKILL.md": Object.freeze(["ca85c3ba0d589fd91aa26629b1f689dad515e1e326f98fab4b7c775a4b86de25", "c87bf352f10b77f14981829f89109b834f07a2c813b3dd00cf39abdb19f74c6e"]),
    "skills/recovery-strategy-selector/classification.json": Object.freeze(["f1a123fad0c83c1af38579e2920823cf0bec3e86bbc3d27bdb122eb5c45dd622", "cbf6dda5aca35fe316599f673c0ab09f9915af931f0cc0c41e386cc8d473b7d4"]),
    "skills/session-board/SKILL.md": Object.freeze(["c23a8cebd2a794d9f281ba171f7dac073a5a91a68ceb9a26b748dd843a733bd2", "f244a6238e7d5e65bcf2418e1f70b61a82372f9b045d3f53947181b1d614efb7"]),
    "skills/session-board/classification.json": Object.freeze(["b859ff49fbeeee79efef9e61101aa9a9ffb04ddc9d4e330bec918960f26e4e38", "3dfe3113ab8908d6b10a67f9e33e1805b7d06a91e58267311371d70509e575f5"]),
    "skills/session-board/references/entry-details.md": Object.freeze(["1db28dc5c1ea4319e3c61f24270e3a5d52fe7e4acd00b7b5ad025a9131ffe778", "b89b50e2bacf86ca9268505d244336d5cbb212a7894ce629125201f512b8efce"]),
    "skills/software-security-auditor/SKILL.md": Object.freeze(["d996eba32563c04c608d17bc19ce16bf25bba752c317f458f9a386b6358df2b5", "294e5f7314049536f8eab3f1799bc5879a1d95e740310ad6b163f047fe492081"]),
    "skills/software-security-auditor/classification.json": Object.freeze(["f6354e18d117d008a8c8e8fc176eefa96e72eebb6040980d92dc3b4f861c3228", "ef252bf544e2f6917c10bb35456d173ea705de14b47c6d630b4ee2c2a92294de"]),
    "skills/solid-design/SKILL.md": Object.freeze(["38f03d44593d79f0a6bc0c2084187ae81eacf9a567c387c359ab4601278978a6", "402a4e5a5c44493b7dc4a33a21b6cd0f29e701ed9a060422975159caef609aac"]),
    "skills/solid-design/classification.json": Object.freeze(["14bd24bcfa856590f022bc0035c4cc8841d8f661765c26d10132a92e3c632069", "6c93f273ba7ed585f494d6043289e1bd6bac969390d788a50a69f021653f26f3"]),
    "skills/task-contract/SKILL.md": Object.freeze(["92cf19444e6c97b1d1d017f8eed481135d708095d89411668ab215123d1266aa", "3978551c31daa62bc88893621ad05fd8f86a5e3e06df2b2b6a4d6d72721bfef2"]),
    "skills/task-contract/classification.json": Object.freeze(["5fe716cb110508b99b3a113d9b4281c67f266cdd74fa56c2d2259b6ec4322238", "3a707ca184ba512bd016f5e5fcc10f033e28e51dec122889b98e9ccadaba1dda"]),
    "skills/task-contract/references/acceptance-criteria.md": Object.freeze(["ae6977721dee30fa64b3c8f467b2c81f9e7a3b0f3de3f3d062e7391fe88ae6b1", "55e07c6e2ea67a566f08644668b806b2ed50acca067f39969dd6f6738a9d37fe"]),
    "skills/test-engineering/SKILL.md": Object.freeze(["13f7bd7399070ee4db92b34067406e7ed000b3ae2f5ec04b1ff2ca4d32784927", "75e60228fe7307be776ed4925ea18a830f0e59d99a2d6a22715252731b37a3cc"]),
    "skills/test-engineering/classification.json": Object.freeze(["b7cd174b0a314bf228ac0a32f9c7c33ffe1494852c90ebd73c7682d548bb3e1c", "3e603b14e5f27eb21506d03b33afab40b4cf1ce6cc070e0936b6690c745e636f"]),
    "skills/workspace-convention-profiler/SKILL.md": Object.freeze(["4627b887cc63c1fe911990043f5fc6a6479b18b51ca2f89ddec7007c712707f7", "776ffe39f24e8ce60bcee1cfdd56527dc4b915c117a0a77b7c2e6cb4d40880db"]),
    "skills/workspace-convention-profiler/classification.json": Object.freeze(["15c01583cc8a233fd969ea873cf5ba0d56a6fc305cd2a9ff7ed7b57338cb2853", "7725b4d90a72e37bd9b2fa00f97c8e9d9ba760faf99b096e2ff4fa58d94d8f61"]),
    "skills/workspace-convention-profiler/references/entry-details.md": Object.freeze(["9248ec283c0ad3a95d335c3a8d32a2fbb2942f8b15eb8ee3762efdbbe85efb91", "9ac1425cb2864dfd1119618f5fc5d5513b762dd5c6a0916246b19e97bf21f178"]),
  }),
  additions: Object.freeze({
    "skills/independent-audit-gate/references/specialist-behavior.md": "fc1107c28eac3dc9d2bb69442b695a4164c6d4d9980a237fc1967fe39a5ac50d",
  }),
});
const SPECIALIST_BEHAVIOR_REFERENCE = "skills/independent-audit-gate/references/specialist-behavior.md";
// These skills were added after the frozen 26-skill behavior snapshot. Their own
// source lock and integration tests cover them; do not rewrite the historical pins
// or exempt arbitrary future directories from this historical inventory check.
const POST_SNAPSHOT_SPECIALISTS = Object.freeze(["ui-ux-design"]);

/** Read-only source-validation metadata, not a runtime skill selector or approval. */
export function getSpecialistBehaviorSuccessor() {
  return SPECIALIST_BEHAVIOR_SUCCESSOR;
}

function contextDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** True only for explicitly pinned current context, never for a predecessor or an unlisted path. */
export function matchesSpecialistBehaviorSuccessor(path, bytes) {
  bytes = beforeMultiWorkflowGuidance(path, bytes);
  const hashes = Object.hasOwn(SPECIALIST_BEHAVIOR_SUCCESSOR.hashes, path) ? SPECIALIST_BEHAVIOR_SUCCESSOR.hashes[path] : null;
  return Boolean(hashes && contextDigest(bytes) === hashes[1]);
}

/** An exact current successor may be projected; altered bytes are never replaced with trusted history. */
export function beforeSpecialistBehaviorSuccessor(path, bytes) {
  bytes = beforeMultiWorkflowGuidance(path, bytes);
  if (!matchesSpecialistBehaviorSuccessor(path, bytes)) return bytes;
  const original = git("show", `${SPECIALIST_BEHAVIOR_SUCCESSOR.baselineRevision}:${path}`);
  if (contextDigest(original) !== SPECIALIST_BEHAVIOR_SUCCESSOR.hashes[path][0]) {
    throw new Error(`Specialist behavior predecessor bytes differ: ${path}`);
  }
  return original;
}

function readBeforeSpecialistBehavior(root, relative) {
  return beforeSpecialistBehaviorSuccessor(relative, readFileSync(join(root, relative)));
}

/** Checks source integrity and required navigation only; semantic behavior needs separate evidence. */
export function checkSpecialistBehaviorSources() {
  const root = ROOT;
  const errors = [];
  const sources = new Map();
  const expectedEntries = SPECIALIST_BEHAVIOR_SUCCESSOR.skillIds.map(id => `skills/${id}/SKILL.md`);
  const pinnedEntries = Object.keys(SPECIALIST_BEHAVIOR_SUCCESSOR.hashes).filter(relative => /^skills\/[^/]+\/SKILL\.md$/u.test(relative));
  if (!sameSet(expectedEntries, pinnedEntries)) errors.push("specialist behavior skill coverage differs from the 26 pinned entries");
  if (!sameSet(Object.keys(SPECIALIST_BEHAVIOR_SUCCESSOR.additions), [SPECIALIST_BEHAVIOR_REFERENCE])) {
    errors.push("specialist behavior shared reference coverage differs");
  }
  const read = relative => {
    if (sources.has(relative)) return sources.get(relative);
    try { const bytes = readFileSync(join(root, relative)); sources.set(relative, bytes); return bytes; }
    catch { errors.push(`specialist behavior source missing: ${relative}`); sources.set(relative, null); return null; }
  };
  for (const [relative, hashes] of Object.entries(SPECIALIST_BEHAVIOR_SUCCESSOR.hashes)) {
    if (!/^skills\/[a-z0-9-]+\/(?:SKILL\.md|classification\.json|references\/[a-z0-9/._-]+\.md)$/u.test(relative)
      || relative.split("/").some(part => part === "." || part === "..")
      || hashes.length !== 2 || hashes.some(hash => !/^[a-f0-9]{64}$/u.test(hash)) || hashes[0] === hashes[1]) {
      errors.push(`specialist behavior source pin is invalid: ${relative}`);
      continue;
    }
    const bytes = read(relative);
    if (!bytes) continue;
    if (!matchesSpecialistBehaviorSuccessor(relative, bytes)) errors.push(`specialist behavior successor bytes differ: ${relative}`);
    else beforeSpecialistBehaviorSuccessor(relative, bytes);
  }
  for (const [relative, expected] of Object.entries(SPECIALIST_BEHAVIOR_SUCCESSOR.additions)) {
    const bytes = read(relative);
    if (bytes && (!/^[a-f0-9]{64}$/u.test(expected) || contextDigest(bytes) !== expected)) {
      errors.push(`specialist behavior addition bytes differ: ${relative}`);
    }
  }
  const actualEntries = skillDirectoryNames()
    .filter(name => !POST_SNAPSHOT_SPECIALISTS.includes(name))
    .flatMap(name => {
      const relative = `skills/${name}/SKILL.md`;
      try { readFileSync(join(root, relative)); return [relative]; }
      catch { return []; }
    });
  if (!sameSet(actualEntries, expectedEntries)) errors.push("specialist behavior entry inventory differs from the 26 pinned skills");
  for (const relative of expectedEntries) {
    const bytes = read(relative);
    if (!bytes) continue;
    const skillId = relative.split("/")[1];
    const target = skillId === "independent-audit-gate" ? "references/specialist-behavior.md" : "../independent-audit-gate/references/specialist-behavior.md";
    const required = `이 스킬을 적용할 때 [공통 행동 기준](${target})을 먼저 읽고 따른다.`;
    const source = bytes.toString("utf8");
    const links = [...source.matchAll(/\[[^\]]*\]\(([^)\s]*specialist-behavior\.md)\)/gu)];
    if (source.split(required).length !== 2 || links.length !== 1
      || posix.normalize(posix.join(posix.dirname(relative), links[0]?.[1] ?? "")) !== SPECIALIST_BEHAVIOR_REFERENCE) {
      errors.push(`specialist behavior required link differs: ${relative}`);
    }
  }
  // Cover the six entries outside the older 20-skill optimization too. New or
  // changed context is explicit; ordinary executable edits remain source-lock's responsibility.
  const contextChanges = new Set(projectRetiredChanges(SPECIALIST_BEHAVIOR_SUCCESSOR.baselineRevision, [
    ...git("diff", "--name-only", SPECIALIST_BEHAVIOR_SUCCESSOR.baselineRevision, "--", "skills").toString("utf8").trim().split(/\r?\n/u),
    ...git("ls-files", "--others", "--exclude-standard", "--", "skills").toString("utf8").trim().split(/\r?\n/u),
  ]).filter(relative => /^skills\/[^/]+\/.+\.(?:md|ya?ml)$/iu.test(relative) || /^skills\/[^/]+\/classification\.json$/u.test(relative))
    .filter(relative => !POST_SNAPSHOT_SPECIALISTS.some(id => relative.startsWith(`skills/${id}/`))));
  // A successor of a file the baseline did not have (references/intake.md) never projects onto the baseline.
  const projectsToBaseline = relative => guidanceSuccessor(relative) !== undefined
    && git("ls-tree", "--name-only", SPECIALIST_BEHAVIOR_SUCCESSOR.baselineRevision, "--", relative).toString("utf8").trim() === relative
    && readFileSync(join(root, relative)).equals(git("show", `${SPECIALIST_BEHAVIOR_SUCCESSOR.baselineRevision}:${relative}`));
  for (const relative of contextChanges) {
    if (!Object.hasOwn(SPECIALIST_BEHAVIOR_SUCCESSOR.hashes, relative) && !Object.hasOwn(SPECIALIST_BEHAVIOR_SUCCESSOR.additions, relative)
      && !isReviewedGuidanceAddition(relative) && !projectsToBaseline(relative)) {
      errors.push(`specialist behavior unpinned context change: ${relative}`);
    }
  }
  return {
    scope: "skill-context-only", authorityEffect: "none",
    validationScope: "source-bytes-links-and-historical-binding",
    modelBehaviorValidated: false,
    pass: errors.length === 0, errors,
    skillCount: expectedEntries.length,
    currentEntryBytes: expectedEntries.reduce((total, relative) => total + (sources.get(relative)?.length ?? 0), 0),
    sharedReferenceBytes: sources.get(SPECIALIST_BEHAVIOR_REFERENCE)?.length ?? 0,
  };
}

// 3.6.0: the approval schema successor retains its exact predecessor binding.
// Executable provenance belongs to source-lock, independently of this context-only check.
const APPROVAL_EXPIRY_SUCCESSOR = Object.freeze({
  revision: "mutation-risk-preflight-approval-expiry-optional",
  authorityEffect: "none",
  hashes: {
    "skills/mutation-risk-preflight/contracts/mutation-intent.v1.schema.json": ["6e0e6d58bd0ca772633f37c02fe6e109da2a5a03a8a382406c3e08a0ac53473a", "761c3185090df53f2f73c12dea07e368964661a730a7ef7c61f9bd5bf52416fe"],
  },
});
// 3.8.0 (AGS3-D-0030): the board store declares the session role column and setSummary's optional role.
const SESSION_ROLE_SUCCESSOR = Object.freeze({
  revision: "session-board-role-r01",
  authorityEffect: "none",
  hashes: {
    "skills/session-board/scripts/board-store.d.mts": ["df77f6a8d0ce1e576782c394ad6b78261003de23f32a03e9b6a4ef05de762bc0", "87c8cbd745da273bee3bb9419b487173841d29f9f0bf83fe002f1d2ebd2ae1fe"],
  },
});
const DIGEST_SUCCESSORS = Object.freeze([SESSION_ROLE_SUCCESSOR, APPROVAL_EXPIRY_SUCCESSOR]);

/** The digest pinned checks compare: reviewed bytes stand for the exact predecessor they replaced. */
export function pinnedDigest(path, bytes) {
  let digest = createHash("sha256").update(bytes).digest("hex");
  for (const { hashes } of DIGEST_SUCCESSORS) {
    const successor = hashes[path];
    if (successor && digest === successor[1]) digest = successor[0];
  }
  return digest;
}
// AC-010 adds peer instructions after the reviewed optimization. Preserve all
// historical bytes and compare the exact, separately frozen addition as well.
const SESSION_BOARD_ADDITION = "scripts/fixtures/session-board-peer-message-guidance.2.6.0.md";
const SESSION_BOARD_ADDITION_SHA256 = "381be4018118086b3c4087be043c004d8d6de986d42a6c0c14f182c2d76ed76f";
const CS_HANDOFF_ADDITION = "scripts/fixtures/cs-engineering-handoff.2.8.0.md";
const CS_HANDOFF_SHA256 = "c8937d58fd2d9193f191d86c629c9b54731d08d82ec12cb3249ff82e6362ed52";
const ENGINEERING_ADDITION = "scripts/fixtures/engineering-practices-handoff.2.8.1.md";
const ENGINEERING_ADDITION_SHA256 = "6f4bc0fd90113630f077415038492cbceddbaafb9e4e566c750111fafb3abef1";
const ENGINEERING_REFERENCES = Object.freeze({
  "agent-instructions.md": "a6df55ef522a75262b93381ad2f8b5fcaca4212a0afeab6cc0d1a90de2230424",
  "catalog.json": "936714985d22b8ea67b51c5d74cceef2d1321efac8dbfca58989ba124bff3d81",
  "cli.md": "be715633beccc35385f6b1ae3c0c822d1a3487afcae9398bda0d9cf74cfa9341",
  "code-review.md": "43549ced37a9eb4545d67e66122391386da0bde763919a0fdc80f0abaab0e65c",
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

// Selected current-source bindings; original provenance and optimization baselines stay frozen.
const GOVERNANCE_SOURCE_SUCCESSOR = Object.freeze({
  "revision": "governance-selected-source-successor-r03",
  "authorityEffect": "none",
  "baselineRevision": "92b81a84d44d79fc03a06a3493005eb114191eb9",
  "hashes": {
    "skills/blocker-diagnostician/README.md": "3ec56113a02752cea6939f1d53ea8251f16eda4f99ba9e87ac45bc0a11e26c73",
    "skills/blocker-diagnostician/SKILL.md": "0b2ed15e57c2c344661a3ae64073181d6f7b8940b7ef4e315daf010629c7f0de",
    "skills/blocker-diagnostician/classification.json": "76fd1350e10e6f2763b5d25bd66a0af09e59b6e77c3aec8fc24a56049eb179af",
    "skills/blocker-diagnostician/references/diagnosis-protocol.md": "4fffd3c0656ffee3caca1eb072a5f9a3f6a3c91ba7f15644c973c9050c9437c1",
    "skills/blocker-diagnostician/references/entry-details.md": "90d37e3edae634cf0a44260d8c67f8c356db3b1805666757810ae80d27a520dc",
    "skills/change-scope-guardian/contracts/change-scope-report.v1.schema.json": "c8c3929dd667b971dbc3c93c092c543969895a2df12e9f78d290ea8c55dcbd98",
    "skills/change-scope-guardian/integration/skill-descriptor.json": "0383344088d90c7306cc9de937b8ba0445985529c7291a54cf36aab7fcb0d65b",
    "skills/change-scope-guardian/references/entry-details.md": "7074715cc45a34b73ca2fa12a1c967742676a622d24e438c44a3d3c601a5e788",
    "skills/change-scope-guardian/references/verdict-rules.md": "7fd12a4242437c1ce40953e49cb116cffac688e361b3033f802f5c70c37db865",
    // D0095 reviewed source: eb30ea34168b4d4c3831f2fa8b9c82d9fc06b06c; historical baselines stay frozen.
    "skills/coordinate-subagents/references/model-routing.md": "49b0e564b80a52475670e850c8272f0c348626ef5d32e4746fd484a262023fe5",
    "skills/evaluation-validity-auditor/classification.json": "46b94a039e643a333f021f4792f92edb3b19263e47206c1f1b75e1afcbbbb9df",
    // AGS 3.0 gates (docs/archive/ags30-gates-design.md): audit target binds the signed plan; unobserved claims are recorded.
    "skills/orchestrator/references/specialist-handoffs.md": "9767d9d899acdd3fabf57d094c16bf64788dddf324a1bf001d6b970d285fecd9",
    // D0336 reviewed source: worker independence that v1 cannot observe is BLOCKED, not PASS.
    "skills/evaluation-validity-auditor/references/audit-protocol.md": "cb31b803db1debadc5292edc7906b5c0654b95ffcdc5e511545687fa74080f37",
    "skills/evaluation-validity-auditor/references/entry-details.md": "3788c88d6522139cdbd18c34a2386b0706d0ecf3fe47f51824708c01e289b184",
    "skills/independent-audit-gate/SKILL.md": "26086ee54f0d49b1bc861ec27200d26150737d9772773e07139ae59f56404e29",
    "skills/independent-audit-gate/classification.json": "80a4192630678554a8dc2c05221228abcfcaee73ec12ebf54d739fbd03883576",
    "skills/independent-audit-gate/references/audit-protocol.md": "0fc4cb86a3c68cef24c69487e9088bd8c5e07a6f2bff7a120211881d3540c30d",
    "skills/independent-audit-gate/references/entry-details.md": "830d33d1e68e125a52f324652af09096d9d1771124bd7518ec2ae2097fc17e38",
    "skills/independent-deliberation-panel/references/orchestration-policy.md": "ff72d35b11196ccb73e85fe73eda04caf26380f7c264fb800357c9f55c0b62c1",
    "skills/model-effort-advisor/SKILL.md": "fa84d128bf1d9a6742b74f13080db98f304803e84168b8de39a9e120a01a9a6a",
    "skills/model-effort-advisor/classification.json": "9dee08d541f2a0dae21352cbbd4d1e8c3cbf7cdaefcf7db94bf0cf8598f17518",
    "skills/orchestrator/SKILL.md": "b90c19a956f4dd3b239e4f4a527ebea319128dbae239018f8f3b0b5445cc43ac",
    "skills/orchestrator/classification.json": "dbeb13d177c67b8fc9d697931d6fbcf789aec6af6b3d0e412110e8146bb18b1c",
    "skills/orchestrator/references/engineering-practices/catalog.json": "1bd90817d65a175b40cd1adc9b447ada117eca05f4868c90b9e8f96c247ae1c3",
    "skills/orchestrator/references/engineering-practices/implementation.md": "57dc9ffcba25928a0da81e677512f75ad801812ff133a80b9dda3b4030150a4b",
    "skills/orchestrator/references/entry-details.md": "7fdb556e8c6546d819b868cb8084e561507d4e9c850a292f657749c0a09285b3",
    "skills/orchestrator/references/skill-classification.md": "c9274214f8fb85ffdf5d138e9a4382b2f2906127b9d47db82dfa542ed28ed2c8",
    "skills/ponytail/SKILL.md": "907667b8b625eab0438b462a4737a056e3833f972c66e432817a12e6f643ac76",
    "skills/ponytail/classification.json": "19b81d57825cecd7a366b50efb9f220446f5208839b26faee2710af00da3d926",
    "skills/recovery-strategy-selector/classification.json": "f1a123fad0c83c1af38579e2920823cf0bec3e86bbc3d27bdb122eb5c45dd622",
    "skills/recovery-strategy-selector/references/entry-details.md": "5939abcfcf5412dc82ccf39571ee2e225723fa4be1956363a0b24b4e50cab48a",
    "skills/recovery-strategy-selector/contracts/recovery-handoff.v1.schema.json": "ef19894512527f8dfac6b4acff6d6cb347b6a2183b140260ae8426e0183ae241",
    "skills/recovery-strategy-selector/contracts/recovery-strategy-selection-request.v1.schema.json": "684d92828e97be4763d7c8ace6250288b8df0b450f23b89f5b65842da7278d8e",
    "skills/recovery-strategy-selector/references/selection-protocol.md": "5d9d8070948ef8ec4ce0c1cf16de179586ce96dc660e1ce3b6a214ae4dbe8f7c",
    // AGS 3.0 session board redesign (docs/archive/ags30-session-board-design.md); historical baselines stay frozen.
    "skills/session-board/references/entry-details.md": "1db28dc5c1ea4319e3c61f24270e3a5d52fe7e4acd00b7b5ad025a9131ffe778",
    "skills/session-board/scripts/board-store.d.mts": "df77f6a8d0ce1e576782c394ad6b78261003de23f32a03e9b6a4ef05de762bc0",
  },
  "previousHashes": {
    "skills/session-board/references/entry-details.md": "e8ea65d5d3d372fe70ba0fe7cdba18d965704450f2a7084b27ce885695e68660",
    "skills/session-board/scripts/board-store.d.mts": "d4a156f0a4f3a83fdaf655daf3fe88efd14c427c79ffceb1b8012d14c38a0098",
    "skills/blocker-diagnostician/SKILL.md": "5cc3e57aa82d28a7087717c13f39661911cefc6ec20d9ae9387a49bd1fadfb2e",
    "skills/blocker-diagnostician/references/entry-details.md": "5d3068c1151d10ff89304f2c3a5e18be6dc235d75cff179e3ff68a28d76aaebf",
    "skills/change-scope-guardian/references/entry-details.md": "d164e59584763265a4bd8ccfd6a4ee75560f1df4ef30cd44dee68d814baf185b",
    "skills/evaluation-validity-auditor/references/entry-details.md": "7d31114e9200454d084dd7df04db34f1afc4c3ac23f3feb09c5eef6a85be8950",
    "skills/independent-audit-gate/SKILL.md": "6d46d2eda33237b9e67bb0f44d102a22ef24154bbef3478671b6ed863b6c7bd8",
    "skills/independent-audit-gate/references/entry-details.md": "3f117c44ba584885a2dc9b370a20f3f4ae4a8e672dae1bd174586d8d27b9ca7e",
    "skills/model-effort-advisor/SKILL.md": "55d965086eab2ac7fe8acd34d32a520a91ed465e92bfe8b73629b04ab8d61106",
    "skills/orchestrator/SKILL.md": "1cfaf8503aacae72fb7e2591e708bea507848ae338e21855c15e4b1ccb635cd1",
    "skills/orchestrator/references/entry-details.md": "2c50a92c5cc59676ae6ac2bae1f9d86f337cdc7870b20ff9df12e8e3cd09670b",
    "skills/ponytail/SKILL.md": "953fd16ff07c23b9481e9bdfca12dbb0d115422ebdbd6626bae6b574838a777c",
    "skills/recovery-strategy-selector/references/entry-details.md": "08b489c4ace78471ae6737fcea06e1885294d8d0b5f2207c74c6f740ac05375e"
  }
});

const HOST_CONSUMPTION_SOURCE_SUCCESSOR = Object.freeze({
  "revision": "host-consumption-source-successor-r01",
  "authorityEffect": "none",
  "baselineRevision": "b0b455b3ef737cc67e0a350cc1477f4ce6162828",
  "hashes": {
    "skills/session-board/SKILL.md": "c23a8cebd2a794d9f281ba171f7dac073a5a91a68ceb9a26b748dd843a733bd2",
    "skills/session-board/classification.json": "b859ff49fbeeee79efef9e61101aa9a9ffb04ddc9d4e330bec918960f26e4e38"
  },
  "previousHashes": {
    "skills/session-board/SKILL.md": "b4c2226e35c277c53dd89305c31961f81a2f739bbca61f47d567c12462ea209a",
    "skills/session-board/classification.json": "7193daa7a84da2918be65472c086624b5748f2122bf2071993c96e3afe20dd7e"
  }
});

export function matchesHostConsumptionSourceSuccessor(path, bytes) {
  bytes = beforeSpecialistBehaviorSuccessor(path, bytes);
  return Object.hasOwn(HOST_CONSUMPTION_SOURCE_SUCCESSOR.hashes, path)
    && createHash("sha256").update(bytes).digest("hex") === HOST_CONSUMPTION_SOURCE_SUCCESSOR.hashes[path];
}

const ORCHESTRATOR_MIDTASK_SOURCE_HASHES = Object.freeze({
  "skills/orchestrator/SKILL.md": "56dabaa45041f8975eede0e08dd2b2c876ca71eca0fb5bc8256bfdaeb46098c5",
  "skills/orchestrator/classification.json": "f034243569190280ebc060f5f1654fcfcf8ee4b4f60c9e5ac19d8a1ebc5f8074",
});
const ORCHESTRATOR_RESOURCE_IMPACT_SOURCE_HASHES = Object.freeze({
  "skills/orchestrator/SKILL.md": "e5f2e1cf5bbfa49821a5aad81ad83b68cf5cae3ec75c92050a8a4cd13b56be45",
  "skills/orchestrator/classification.json": "6d33ef4bc3ae5daa8c15867f03dbdaf4c0cebf76fcfbd872ca1b8c3b6636baad",
});
const ORCHESTRATOR_BEHAVIOR_SOURCE_HASHES = Object.freeze({
  "skills/orchestrator/SKILL.md": "5f2cf07a358914cd068a90cf6eb7fe3bbf549a7fc08e47dfc6daecefeabd44f4",
  "skills/orchestrator/classification.json": "44d66bda8d2c80034d3f881ff3f12de6d628bd4d8ce850fd49718df656aa95d2",
  "skills/orchestrator/references/entry-details.md": "86af016cfc8399a656181f5253189c098b53434aaa8b7d4fd1353d586248333f",
});
// D0352: 분류 지원 미확정 지침과 원문 범위를 보존한 재결속의 정확한 후속 바이트만 허용한다.
const ORCHESTRATOR_CLASSIFICATION_UNAVAILABLE_SOURCE_HASHES = Object.freeze({
  "skills/orchestrator/SKILL.md": "4b00fd06d5636f2ef914a5ac66dec10145a62887371813ec1592f0790b4e965d",
  "skills/orchestrator/classification.json": "c43f537d2c0fff5c8f9f569cb224d8d6925076d271fdf47b78253bc41ba5ace4",
});
// Phase check (docs/archive/ags30-phase-check-design.md 3.1): staged change work starts with plan_workflow; exact successor bytes only.
const ORCHESTRATOR_PHASE_CHECK_SOURCE_HASHES = Object.freeze({
  "skills/orchestrator/SKILL.md": "9449361d827e52ae9de6d6be5248fe76e18b8165ee0a26900e7f54b241876b00",
  "skills/orchestrator/classification.json": "268eae71468978406b87e29774029fabbee8a7b576d06e4fd95ca269b284c55e",
});
// Workflow enforcement (docs/archive/ags30-phase-check-design.md 7): start_workflow is the minimal start; exact successor bytes only.
const ORCHESTRATOR_WORKFLOW_ENFORCEMENT_SOURCE_HASHES = Object.freeze({
  "skills/orchestrator/SKILL.md": "e9be18c4d7f14a8aca9a3ce521501e6a673626a96d5bb07735f562e11c153001",
  "skills/orchestrator/classification.json": "52d8d444e8c8fdadd4786d730191b37c6430c97993dcb93e447cccb5c69dfe02",
  "skills/orchestrator/references/mcp-execution.md": "e5521ac3485c022342deab25a65bf61f66578e6623beda0490f797439ebc48a0",
});
// 참고자료는 역사 원문으로 투영하지 않고 현재의 정확한 분류 원문으로 판정한다.
const ORCHESTRATOR_CLASSIFICATION_UNAVAILABLE_REFERENCE_HASHES = Object.freeze({
  "skills/orchestrator/references/skill-classification.md": "f33cce4afc3ef2480c94799f46ae78e133c1576e3b57a257c1046f6956d811c9",
});
// D0352 makes the field guide use the existing common routing decision.
// Preserve the optimization baseline; allow only this reviewed source delta.
const TASK_CONTRACT_ROUTING_SOURCE_HASHES = Object.freeze({
  "skills/task-contract/references/field-guide.md": "09083264f2f4746dcda5e9f342d0a0ec27ca21cb692965d036121dc882bc1ac7",
});
// 9d623d7a: attempt leases no longer expire by time. Allow only these exact reference bytes.
const ORCHESTRATOR_LEASE_EXPIRY_REMOVAL_SOURCE_HASHES = Object.freeze({
  "skills/orchestrator/references/convergence-guard.md": "cb8bbae8f94c18a9c6dc4a90bec8bcaf0b91e414ffb223d1a514ab92d3bdb70f",
});

function matchesOrchestratorSourceSuccessor(path, bytes) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return [ORCHESTRATOR_MIDTASK_SOURCE_HASHES, ORCHESTRATOR_RESOURCE_IMPACT_SOURCE_HASHES, ORCHESTRATOR_BEHAVIOR_SOURCE_HASHES,
    ORCHESTRATOR_CLASSIFICATION_UNAVAILABLE_SOURCE_HASHES, ORCHESTRATOR_PHASE_CHECK_SOURCE_HASHES, ORCHESTRATOR_WORKFLOW_ENFORCEMENT_SOURCE_HASHES]
    .some(hashes => Object.hasOwn(hashes, path) && digest === hashes[path]);
}

export function matchesGovernanceSourceSuccessor(path, bytes) {
  bytes = beforeSpecialistBehaviorSuccessor(path, bytes);
  // Current mid-task selection wording is an exact source successor, not a 2.x runtime contract.
  // Historical reconstruction below still uses the separately pinned predecessor bytes.
  if (matchesOrchestratorSourceSuccessor(path, bytes)) return true;
  const digest = pinnedDigest(path, bytes);
  return [GOVERNANCE_SOURCE_SUCCESSOR.hashes, ORCHESTRATOR_CLASSIFICATION_UNAVAILABLE_REFERENCE_HASHES]
    .some(hashes => Object.hasOwn(hashes, path) && digest === hashes[path]);
}

function beforeGovernanceSuccessor(path, bytes) {
  bytes = beforeSpecialistBehaviorSuccessor(path, bytes);
  if (matchesHostConsumptionSourceSuccessor(path, bytes)) {
    const original = git("show", `${HOST_CONSUMPTION_SOURCE_SUCCESSOR.baselineRevision}:${path}`);
    if (createHash("sha256").update(original).digest("hex") !== HOST_CONSUMPTION_SOURCE_SUCCESSOR.previousHashes[path]) throw new Error(`Historical host consumption source differs: ${path}`);
    return original;
  }
  if (!matchesGovernanceSourceSuccessor(path, bytes)) return bytes;
  const original = git("show", `${GOVERNANCE_SOURCE_SUCCESSOR.baselineRevision}:${path}`);
  if (createHash("sha256").update(original).digest("hex") !== GOVERNANCE_SOURCE_SUCCESSOR.previousHashes[path]) {
    throw new Error(`Historical governance source differs: ${path}`);
  }
  return original;
}

export function matchesPonytailPolicySuccessor(path, bytes) {
  bytes = beforeSpecialistBehaviorSuccessor(path, bytes);
  if (matchesGovernanceSourceSuccessor(path, bytes)) return true;
  return Object.hasOwn(PONYTAIL_POLICY_SUCCESSOR.hashes, path)
    && createHash("sha256").update(bytes).digest("hex") === PONYTAIL_POLICY_SUCCESSOR.hashes[path];
}

// 문서·계약 바이트만 문맥 검사에 남긴다. 실행 무결성은 source-lock 책임이다.
const CONTEXT_CONTRACT_PINS = Object.freeze({
  revision: "3.9.0-d0058-model-policy-recommendation",
  authorityEffect: "none",
  hashes: Object.freeze({
  "contracts/model-policy.v1.schema.json": "ebb14766f5f7b57b4b2639b5714fb69f5e6597292d3dbaa31c8a0942497cf7fc",
  "runtime/collaboration-decision.d.mts": "dfd4a99ed6dcdd8e06497f42beab103410d4082d1de3f6b98690fe7a1cec8c14",
  "runtime/provider-acceptance-semantics.d.mts": "5ad79b91fd34d6d4f07321b1011e2b48b5311a89296d10c360ed108ed92f45cf",
  "runtime/session-board-store.d.mts": "fb6dc871d6dc40f180d65ef770c27665f3b29ad2868ffce372cd511feb395067",
  "skills/acceptance-evidence-validator/contracts/acceptance-evidence-input.v1.schema.json": "c4a0f4080ed2d1605ec0d362d2abaf8c585d06d3a8e5d262aacd264be122686e",
  "skills/acceptance-evidence-validator/contracts/acceptance-evidence-report.v1.schema.json": "9054b1bbfc5c431ad61b1daddb44ace792c647328146feb8bb6d1087c4f16000",
  "skills/acceptance-evidence-validator/scripts/core.d.mts": "5ad79b91fd34d6d4f07321b1011e2b48b5311a89296d10c360ed108ed92f45cf",
  "skills/coordinate-subagents/references/model-routing-policy.schema.json": "ebb14766f5f7b57b4b2639b5714fb69f5e6597292d3dbaa31c8a0942497cf7fc",
  "skills/coordinate-subagents/references/model-routing.md": "b86755582e5c704bea3b5f1270d37544aa14dcd3c60a909170c079346e9342a8",
  "skills/coordinate-subagents/scripts/model-catalog-adapter.d.mts": "f94acb26345326e949530a3993047b6e7ad9fcb8be66c52e1809ea55faf2165b",
  "skills/coordinate-subagents/scripts/model-routing-policy.d.mts": "e8faf41ef2ff2889a29a2f27b9a8ed55c9579f83eef0093744a4f11cbd5c483e",
  "skills/coordinate-subagents/scripts/model-routing.d.mts": "4afbbfc1167ee637d1aab74bbfe4ec55241931d33fa55442b94dcea8d8e93fbe",
  "skills/independent-deliberation-panel/evals/fixtures/valid/ad01_specialist_cap.json": "9423c10246f09738712ac0bf5b5f9134795fa8a9f03bfb4d2a2f2af96af3618f",
  "skills/instruction-scope-resolver/references/gemini-instructions.md": "fb03a623c11627f8fed8cfad07d6c492fcd4a710dd73b25963840f8524b18a56",
  "skills/iteration-frame-auditor/integration/skill-descriptor.json": "44b5fa664b83708b62f664606910558e09837f3bb84a232fdfe8b5e82e4fb1f1",
  "skills/korean-prose-editor/contracts/protected-manifest.schema.json": "cb518ab89e3a6b2ad422f5015f58843291505cf6a7360a4983a18b974cec25c7",
  "skills/korean-prose-editor/contracts/receipt.schema.json": "2ad9e132c19e58c9fcdc2a15fce4715c840766ebce638722f11ee47173a688f4",
  "skills/model-effort-advisor/contracts/model-effort-advice.v1.schema.json": "0c5c3f0edff94d0e416ebf71e4ea40b5d07138019caf4cf82752557e35b068d8",
  "skills/model-effort-advisor/scripts/support-guard.d.mts": "2a8d8e290fd57d4beb384727b355d7338bc651eed1323f75d11926d5750d7512",
  "skills/mutation-risk-preflight/references/recovery-requirements.md": "41c5284d8dd1c5c9f1f7c6d8e090f8a2af36677fbb0bc8b21e18cbcf2d1754ed",
}),
});

// Explicit current-source successor. Historical optimization/provenance bytes stay frozen.
const TASK_CONTRACT_AUTHORIZATION_SUCCESSOR = Object.freeze({
  "revision": "gov08-task-contract-authorization-r01",
  "authorityEffect": "none",
  "baselineRevision": "3a9f7b15d1ce879b5e9967bd72b19bce61cbbdf7",
  "previousEntryDetailSha256": "e587fd4a1b94415ec30ad943bb1cc9d81f1cb988b07ecab3df3cedd4f6c7efc9",
  "hashes": {
    "skills/task-contract/references/risk-and-authorization-rubric.md": "717e1fb27d4ebf7b6481c84e20de018b8461fd7ff277c6434f6f2d52f7cca89e",
    "skills/task-contract/references/entry-details.md": "401c494535eb2d62d0ec80810f1610c12071fcf5e3ed2c1cef23b23ba09440c2"
  }
});

export function matchesTaskContractAuthorizationSuccessor(path, bytes) {
  bytes = beforeSpecialistBehaviorSuccessor(path, bytes);
  return Object.hasOwn(TASK_CONTRACT_AUTHORIZATION_SUCCESSOR.hashes, path)
    && createHash("sha256").update(bytes).digest("hex") === TASK_CONTRACT_AUTHORIZATION_SUCCESSOR.hashes[path];
}

// Project only the exact 1.0.2 private-preparation successor onto its reviewed
// predecessor. Historical pins and authority checks remain unchanged.
const PREFLIGHT_PRIVATE_PREPARATION_SUCCESSOR = Object.freeze({
  revision: "mutation-risk-preflight-1.0.2-private-preparation",
  baselineRevision: "59a580ac950e4813108d5b3a83bf01b9de0d7ccb",
  authorityEffect: "none",
  hashes: {
    "skills/mutation-risk-preflight/README.md": [
      "c7bc39a506ff4aeed3726cea2c92ef4558e62d0d28d03ccde09d083a33ada213",
      "0b53b679be4eb87053a019ca78d33cccd0b3d1f3a7888853b643e8a69344afa7"
    ],
    "skills/mutation-risk-preflight/SKILL.md": [
      "9aa4e7cb143bb0ad9ffc5f6c03ed32331e1f14562cd4322fab0e36cd29c21ce1",
      "25fbe08cc026df65c7e5788a7c9ad4414a7b5be52f55a587952773966eb29ecb"
    ],
    "skills/mutation-risk-preflight/classification.json": [
      "ddf79c9ba8187a9e6de0af7a88f280372dccbf859a672ea335d16caa45735933",
      "c89920b9450dc403770228a033918e0d47aee987902e44a64f1c817e83d5860e"
    ],
    "skills/mutation-risk-preflight/contracts/mutation-intent.v1.schema.json": [
      "eaf3bc82d4d18372544e54f39cfe0d6214ade77e983589de62789828207b8dc6",
      "978288d69583b0f39f7412d3140d57537804de3bc2703060994bc9a7b472d064"
    ],
    "skills/mutation-risk-preflight/contracts/mutation-preflight-report.v1.schema.json": [
      "4e6f86d0baf672ef0bd83a4a9c592bd8ec5dcab1f342071372908f52e5217fde",
      "b8a4e1ca5f5e203639545d27cc190421d91d132569cec70f5b579d39337b7331"
    ],
    "skills/mutation-risk-preflight/integration/skill-descriptor.json": [
      "c0340eaf53126034cb3ba13b2c9adbd03fdbecb23942687fca771487dc393264",
      "e7905d5b63cfb2536b96c70047ad5231951ccccf4b06adc29a18d8531eeb673a"
    ],
    "skills/mutation-risk-preflight/references/entry-details.md": [
      "1630c479078b9df86da6a14cf679c113ed2e4be3c9da2bc4cb5707c1f99c4fba",
      "b9d8952a60a92f7e0ef98c9d90f076dddfc9bedcbd8a0e3af0b02d1dd50bffd4"
    ],
    "skills/mutation-risk-preflight/references/recovery-requirements.md": [
      "973da35b3d3080878c746bf32563764a6d7c580dc7912ab040edd68123086d19",
      "6b9534f7a9db0f7210a9a16c5bd9c930bbd458a4ce2aeb05547dc959ac5259a8"
    ],
  },
});

export function matchesPreflightPrivatePreparationSuccessor(path, bytes) {
  bytes = beforeSpecialistBehaviorSuccessor(path, bytes);
  const hashes = PREFLIGHT_PRIVATE_PREPARATION_SUCCESSOR.hashes[path];
  return Boolean(hashes && pinnedDigest(path, bytes) === hashes[1]);
}

// Bind 1.0.3 exactly, then reuse the unchanged 1.0.2 -> historical chain.
const PREFLIGHT_PLATFORM_EVENTS_SUCCESSOR = Object.freeze({
  revision: "mutation-risk-preflight-1.0.3-platform-events",
  baselineRevision: "245a1e85ab649acb4a6766ad2332191edb35cb74",
  authorityEffect: "none",
  hashes: {
    "skills/mutation-risk-preflight/README.md": ["0b53b679be4eb87053a019ca78d33cccd0b3d1f3a7888853b643e8a69344afa7", "ed6a995b580aeb20c1da67237cfda161c6d219a5e7e444d8d91bc82acf954968"],
    "skills/mutation-risk-preflight/SKILL.md": ["25fbe08cc026df65c7e5788a7c9ad4414a7b5be52f55a587952773966eb29ecb", "f3975e529669c17acd83a951b816aa57efa7c8fef469130726200b057e131188"],
    "skills/mutation-risk-preflight/classification.json": ["c89920b9450dc403770228a033918e0d47aee987902e44a64f1c817e83d5860e", "257f8f3affdc01511c44052de26e0c7e65076f61663ebce0d7871ca9550ce25e"],
    "skills/mutation-risk-preflight/contracts/mutation-intent.v1.schema.json": ["978288d69583b0f39f7412d3140d57537804de3bc2703060994bc9a7b472d064", "6e0e6d58bd0ca772633f37c02fe6e109da2a5a03a8a382406c3e08a0ac53473a"],
    "skills/mutation-risk-preflight/integration/skill-descriptor.json": ["e7905d5b63cfb2536b96c70047ad5231951ccccf4b06adc29a18d8531eeb673a", "1e4f8dbc7e7d61a711ab884fb459389e4ef82b11c58765faa0f490d147cb7c58"],
    "skills/mutation-risk-preflight/references/recovery-requirements.md": ["6b9534f7a9db0f7210a9a16c5bd9c930bbd458a4ce2aeb05547dc959ac5259a8", "eea0b3129263b17d12d7f05ecd823b6882ca35cc6211e5613431b429875e3842"],
  },
});

export function matchesPreflightPlatformEventsSuccessor(path, bytes) {
  bytes = beforeSpecialistBehaviorSuccessor(path, bytes);
  const hashes = PREFLIGHT_PLATFORM_EVENTS_SUCCESSOR.hashes[path];
  return Boolean(hashes && pinnedDigest(path, bytes) === hashes[1]);
}

// Bind the receipt expiry removal (9d623d7a) exactly, then reuse the unchanged 1.0.3/1.0.2 -> historical chain.
const PREFLIGHT_EXPIRY_REMOVAL_SUCCESSOR = Object.freeze({
  revision: "mutation-risk-preflight-receipt-expiry-removal",
  baselineRevision: "7326e5f6d74112c9935bc5d270ad46aa28476ad9",
  authorityEffect: "none",
  hashes: {
    "skills/mutation-risk-preflight/contracts/mutation-preflight-report.v1.schema.json": ["b8a4e1ca5f5e203639545d27cc190421d91d132569cec70f5b579d39337b7331", "011e06daac326d162351f06701d461ae3bedbeda37b2003b8e518c28c065884d"],
    "skills/mutation-risk-preflight/references/entry-details.md": ["b9d8952a60a92f7e0ef98c9d90f076dddfc9bedcbd8a0e3af0b02d1dd50bffd4", "027c08a08a559af62f945c00dab640e79deb88d6d9afe2042d1271d6ddd04f54"],
  },
});

export function matchesPreflightExpiryRemovalSuccessor(path, bytes) {
  bytes = beforeSpecialistBehaviorSuccessor(path, bytes);
  const hashes = PREFLIGHT_EXPIRY_REMOVAL_SUCCESSOR.hashes[path];
  return Boolean(hashes && pinnedDigest(path, bytes) === hashes[1]);
}

function matchesPreflightPlatformEventsChain(path, bytes) {
  return matchesPreflightPlatformEventsSuccessor(path, bytes)
    || (matchesPreflightExpiryRemovalSuccessor(path, bytes)
      && PREFLIGHT_EXPIRY_REMOVAL_SUCCESSOR.hashes[path][0] === PREFLIGHT_PLATFORM_EVENTS_SUCCESSOR.hashes[path]?.[1]);
}

function matchesPreflightPrivatePreparationChain(path, bytes) {
  return matchesPreflightPrivatePreparationSuccessor(path, bytes)
    || (matchesPreflightPlatformEventsChain(path, bytes)
      && PREFLIGHT_PLATFORM_EVENTS_SUCCESSOR.hashes[path][0] === PREFLIGHT_PRIVATE_PREPARATION_SUCCESSOR.hashes[path]?.[1])
    || (matchesPreflightExpiryRemovalSuccessor(path, bytes)
      && PREFLIGHT_EXPIRY_REMOVAL_SUCCESSOR.hashes[path][0] === PREFLIGHT_PRIVATE_PREPARATION_SUCCESSOR.hashes[path]?.[1]);
}

function beforePreflightExpiryRemoval(path, bytes) {
  if (!matchesPreflightExpiryRemovalSuccessor(path, bytes)) return bytes;
  const original = git("show", `${PREFLIGHT_EXPIRY_REMOVAL_SUCCESSOR.baselineRevision}:${path}`);
  if (createHash("sha256").update(original).digest("hex") !== PREFLIGHT_EXPIRY_REMOVAL_SUCCESSOR.hashes[path][0]) throw new Error(`Historical preflight expiry-removal source differs: ${path}`);
  return original;
}

function beforePreflightPlatformEvents(path, bytes) {
  if (!matchesPreflightPlatformEventsSuccessor(path, bytes)) return bytes;
  const original = git("show", `${PREFLIGHT_PLATFORM_EVENTS_SUCCESSOR.baselineRevision}:${path}`);
  if (createHash("sha256").update(original).digest("hex") !== PREFLIGHT_PLATFORM_EVENTS_SUCCESSOR.hashes[path][0]) throw new Error(`Historical preflight platform-events source differs: ${path}`);
  return original;
}

const PREFLIGHT_ADDITIVE_SOURCE_SUCCESSOR = Object.freeze({
  "revision": "preflight-additive-source-successor-r01",
  "authorityEffect": "none",
  "hashes": {
    "skills/mutation-risk-preflight/contracts/mutation-intent.v1.schema.json": "eaf3bc82d4d18372544e54f39cfe0d6214ade77e983589de62789828207b8dc6",
    "skills/mutation-risk-preflight/references/recovery-requirements.md": "973da35b3d3080878c746bf32563764a6d7c580dc7912ab040edd68123086d19"
  }
});

export function matchesPreflightAdditiveSourceSuccessor(path, bytes) {
  bytes = beforeSpecialistBehaviorSuccessor(path, bytes);
  return Object.hasOwn(PREFLIGHT_ADDITIVE_SOURCE_SUCCESSOR.hashes, path)
    && createHash("sha256").update(bytes).digest("hex") === PREFLIGHT_ADDITIVE_SOURCE_SUCCESSOR.hashes[path];
}

export function matchesCurrentImplementationPin(path, bytes) {
  bytes = beforeSpecialistBehaviorSuccessor(path, bytes);
  if (matchesPreflightAdditiveSourceSuccessor(path, bytes)) return true;
  if (matchesGovernanceSourceSuccessor(path, bytes)) return true;
  if (matchesTaskContractAuthorizationSuccessor(path, bytes)) return true;
  return Object.hasOwn(CONTEXT_CONTRACT_PINS.hashes, path)
    && createHash("sha256").update(bytes).digest("hex") === CONTEXT_CONTRACT_PINS.hashes[path];
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

// Skill policy wording successor. The current bytes below are the reviewed wording
// successor of the baseline revision bytes. Historical checks read the baseline
// bytes for these paths only while the current bytes match exactly.
const SKILL_POLICY_WORDING_SUCCESSOR = Object.freeze({
  revision: "skill-policy-wording-successor-r01",
  baselineRevision: "c53ad5947bc5cc6a4e076eb9931e454e300d5c3b",
  authorityEffect: "none",
  hashes: Object.freeze({
    "skills/acceptance-evidence-validator/SKILL.md": "934cc5ef2e5d187c31e2eef086c61ff03b5e76cec50bf82be648eda87e228fda",
    "skills/acceptance-evidence-validator/classification.json": "1fd5e0c18593382cd7114cd110f073fd3a6ee1520e4740f790e6916ec0e34c8a",
    "skills/blocker-diagnostician/classification.json": "adc6f1a1379db237f9a12dee058818a17398555aab7ab2ba0e029b72393dd2a7",
    "skills/blocker-diagnostician/references/entry-details.md": "440ba2e05abdebdb4cb92ffdb310824d32dc0905b1a4c03345c166ecf0f62e32",
    "skills/coordinate-subagents/SKILL.md": "6ba85d995e098afe3cdeb8d20a0b130d383447a5ac6d1781c87e6b52461a7e2e",
    "skills/coordinate-subagents/classification.json": "dacd0c4e2c57c8766a261f7235331055537a9344a9fe09528611810070ea994b",
    "skills/coordinate-subagents/references/delegation-playbook.md": "3215b5e38f7881ddaa5e8262de280642c3560a4236f38e15b3a6fabc176d80aa",
    "skills/coordinate-subagents/references/entry-details.md": "2ace1181d7483e37ecd63e5b80c768ce376504ed9982142f0b519c76a08814df",
    "skills/cs-engineering/SKILL.md": "435939d54f74626d07cbfbedd87fcb1a8e13338bc6c0e46d5233d80a7733d681",
    "skills/cs-engineering/classification.json": "9656b3af5a26f9fb4b5e7e0104d429889a7669e683a61a541b07b88d0d5cf610",
    "skills/independent-audit-gate/SKILL.md": "abb5d4c1fa0607851018cd6f6a2f3ecf314cc829149ea0d15c5474ed9afd2a18",
    "skills/independent-audit-gate/classification.json": "6295cdc92ab7f3fa381023f7d7e363115f212f5dc128d02e90f518ad39142f10",
    "skills/independent-audit-gate/references/audit-protocol.md": "a34c9e5f9d82f5e0257614a119c05ac966bea04ee8fa374c88b010faea549dc4",
    "skills/independent-audit-gate/references/entry-details.md": "0c390f9b8ccb7a3ef01f77dea4f92cec25d785e28b917e7305f76fdb42f05af9",
    "skills/independent-audit-gate/references/orchestrator-integration.md": "3d14b4944f34c5e071cec027dcf483adf6fe5229e1a6ad17ea39202aa17d2fef",
    "skills/independent-deliberation-panel/SKILL.md": "eb21677b0f377116250691a8cf84b44ec853c4de9c56e27ea17585016a151f54",
    "skills/independent-deliberation-panel/classification.json": "71ecafe2dc7eab91bb7ee5ebac230f2b0d3a7e58b9ff15c8cfdc3517a0aa21fd",
    "skills/independent-deliberation-panel/references/evidence-and-verdict-schema.md": "644fe1ead2962af0968ffa06fb248b55fb68d0ba15f229e9b9218e0696653336",
    "skills/mutation-risk-preflight/SKILL.md": "9aa4e7cb143bb0ad9ffc5f6c03ed32331e1f14562cd4322fab0e36cd29c21ce1",
    "skills/mutation-risk-preflight/classification.json": "ddf79c9ba8187a9e6de0af7a88f280372dccbf859a672ea335d16caa45735933",
    "skills/mutation-risk-preflight/references/approval-and-authority.md": "e1cc1396830b49a411cfdb85158f4ee26676db50f65234e82e96257f96e6d613",
    "skills/mutation-risk-preflight/references/entry-details.md": "1630c479078b9df86da6a14cf679c113ed2e4be3c9da2bc4cb5707c1f99c4fba",
    "skills/mutation-risk-preflight/references/risk-matrix.md": "99505f8900e696ec59d2deff835a6c9053bcaf3eb511a4c40ba9a6678a17a079",
    "skills/orchestrator/SKILL.md": "b44340396bf55691bbd5e88d913f660b6aef9cedb3d9e6c27707cef904d68234",
    "skills/orchestrator/classification.json": "b2b53064b8dd5b1e9803fdb24855afe49f3f97cb623365ae0f7affbf28b5c1cc",
    "skills/orchestrator/references/engineering-practices/catalog.json": "9a38110ca195df2dc7d1a3a30b3c9c660cb261125f1968044ce2c5eb639735c7",
    "skills/orchestrator/references/engineering-practices/implementation.md": "e264504b6c866e06067adfc4d5ca2a677939d45df70ffe49e460e0ba85746476",
    "skills/orchestrator/references/entry-details.md": "03cc842a03b82a0a9af42b7c043f556fc0bcdf0a45014646d258c79b29986e9c",
    "skills/orchestrator/references/mcp-execution.md": "4b1d18c8547b489a57ce7b319d73b85919417d21296bc6006264e32d5a75e797",
    "skills/ponytail/SKILL.md": "2ce28db45c1a84e63fa2af7079e58a3803fc26b16ab7073436efd55b1e1214f9",
    "skills/ponytail/classification.json": "add19e4199c76e6dbd9fc128763b4b71da7dd93d3b03f71a7344092132ca1191",
    "skills/task-contract/SKILL.md": "92cf19444e6c97b1d1d017f8eed481135d708095d89411668ab215123d1266aa",
    "skills/task-contract/classification.json": "5fe716cb110508b99b3a113d9b4281c67f266cdd74fa56c2d2259b6ec4322238",
    "skills/task-contract/references/risk-and-authorization-rubric.md": "cb68f324145df13772be3abd6429971afdf85f1385c53bb98e63e3c59c43a254",
  }),
  previousHashes: Object.freeze({
    "skills/acceptance-evidence-validator/SKILL.md": "1ed22041c60ebbb2af76a6a90deca619301aa9d91cef72c3f6bba090e6e4d109",
    "skills/acceptance-evidence-validator/classification.json": "8e5df6db63ddef4b4663df69cf102c66819e6a9c6883ca50681cf62e890e0db1",
    "skills/blocker-diagnostician/classification.json": "76fd1350e10e6f2763b5d25bd66a0af09e59b6e77c3aec8fc24a56049eb179af",
    "skills/blocker-diagnostician/references/entry-details.md": "90d37e3edae634cf0a44260d8c67f8c356db3b1805666757810ae80d27a520dc",
    "skills/coordinate-subagents/SKILL.md": "b8f988f615aa7a2c60abe5c8e1546d7bbf9ce5847ee67aa2be887db3b7d181e0",
    "skills/coordinate-subagents/classification.json": "2fb7b1956b081acd07f6d17a0d17f083426bcf65d27873250e56877c84ec49dc",
    "skills/coordinate-subagents/references/delegation-playbook.md": "a69a4935d3782ce55663e097c670632599249cc5d261a6f323c03df62e86716f",
    "skills/coordinate-subagents/references/entry-details.md": "2a21a37d152cb8854b2a973ed61887bcdd766e16f64a592c4375e1de7df39604",
    "skills/cs-engineering/SKILL.md": "aa5133cba109cb65e867f75e8a6d3a6602c49d72dd4fb5676cab3ddf0e2d0646",
    "skills/cs-engineering/classification.json": "7ae34e15610c902316956642c74ca9b5186a2a7226ff623a3bd92bf0189ec592",
    "skills/independent-audit-gate/SKILL.md": "26086ee54f0d49b1bc861ec27200d26150737d9772773e07139ae59f56404e29",
    "skills/independent-audit-gate/classification.json": "80a4192630678554a8dc2c05221228abcfcaee73ec12ebf54d739fbd03883576",
    "skills/independent-audit-gate/references/audit-protocol.md": "0fc4cb86a3c68cef24c69487e9088bd8c5e07a6f2bff7a120211881d3540c30d",
    "skills/independent-audit-gate/references/entry-details.md": "830d33d1e68e125a52f324652af09096d9d1771124bd7518ec2ae2097fc17e38",
    "skills/independent-audit-gate/references/orchestrator-integration.md": "bb2876718149c148daab12cea59a337dd62eb6b61939e69c6f39d27f04b12dda",
    "skills/independent-deliberation-panel/SKILL.md": "899e5af89ad4621107a33ba101cc63ad7ba6ad4d585438e8cb187c3bfe76c3ab",
    "skills/independent-deliberation-panel/classification.json": "936f167838041d925990c9e853062f531069d64bcbfc95658c2e5399ed6792fe",
    "skills/independent-deliberation-panel/references/evidence-and-verdict-schema.md": "3fe89dbe91f6b9cf944c3187da6c3f7b50f9e1815558a53d4522151edeab291f",
    "skills/mutation-risk-preflight/SKILL.md": "eb02732691b63ca085ff8bca59854a134a8711ac7788888f9f3c6e4324474cbe",
    "skills/mutation-risk-preflight/classification.json": "0487794c38433a3153a5dee86de5ff524c16e84d7ac5f4a41f2ca4ab0328b99f",
    "skills/mutation-risk-preflight/references/approval-and-authority.md": "471afb623db2b67f45465f924eec5426d470dafa0c92bcad14b7bd16d0c16334",
    "skills/mutation-risk-preflight/references/entry-details.md": "13dc04ff9d74e17f2d0bb6d69583a2c502dc5c69766d9a4ed91a59c0c5741154",
    "skills/mutation-risk-preflight/references/risk-matrix.md": "0377275e0487f9823bed76cd3541e0caa5f3bf030ea407fee5ad17b0f761c801",
    "skills/orchestrator/SKILL.md": "b90c19a956f4dd3b239e4f4a527ebea319128dbae239018f8f3b0b5445cc43ac",
    "skills/orchestrator/classification.json": "dbeb13d177c67b8fc9d697931d6fbcf789aec6af6b3d0e412110e8146bb18b1c",
    "skills/orchestrator/references/engineering-practices/catalog.json": "1bd90817d65a175b40cd1adc9b447ada117eca05f4868c90b9e8f96c247ae1c3",
    "skills/orchestrator/references/engineering-practices/implementation.md": "57dc9ffcba25928a0da81e677512f75ad801812ff133a80b9dda3b4030150a4b",
    "skills/orchestrator/references/entry-details.md": "7fdb556e8c6546d819b868cb8084e561507d4e9c850a292f657749c0a09285b3",
    "skills/orchestrator/references/mcp-execution.md": "be972eaa9b6d2ceab78f48f37fcc0eb4e1d4ce52cd8cfb5de356f019da46c546",
    "skills/ponytail/SKILL.md": "907667b8b625eab0438b462a4737a056e3833f972c66e432817a12e6f643ac76",
    "skills/ponytail/classification.json": "19b81d57825cecd7a366b50efb9f220446f5208839b26faee2710af00da3d926",
    "skills/task-contract/SKILL.md": "0482c8aa36c95ddd5b7d68aa5924840341a64bfb05c39c7dcb112c8df1fb4100",
    "skills/task-contract/classification.json": "a0dc1edbc83b0b79b479956f780dbb197db36039d04c15546837946ddd02c213",
    "skills/task-contract/references/risk-and-authorization-rubric.md": "717e1fb27d4ebf7b6481c84e20de018b8461fd7ff277c6434f6f2d52f7cca89e",
  }),
});

function matchesSkillPolicyWordingSuccessor(path, bytes) {
  bytes = beforeSpecialistBehaviorSuccessor(path, bytes);
  const liveGuidance = LIVE_HOST_GUIDANCE_SUCCESSOR.hashes[path];
  if (liveGuidance && createHash("sha256").update(bytes).digest("hex") === liveGuidance[1]) return true;
  // Exact reviewed mid-task successor follows the same pinned historical projection.
  if (matchesOrchestratorSourceSuccessor(path, bytes)) return true;
  return Object.hasOwn(SKILL_POLICY_WORDING_SUCCESSOR.hashes, path)
    && createHash("sha256").update(bytes).digest("hex") === SKILL_POLICY_WORDING_SUCCESSOR.hashes[path];
}

// D0352: 현재 인계·진단 지침만 정확히 결속하고 원 최적화·정책 기준은 보존한다.
const LIVE_HOST_GUIDANCE_SUCCESSOR = Object.freeze({
  baselineRevision: "da970747e70da326bf153c2705bc3d60721c33ee",
  hashes: {
    "skills/blocker-diagnostician/classification.json": ["adc6f1a1379db237f9a12dee058818a17398555aab7ab2ba0e029b72393dd2a7", "3c18e212dfa724027c245ec1692cd39addd12e762cc635f3cb9c5cf09dc73eec"],
    "skills/blocker-diagnostician/references/entry-details.md": ["440ba2e05abdebdb4cb92ffdb310824d32dc0905b1a4c03345c166ecf0f62e32", "ddcfe8425096b30f6c0d0f58900af39e7b8756e2594b35cd596601215ffa3a01"],
    "skills/blocker-diagnostician/references/diagnosis-protocol.md": ["4fffd3c0656ffee3caca1eb072a5f9a3f6a3c91ba7f15644c973c9050c9437c1", "4d7d9e47a2549d2af39565646aa8ce8e7da3c52006367cafb7fc34d243749610"],
    "skills/context-continuity/references/entry-details.md": ["10b186ff6d32f5b2533c7af0e28d27e98d08a8131da2a5954f6ca20fe88f72fe", "3089f69c1a8738e63537ddfbbad0f757fd3d269248c47a42d694d77a7b62e660"],
    "skills/context-continuity/SKILL.md": ["e16840e052c44ee82aaaa758eb666b8f960571cd8c36174fe37e840093bc8022", "99e064693b3f0003f3b391f81f5173b79a28060e7f46ec81081923e75e646f41"],
    "skills/context-continuity/classification.json": ["d2441089650196242dba576e9c11ae791f05fb8955e40b8a2b3cf63f2e09dfc5", "86988758d42dae54f6379a1cf3a3f1e7053dc7510727e2da43a58b3c1f47ee87"],
  },
});

function historicalBytes(path, bytes) {
  bytes = beforeSpecialistBehaviorSuccessor(path, bytes);
  bytes = beforePreflightExpiryRemoval(path, bytes);
  bytes = beforePreflightPlatformEvents(path, bytes);
  if (matchesPreflightPrivatePreparationSuccessor(path, bytes)) {
    bytes = git("show", `${PREFLIGHT_PRIVATE_PREPARATION_SUCCESSOR.baselineRevision}:${path}`);
    if (createHash("sha256").update(bytes).digest("hex") !== PREFLIGHT_PRIVATE_PREPARATION_SUCCESSOR.hashes[path][0]) throw new Error(`Historical preflight private-preparation source differs: ${path}`);
  }
  const guidance = LIVE_HOST_GUIDANCE_SUCCESSOR.hashes[path];
  if (guidance && createHash("sha256").update(bytes).digest("hex") === guidance[1]) {
    bytes = git("show", `${LIVE_HOST_GUIDANCE_SUCCESSOR.baselineRevision}:${path}`);
    if (createHash("sha256").update(bytes).digest("hex") !== guidance[0]) throw new Error(`Historical live host guidance differs: ${path}`);
  }
  if (!matchesSkillPolicyWordingSuccessor(path, bytes)) return bytes;
  const original = git("show", `${SKILL_POLICY_WORDING_SUCCESSOR.baselineRevision}:${path}`);
  if (createHash("sha256").update(original).digest("hex") !== SKILL_POLICY_WORDING_SUCCESSOR.previousHashes[path]) throw new Error(`Historical skill policy wording source differs: ${path}`);
  return original;
}

function readHistorical(root, ...parts) {
  const bytes = readFileSync(join(root, ...parts));
  return root === ROOT ? historicalBytes(parts.join("/").replaceAll("\\", "/"), bytes) : bytes;
}

/** Test hook: tracked bytes as the historical checks see them. */
export function readHistoricalSource(relative) {
  return readHistorical(ROOT, relative);
}

/** Test hook: whether the bytes are the reviewed skill policy wording successor. */
export function matchesSkillPolicyWordingSuccessorBytes(path, bytes) {
  bytes = beforeReviewedSuccessors(path, bytes);
  return matchesSkillPolicyWordingSuccessor(path, bytes)
    || (Object.hasOwn(SKILL_POLICY_WORDING_SUCCESSOR.hashes, path) && matchesPreflightPrivatePreparationChain(path, bytes));
}

function historicalChanges(paths) {
  return paths.filter((path) => {
    if (!Object.hasOwn(SKILL_POLICY_WORDING_SUCCESSOR.hashes, path)) return true;
    let bytes;
    try { bytes = readFileSync(join(ROOT, ...path.split("/"))); } catch { return true; }
    if (!matchesSkillPolicyWordingSuccessor(path, bytes)) return true;
    return changedBetween(BASELINE, SKILL_POLICY_WORDING_SUCCESSOR.baselineRevision, path);
  });
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
  if (matchesGovernanceSourceSuccessor(`skills/${skillId}/README.md`, Buffer.from(candidate))) return true;
  const minimum = NODE24_README_MINIMUMS[skillId];
  return Boolean(minimum) && baseline.split(minimum).length === 2
    && candidate === baseline.replace(minimum, "Node.js 24.0.0 이상");
}

export function matchesOrchestratorIntakeUpdate(kind, bytes) {
  return Object.hasOwn(ORCHESTRATOR_INTAKE.hashes, kind)
    && createHash("sha256").update(bytes).digest("hex") === ORCHESTRATOR_INTAKE.hashes[kind];
}

// 현재 CLI 지문은 문구의 역사 투영에 포함하지 않는다.
function matchesArtifactScopeCliSource(path, bytes) {
  return path === "skills/orchestrator/references/engineering-practices/cli.md"
    && createHash("sha256").update(bytes).digest("hex") === "c23134f4ebce972f891e7b7bf93f9ac24a5c340e856e3f1192e58fb33aff3b2b";
}

export function matchesEngineeringReferenceUpdate(name, bytes) {
  const reviewedPath = `skills/orchestrator/references/engineering-practices/${name}`;
  bytes = beforeSpecialistBehaviorSuccessor(reviewedPath, bytes);
  if (matchesArtifactScopeCliSource(reviewedPath, bytes)) return true;
  if (matchesGovernanceSourceSuccessor(reviewedPath, bytes)) return true;
  if (Object.hasOwn(REVIEWED_IMPLEMENTATION_R1.hashes, reviewedPath)) {
    return matchesReviewedImplementationUpdate(reviewedPath, bytes);
  }
  return Object.hasOwn(ENGINEERING_REFERENCES, name)
    && createHash("sha256").update(bytes).digest("hex") === ENGINEERING_REFERENCES[name];
}

export function matchesReviewedImplementationUpdate(path, bytes) {
  bytes = beforeSpecialistBehaviorSuccessor(path, bytes);
  if (matchesArtifactScopeCliSource(path, bytes)) return true;
  if (matchesGovernanceSourceSuccessor(path, bytes)) return true;
  const reviewed = Object.hasOwn(REVIEWED_IMPLEMENTATION_R2.hashes, path) ? REVIEWED_IMPLEMENTATION_R2 : REVIEWED_IMPLEMENTATION_R1;
  return Object.hasOwn(reviewed.hashes, path)
    && createHash("sha256").update(bytes).digest("hex") === reviewed.hashes[path];
}

export function matchesClassificationUpdate(path, bytes) {
  bytes = beforeSpecialistBehaviorSuccessor(path, bytes);
  if (matchesHostConsumptionSourceSuccessor(path, bytes)) return true;
  if (matchesGovernanceSourceSuccessor(path, bytes)) return true;
  return matchesPonytailPolicySuccessor(path, bytes) || Object.hasOwn(CLASSIFICATION_UPDATE.hashes, path)
    && createHash("sha256").update(bytes).digest("hex") === CLASSIFICATION_UPDATE.hashes[path];
}

function withoutClassificationAddition(skillId, bytes, root = ROOT) {
  const currentPath = `skills/${skillId}/SKILL.md`;
  if (matchesPonytailPolicySuccessor(currentPath, bytes)) bytes = git("show", `${PONYTAIL_POLICY_SUCCESSOR.baselineRevision}:${currentPath}`);
  const frozen = CLASSIFICATION_UPDATE.additions[skillId];
  const fixture = readHistorical(root, frozen.path);
  const addition = Buffer.concat([fixture, Buffer.from(frozen.suffix ?? "")]);
  const index = bytes.indexOf(addition);
  if (fixture.length !== (frozen.fixtureBytes ?? frozen.bytes) || addition.length !== frozen.bytes || createHash("sha256").update(fixture).digest("hex") !== frozen.sha256
    || index < 0 || bytes.indexOf(addition, index + addition.length) >= 0) {
    throw new Error(`${skillId}: pinned 2.9.1 classification addition differs`);
  }
  return Buffer.concat([bytes.subarray(0, index), bytes.subarray(index + addition.length)]);
}

export function reconstructOptimizedSkill(skillId, root = ROOT) {
  const bytes = beforeGovernanceSuccessor(`skills/${skillId}/SKILL.md`, readHistorical(root, "skills", skillId, "SKILL.md"));
  const candidate = skillId === "orchestrator" ? withoutClassificationAddition(skillId, bytes, root) : bytes;
  let detail = beforeGovernanceSuccessor(`skills/${skillId}/references/entry-details.md`, readHistorical(root, "skills", skillId, "references", "entry-details.md"));
  if (skillId === "orchestrator") {
    const engineeringAddition = readHistorical(root, ENGINEERING_ADDITION);
    if (createHash("sha256").update(engineeringAddition).digest("hex") !== ENGINEERING_ADDITION_SHA256
      || !detail.subarray(-engineeringAddition.length).equals(engineeringAddition)) {
      throw new Error("orchestrator: pinned 2.8.1 Engineering Practices addition differs");
    }
    detail = detail.subarray(0, detail.length - engineeringAddition.length);
    const addition = readHistorical(root, CS_HANDOFF_ADDITION);
    if (createHash("sha256").update(addition).digest("hex") !== CS_HANDOFF_SHA256
      || !detail.subarray(-addition.length).equals(addition)) {
      throw new Error("orchestrator: pinned 2.8.0 CS handoff addition differs");
    }
    detail = detail.subarray(0, detail.length - addition.length);
  }
  if (skillId === "task-contract" && matchesTaskContractAuthorizationSuccessor("skills/task-contract/references/entry-details.md", detail)) {
    detail = git("show", `${TASK_CONTRACT_AUTHORIZATION_SUCCESSOR.baselineRevision}:skills/task-contract/references/entry-details.md`);
    if (createHash("sha256").update(detail).digest("hex") !== TASK_CONTRACT_AUTHORIZATION_SUCCESSOR.previousEntryDetailSha256) {
      throw new Error("task-contract: historical entry-details bytes differ");
    }
  }
  const baselineRelativeDetail = Buffer.from(detail.toString("utf8").replace(/\]\((?![A-Za-z][A-Za-z0-9+.-]*:|#|\/)([^)\s]+)\)/gu, (_match, target) => `](${posix.normalize(posix.join("references", target))})`));
  const markerIndex = candidate.indexOf(NAVIGATION);
  if (markerIndex < 0) throw new Error(`${skillId}: navigation marker is missing`);
  const suffix = NO_SEPARATOR_SUFFIX.has(skillId) ? Buffer.alloc(0) : Buffer.from("\n");
  return Buffer.concat([candidate.subarray(0, markerIndex), baselineRelativeDetail, suffix, candidate.subarray(markerIndex + NAVIGATION.length)]);
}

// Independent review points: these literal security contracts do not come from
// registry-contract.3.0.json. Expand them only with separately reviewed policy.
export class RegistryAuthorityViolation extends Error {
  constructor(code) { super(code); this.code = code; }
}

function rule(code, check) {
  try { check(); }
  catch (error) {
    if (error instanceof assert.AssertionError) throw new RegistryAuthorityViolation(code);
    throw error;
  }
}

export function assertRegistryAuthority(registry) {
  const ids = registry.skills.map((skill) => skill.skillId);
  rule("REGISTRY_DUPLICATE_ID", () => assert.equal(new Set(ids).size, ids.length, "duplicate skill ID"));
  const one = (id, label) => {
    const matches = registry.skills.filter((skill) => skill.skillId === id);
    rule(`${label}_DESCRIPTOR_COUNT`, () => assert.equal(matches.length, 1, `${id}: missing or duplicate`));
    rule(`${label}_DESCRIPTOR_ENABLED`, () => assert.equal(matches[0].enabled, true, `${id}: disabled`));
    rule(`${label}_DESCRIPTOR_PROVIDERS`, () => assert.equal(matches[0].providers.length, 1, `${id}: provider count`));
    return matches[0].providers[0];
  };
  const solid = one("solid-design", "SOLID");
  rule("SOLID_EXECUTION", () => assert.equal(solid.executionClass, "bootstrap"));
  rule("SOLID_PHASE", () => assert.equal(solid.phase, "solid-design-assessment"));
  rule("SOLID_PHASE_ORDER", () => assert.equal(solid.phaseOrder, 26));
  rule("SOLID_CAPABILITIES", () => assert.deepEqual(solid.capabilities, ["solid-design-assessment"]));
  rule("SOLID_GATE", () => assert.deepEqual(solid.gate, {kind: "none", policy: "none", validator: null}));
  rule("SOLID_BINDINGS", () => assert.deepEqual(solid.inputBindings, [{targetArtifact: "solid-design-request", sources: ["task:solid-design-request"], operation: "require-external"}]));
  rule("SOLID_OUTPUT_SCHEMA", () => assert.equal(solid.outputSchema, "skills/solid-design/contracts/solid-design-report.v1.schema.json"));
  rule("SOLID_RESULT_SCHEMA", () => assert.equal(solid.resultSchema, "contracts/provider-result.v1.schema.json"));
  rule("SOLID_CAPABILITY_OWNER", () => assert.equal(registry.skills.flatMap((skill) => skill.providers).filter((provider) => provider.capabilities.includes("solid-design-assessment")).length, 1, "ambiguous SOLID capability"));
  const panel = one("independent-deliberation-panel", "PANEL");
  rule("PANEL_EXECUTION", () => assert.equal(panel.executionClass, "workflow"));
  rule("PANEL_PHASE", () => assert.equal(panel.phase, "decision-analysis"));
  rule("PANEL_GATE", () => assert.deepEqual(panel.gate, {kind: "none", policy: "none", validator: "skills/independent-deliberation-panel/contracts/decision-record.v1.schema.json"}));
  rule("PANEL_BINDINGS", () => assert.deepEqual(panel.inputBindings.filter((binding) => binding.targetArtifact === "constraints"), [{
    targetArtifact: "constraints", sources: ["task-envelope:constraints", "task-envelope:authorization"], operation: "combine",
  }]));
  const audit = one("independent-audit-gate", "AUDIT");
  const auditSkill = registry.skills.find((skill) => skill.skillId === "independent-audit-gate");
  rule("AUDIT_PRIORITY", () => assert.equal(auditSkill.priority, 90, "audit priority"));
  rule("AUDIT_CAPABILITIES", () => assert.deepEqual(audit.capabilities, ["independent-audit", "risk-classification", "evidence-verification", "release-gate"]));
  rule("AUDIT_CAPABILITY_OWNER", () => assert(!registry.skills.some((skill) => skill.enabled && skill.skillId !== "independent-audit-gate" && skill.priority >= auditSkill.priority && skill.providers.some((provider) => provider.capabilities.includes("independent-audit"))), "audit capability outranked"));
  rule("AUDIT_EXECUTION", () => assert.equal(audit.executionClass, "workflow"));
  rule("AUDIT_PHASE", () => assert.equal(audit.phase, "completion-gate"));
  rule("AUDIT_GATE", () => assert.deepEqual(audit.gate, {kind: "completion", policy: "mandatory", validator: "independent-audit"}));
  rule("AUDIT_VERDICT", () => assert(audit.producedArtifacts.includes("gate-verdict"), "audit verdict missing"));
  rule("AUDIT_REQUIRED_INPUTS", () => assert.deepEqual(audit.requiredInputArtifacts, ["final-target-identifier", "final-diff-or-artifact-digest", "raw-verification-results", "rollback-or-recovery-evidence"]));
  rule("AUDIT_BINDINGS", () => assert.deepEqual(audit.inputBindings, [
    {targetArtifact: "final-target-identifier", sources: ["acceptance-evidence-report:target", "workflow:current-target"], operation: "select"},
    {targetArtifact: "final-diff-or-artifact-digest", sources: ["acceptance-evidence-report:target-digest", "change-scope-report:final-digest"], operation: "combine"},
    {targetArtifact: "raw-verification-results", sources: ["verified-evidence-index:locators"], operation: "collect"},
    {targetArtifact: "rollback-or-recovery-evidence", sources: ["recovery-evidence", "workflow:rollback-evidence"], operation: "require-external"},
  ]));
  rule("AUDIT_OUTPUT_SCHEMA", () => assert.equal(audit.outputSchema, "contracts/freeform-output.v1.schema.json"));
  rule("AUDIT_RESULT_SCHEMA", () => assert.equal(audit.resultSchema, "contracts/provider-result.v1.schema.json"));
  rule("AUDIT_STATE_MAPPING", () => assert.deepEqual(audit.stateMapping, {
    selector: "/output/gateVerdict",
    values: {
      PASS: {state: "passed", errorRequired: false},
      FAIL: {state: "failed", errorRequired: true, allowedErrorCodes: ["GATE_FAILED"]},
      BLOCKED: {state: "blocked", errorRequired: true, allowedErrorCodes: ["MISSING_EVIDENCE"]},
    },
    default: "reject", adapterErrors: ["INVALID_INPUT", "MISSING_EVIDENCE"],
  }));
  const preflight = one("mutation-risk-preflight", "PREFLIGHT");
  rule("PREFLIGHT_GATE", () => assert.deepEqual(preflight.gate, {kind: "precondition", policy: "conditional", validator: "skills/mutation-risk-preflight/contracts/mutation-preflight-report.v1.schema.json"}));
  rule("PREFLIGHT_BINDINGS", () => assert.deepEqual(preflight.inputBindings.filter((binding) => binding.targetArtifact === "authorization-boundary"), [{
    targetArtifact: "authorization-boundary", sources: ["bootstrap:task-envelope.authorization", "mutation-intent.authorizationRef"], operation: "combine",
  }]));
}

export function checkRegistryContextCompatibility(registry) {
  // Preserve the 3.0 fixture. Apply only the explicitly approved live removal and purpose change;
  // unrelated descriptors, order, authority, bindings and gate semantics still match exactly.
  const expected = JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/registry-contract.3.0.json"), "utf8"));
  expected.skills = expected.skills.filter(skill => skill.skillId !== "codex-token-usage-analyzer");
  // AGS3-D-0007: the CS review provider declares the stage validator core runs; core no longer names the skill's script.
  const csReview = expected.skills.find(skill => skill.skillId === "cs-engineering")?.providers
    .find(provider => provider.capabilities.includes("cs-implementation-review"));
  if (csReview) csReview.stageValidator = "skills/cs-engineering/scripts/validate.mjs";
  const advisor = registry.skills.filter(skill => skill.skillId === "model-effort-advisor");
  const errors = [];
  if (advisor.length === 1 && contextDigest(Buffer.from(JSON.stringify(advisor[0]))) === PURPOSE_CHANGE_SUCCESSOR.registryDescriptorSha256) {
    expected.skills[expected.skills.findIndex(skill => skill.skillId === "model-effort-advisor")] = advisor[0];
  } else errors.push("purpose change registry descriptor differs: model-effort-advisor");
  if (registry.skills.some(skill => skill.skillId === "codex-token-usage-analyzer")) errors.push("retired skill registry descriptor present: codex-token-usage-analyzer");
  if (!isDeepStrictEqual(registry, expected)) errors.push("registry differs from the 3.0 contract");
  try { assertRegistryAuthority(registry); }
  catch (error) {
    if (!(error instanceof RegistryAuthorityViolation)) throw error;
    errors.push("registry violates independent authority invariants", `registry authority violation: ${error.code}`);
  }
  return errors;
}

export function checkSkillContextOptimization() {
  const purposeChange = checkPurposeChangeSources();
  const behaviorSources = checkSpecialistBehaviorSources();
  const errors = [...purposeChange.errors, ...behaviorSources.errors, ...checkRetiredSkills()];
  for (const currentPath of Object.keys(PREFLIGHT_PLATFORM_EVENTS_SUCCESSOR.hashes)) {
    if (!matchesPreflightPlatformEventsChain(currentPath, readFileSync(join(ROOT, currentPath)))) errors.push(`preflight platform-events successor bytes differ: ${currentPath}`);
  }
  for (const currentPath of Object.keys(PREFLIGHT_EXPIRY_REMOVAL_SUCCESSOR.hashes)) {
    if (!matchesPreflightExpiryRemovalSuccessor(currentPath, readFileSync(join(ROOT, currentPath)))) errors.push(`preflight expiry-removal successor bytes differ: ${currentPath}`);
  }
  for (const currentPath of Object.keys(PREFLIGHT_PRIVATE_PREPARATION_SUCCESSOR.hashes)) {
    if (!matchesPreflightPrivatePreparationChain(currentPath, readFileSync(join(ROOT, currentPath)))) errors.push(`preflight private-preparation successor bytes differ: ${currentPath}`);
  }
  for (const [currentPath, hashes] of Object.entries(LIVE_HOST_GUIDANCE_SUCCESSOR.hashes)) {
    if (createHash("sha256").update(readBeforeSpecialistBehavior(ROOT, currentPath)).digest("hex") !== hashes[1]) {
      errors.push(`live host guidance successor bytes differ: ${currentPath}`);
    }
  }
  for (const [currentPath, expectedHash] of Object.entries(TASK_CONTRACT_ROUTING_SOURCE_HASHES)) {
    if (createHash("sha256").update(readBeforeSpecialistBehavior(ROOT, currentPath)).digest("hex") !== expectedHash) {
      errors.push(`task-contract routing source differs: ${currentPath}`);
    }
  }
  for (const [currentPath, expectedHash] of Object.entries(ORCHESTRATOR_LEASE_EXPIRY_REMOVAL_SOURCE_HASHES)) {
    if (createHash("sha256").update(readBeforeSpecialistBehavior(ROOT, currentPath)).digest("hex") !== expectedHash) {
      errors.push(`orchestrator lease expiry-removal source differs: ${currentPath}`);
    }
  }
  for (const successorPath of Object.keys(SKILL_POLICY_WORDING_SUCCESSOR.hashes)) {
    const bytes = readFileSync(join(ROOT, successorPath));
    if (!matchesPreflightPrivatePreparationChain(successorPath, bytes) && !matchesSkillPolicyWordingSuccessor(successorPath, bytes)) errors.push(`skill policy wording successor bytes differ: ${successorPath}`);
  }
  for (const reviewedPath of Object.keys(CLASSIFICATION_UPDATE.hashes)) {
    if (!matchesClassificationUpdate(reviewedPath, readHistorical(ROOT, reviewedPath))) errors.push(`classification: reviewed bytes differ: ${reviewedPath}`);
  }
  for (const currentPath of Object.keys(PONYTAIL_POLICY_SUCCESSOR.hashes)) {
    if (!matchesPonytailPolicySuccessor(currentPath, readHistorical(ROOT, currentPath))) errors.push(`policy successor bytes differ: ${currentPath}`);
  }
  for (const currentPath of Object.keys(CONTEXT_CONTRACT_PINS.hashes)) {
    if (!matchesCurrentImplementationPin(currentPath, readHistorical(ROOT, currentPath))) {
      errors.push(`current implementation bytes differ: ${currentPath}`);
    }
  }
  for (const currentPath of Object.keys(PREFLIGHT_ADDITIVE_SOURCE_SUCCESSOR.hashes)) {
    if (!matchesPreflightAdditiveSourceSuccessor(currentPath, readHistorical(ROOT, currentPath))) {
      errors.push(`preflight additive successor bytes differ: ${currentPath}`);
    }
  }
  for (const currentPath of Object.keys(TASK_CONTRACT_AUTHORIZATION_SUCCESSOR.hashes)) {
    if (!matchesTaskContractAuthorizationSuccessor(currentPath, readHistorical(ROOT, currentPath))) {
      errors.push(`task-contract authorization successor bytes differ: ${currentPath}`);
    }
  }
  for (const currentPath of Object.keys(GOVERNANCE_SOURCE_SUCCESSOR.hashes)) {
    if (!matchesGovernanceSourceSuccessor(currentPath, readHistorical(ROOT, currentPath))) {
      errors.push(`governance source successor bytes differ: ${currentPath}`);
    }
  }
  for (const currentPath of Object.keys(HOST_CONSUMPTION_SOURCE_SUCCESSOR.hashes)) {
    if (!matchesHostConsumptionSourceSuccessor(currentPath, readHistorical(ROOT, currentPath))) errors.push(`host consumption successor bytes differ: ${currentPath}`);
  }
  const detailOwners = skillDirectoryNames()
    .filter((skillId) => {
      try {
        readHistorical(ROOT, "skills", skillId, "references", "entry-details.md");
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
    const candidate = readHistorical(ROOT, ...skillPath.split("/"));
    const markerIndex = candidate.indexOf(NAVIGATION);
    const markerCount = candidate.toString("utf8").split("<!-- optimization-navigation:start").length - 1;
    const reconstructed = markerIndex < 0 ? Buffer.alloc(0) : reconstructOptimizedSkill(skillId);

    if (markerCount !== 1 || markerIndex < 0) errors.push(`${skillId}: navigation marker must occur exactly once`);
    let expectedBaseline = baseline;
    if (skillId === "session-board") {
      const addition = readHistorical(ROOT, SESSION_BOARD_ADDITION);
      if (createHash("sha256").update(addition).digest("hex") !== SESSION_BOARD_ADDITION_SHA256) errors.push("session-board: approved 2.6.0 guidance fixture changed");
      expectedBaseline = Buffer.concat([baseline, addition]);
    }
    if (skillId === "orchestrator") {
      if (!matchesOrchestratorIntakeUpdate("reconstructed", reconstructed)) errors.push("orchestrator: reconstructed intake policy differs from the pinned revision");
      if (!matchesOrchestratorIntakeUpdate("frontmatter", frontmatter(candidate))) errors.push("orchestrator: intake frontmatter differs from the pinned revision");
      if (withoutClassificationAddition(skillId, candidate).length > ORCHESTRATOR_INTAKE.initialMaxBytes) errors.push("orchestrator: historical initial load exceeds the pre-intake limit");
      const reference = readHistorical(ROOT, "skills/orchestrator/references/mcp-execution.md");
      if (!matchesOrchestratorIntakeUpdate("mcpExecution", reference)) errors.push("orchestrator: MCP execution policy differs from the pinned revision");
    } else if (skillId === "model-effort-advisor") {
      for (const approvedPath of [skillPath, detailPath]) {
        if (!matchesReviewedImplementationUpdate(approvedPath, readHistorical(ROOT, approvedPath))) {
          errors.push(`model-effort-advisor: reviewed implementation bytes differ: ${approvedPath}`);
        }
      }
      if (createHash("sha256").update(reconstructed).digest("hex") !== REVIEWED_IMPLEMENTATION_R2.modelReconstructedSha256) {
        errors.push("model-effort-advisor: reconstructed reviewed implementation differs");
      }
      // Preserve the historical optimization cap; exact current successor bytes are checked separately.
      if (beforeGovernanceSuccessor(skillPath, candidate).length > REVIEWED_IMPLEMENTATION_R1.modelInitialMaxBytes) errors.push("model-effort-advisor: initial load exceeds its reviewed limit");
      if (!frontmatter(candidate).equals(frontmatter(baseline))) errors.push("model-effort-advisor: frontmatter changed");
    } else if (skillId === "instruction-scope-resolver") {
      for (const [reviewedPath, sha256] of Object.entries(REVIEWED_RESOLVER_N_DESC_RULE.hashes)) {
        if (createHash("sha256").update(readHistorical(ROOT, reviewedPath)).digest("hex") !== sha256) {
          errors.push(`instruction-scope-resolver: reviewed output-contract bytes differ: ${reviewedPath}`);
        }
      }
      if (createHash("sha256").update(reconstructed).digest("hex") !== REVIEWED_RESOLVER_N_DESC_RULE.reconstructedSha256) {
        errors.push("instruction-scope-resolver: reconstructed reviewed output contract differs");
      }
      if (!frontmatter(candidate).equals(frontmatter(baseline))) errors.push("instruction-scope-resolver: frontmatter changed");
    } else {
      if (!reconstructed.equals(expectedBaseline)) errors.push(`${skillId}: SKILL.md plus entry-details.md does not reconstruct the baseline byte-for-byte`);
      if (!frontmatter(beforeGovernanceSuccessor(skillPath, candidate)).equals(frontmatter(baseline))) errors.push(`${skillId}: frontmatter changed`);
    }
    if (candidate.length >= baseline.length) errors.push(`${skillId}: initial SKILL.md did not shrink`);

    const descriptorPath = `skills/${skillId}/agents/openai.yaml`;
    if (!readHistorical(ROOT, ...descriptorPath.split("/")).equals(baselineFile(descriptorPath))) errors.push(`${skillId}: agents/openai.yaml changed`);

    const allowed = new Set([skillPath, detailPath]);
    for (const currentPath of [...Object.keys(SPECIALIST_BEHAVIOR_SUCCESSOR.hashes), ...Object.keys(SPECIALIST_BEHAVIOR_SUCCESSOR.additions)]) {
      if (currentPath.startsWith(`skills/${skillId}/`)) allowed.add(currentPath);
    }
    for (const currentPath of Object.keys(PREFLIGHT_PRIVATE_PREPARATION_SUCCESSOR.hashes)) if (currentPath.startsWith(`skills/${skillId}/`)) allowed.add(currentPath);
    for (const currentPath of Object.keys(PREFLIGHT_ADDITIVE_SOURCE_SUCCESSOR.hashes)) if (currentPath.startsWith(`skills/${skillId}/`)) allowed.add(currentPath);
    for (const currentPath of Object.keys(GOVERNANCE_SOURCE_SUCCESSOR.hashes)) if (currentPath.startsWith(`skills/${skillId}/`)) allowed.add(currentPath);
    // A reference first changed by a reviewed guidance successor is allowed only while it holds that successor's bytes.
    for (const { hashes } of GUIDANCE_SUCCESSORS) {
      for (const [currentPath, [, successor]] of Object.entries(hashes)) {
        if (!currentPath.startsWith(`skills/${skillId}/`)) continue;
        let bytes;
        // A missing reference is not allowed here; the checks that pin it report it as missing.
        try { bytes = readFileBytes(join(ROOT, ...currentPath.split("/"))); }
        catch (error) { if (error?.code === "ENOENT") continue; throw error; }
        if (createHash("sha256").update(bytes).digest("hex") === successor) allowed.add(currentPath);
      }
    }
    for (const currentPath of Object.keys(CONTEXT_CONTRACT_PINS.hashes)) {
      if (currentPath.startsWith(`skills/${skillId}/`)) allowed.add(currentPath);
    }
    for (const currentPath of Object.keys(GUIDANCE_ADDITIONS)) {
      if (currentPath.startsWith(`skills/${skillId}/`) && isReviewedGuidanceAddition(currentPath)) allowed.add(currentPath);
    }
    for (const reviewedPath of Object.keys(CLASSIFICATION_UPDATE.hashes)) if (reviewedPath.startsWith(`skills/${skillId}/`)) allowed.add(reviewedPath);
    for (const currentPath of Object.keys(TASK_CONTRACT_AUTHORIZATION_SUCCESSOR.hashes)) if (currentPath.startsWith(`skills/${skillId}/`)) allowed.add(currentPath);
    for (const currentPath of Object.keys(TASK_CONTRACT_ROUTING_SOURCE_HASHES)) if (currentPath.startsWith(`skills/${skillId}/`)) allowed.add(currentPath);
    for (const currentPath of Object.keys(ORCHESTRATOR_LEASE_EXPIRY_REMOVAL_SOURCE_HASHES)) if (currentPath.startsWith(`skills/${skillId}/`)) allowed.add(currentPath);
    if (skillId === "session-board") {
      for (const reviewedPath of ["skills/session-board/scripts/board-store.d.mts"]) {
        if (!matchesReviewedImplementationUpdate(reviewedPath, readHistorical(ROOT, reviewedPath))) {
          errors.push(`session-board: reviewed implementation bytes differ: ${reviewedPath}`);
        }
        allowed.add(reviewedPath);
      }
    }
    if (skillId === "model-effort-advisor") allowed.add("skills/model-effort-advisor/scripts/support-guard.mjs");
    for (const movedPath of Object.keys(MOVED_TO_CORE)) if (movedPath.startsWith(`skills/${skillId}/`) && movedToCore(movedPath)) allowed.add(movedPath);
    if (skillId === "orchestrator") {
      allowed.add("skills/orchestrator/references/mcp-execution.md");
      for (const name of Object.keys(ENGINEERING_REFERENCES)) {
        const referencePath = `skills/orchestrator/references/engineering-practices/${name}`;
        if (!matchesEngineeringReferenceUpdate(name, readHistorical(ROOT, referencePath))) {
          errors.push(`orchestrator: pinned engineering reference differs: ${name}`);
        }
        allowed.add(referencePath);
      }
    }
    if (README_CHANGES.has(skillId)) allowed.add(`skills/${skillId}/README.md`);
    if (Object.hasOwn(NODE24_README_MINIMUMS, skillId)) {
      const readmePath = `skills/${skillId}/README.md`;
      const baselineReadme = baselineFile(readmePath).toString("utf8").replaceAll("\r\n", "\n");
      const candidateReadme = readHistorical(ROOT, readmePath).toString("utf8").replaceAll("\r\n", "\n");
      if (!matchesNode24ReadmeUpdate(skillId, baselineReadme, candidateReadme)) errors.push(`${skillId}: README.md differs beyond the Node 24 minimum update`);
      allowed.add(readmePath);
    }
    const changed = git("diff", "--name-only", BASELINE, "--", `skills/${skillId}`).toString("utf8").trim().split(/\r?\n/u).filter(Boolean);
    changed.push(...git("ls-files", "--others", "--exclude-standard", "--", `skills/${skillId}`)
      .toString("utf8").trim().split(/\r?\n/u).filter(Boolean));
    const unexpected = historicalChanges(projectRetiredChanges(BASELINE, [...new Set(changed)]).filter(path => !EXECUTABLE_SCRIPT.test(path))).filter((path) => !allowed.has(path));
    if (unexpected.length) errors.push(`${skillId}: unexpected skill-owned changes: ${unexpected.join(", ")}`);

    baselineBytes += baseline.length;
    candidateBytes += candidate.length;
    skills.push({ skillId, baselineBytes: baseline.length, candidateBytes: candidate.length, reducedBytes: baseline.length - candidate.length });
  }

  const registry = JSON.parse(readFileSync(join(ROOT, "skills", "registry.json"), "utf8"));
  errors.push(...checkRegistryContextCompatibility(registry));
  const ponytail = readHistorical(ROOT, "skills/ponytail/SKILL.md");
  if (!withoutClassificationAddition("ponytail", ponytail).equals(baselineFile("skills/ponytail/SKILL.md"))) errors.push("excluded skill ponytail historical instructions changed");
  const ponytailChanged = [...new Set([
    ...git("diff", "--name-only", BASELINE, "--", "skills/ponytail").toString("utf8").trim().split(/\r?\n/u),
    ...git("ls-files", "--others", "--exclude-standard", "--", "skills/ponytail").toString("utf8").trim().split(/\r?\n/u),
  ].filter(Boolean))].filter((file) => !Object.hasOwn(CLASSIFICATION_UPDATE.hashes, file) && !Object.hasOwn(PONYTAIL_POLICY_SUCCESSOR.hashes, file)
    && !Object.hasOwn(SPECIALIST_BEHAVIOR_SUCCESSOR.hashes, file) && !Object.hasOwn(SPECIALIST_BEHAVIOR_SUCCESSOR.additions, file));
  ponytailChanged.splice(0, ponytailChanged.length, ...historicalChanges(ponytailChanged));
  if (ponytailChanged.length) errors.push(`excluded skill ponytail unexpected changes: ${ponytailChanged.join(", ")}`);
  if (candidateBytes >= baselineBytes) errors.push("combined initial SKILL.md bytes did not shrink");

  return {
    baselineRevision: BASELINE,
    currentSpecialistBehaviorSuccessors: [SPECIALIST_BEHAVIOR_SUCCESSOR],
    currentSpecialistBehavior: behaviorSources,
    retiredSkills: RETIREMENTS,
    currentPurposeChange: purposeChange,
    currentHostConsumptionSourceSuccessors: [HOST_CONSUMPTION_SOURCE_SUCCESSOR],
    currentPreflightPrivatePreparationSuccessors: [PREFLIGHT_PRIVATE_PREPARATION_SUCCESSOR],
    currentPreflightPlatformEventsSuccessors: [PREFLIGHT_PLATFORM_EVENTS_SUCCESSOR],
    currentPreflightExpiryRemovalSuccessors: [PREFLIGHT_EXPIRY_REMOVAL_SUCCESSOR],
    currentPreflightAdditiveSourceSuccessors: [PREFLIGHT_ADDITIVE_SOURCE_SUCCESSOR],
    approvedAdditions: [{ skillId: "session-board", path: SESSION_BOARD_ADDITION, sha256: SESSION_BOARD_ADDITION_SHA256 }],
    policyBaselineUpdates: [{ skillId: "orchestrator", ...ORCHESTRATOR_INTAKE }],
    reviewedImplementationUpdates: [REVIEWED_IMPLEMENTATION_R1],
    activeReviewedImplementationUpdates: [REVIEWED_IMPLEMENTATION_R2],
    reviewedOutputContractUpdates: [REVIEWED_RESOLVER_OUTPUT_CONTRACT],
    activeReviewedOutputContractUpdates: [REVIEWED_RESOLVER_N_DESC_RULE],
    reviewedClassificationUpdates: [CLASSIFICATION_UPDATE],
    contextContractPins: [CONTEXT_CONTRACT_PINS],
    scope: "skill-context-only",
    authorityEffect: "none",
    currentPolicySuccessors: [PONYTAIL_POLICY_SUCCESSOR],
    currentAuthorizationPolicySuccessors: [TASK_CONTRACT_AUTHORIZATION_SUCCESSOR],
    currentGovernanceSourceSuccessors: [GOVERNANCE_SOURCE_SUCCESSOR],
    runtimeBaselineUpdates: Object.entries(NODE24_README_MINIMUMS).map(([skillId, before]) => ({ skillId, before, after: "Node.js 24.0.0 이상" })),
    currentSkillPolicyWordingSuccessors: [SKILL_POLICY_WORDING_SUCCESSOR],
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
