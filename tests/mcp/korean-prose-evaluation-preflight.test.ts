import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  preflightKoreanProseEvaluation,
} from "../../scripts/korean-prose-evaluation-preflight.js";
import { resolveEvaluationLayout } from "../../scripts/korean-prose-readiness.js";

const temporaryDirectories: string[] = [];
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const recorderPath = path.resolve(import.meta.dirname, "../../scripts/record-korean-prose-run.ts");
const selectorActor = "30000000-0000-4000-8000-000000000001";
const editorActor = "30000000-0000-4000-8000-000000000002";
const verifierActor = "30000000-0000-4000-8000-000000000003";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Korean prose evaluation preflight", () => {
  it("requires every frozen model phase to pass the repository preflight", async () => {
    const [entry, detail, integration] = await Promise.all([
      readFile(new URL("../../skills/korean-prose-editor/SKILL.md", import.meta.url), "utf8"),
      readFile(new URL("../../skills/korean-prose-editor/references/entry-details.md", import.meta.url), "utf8"),
      readFile(new URL("../../skills/korean-prose-editor/references/integration.md", import.meta.url), "utf8"),
    ]);
    const skill = `${entry}\n${detail}`;

    expect(skill).toContain("`eval:preflight`");
    expect(skill).toContain("실패하면 해당 provider와 이후 단계를 호출하지 않으며");
    expect(integration).toContain("pnpm eval:preflight -- <selection|editing|verification>");
    expect(integration).toContain("실패하면 모델을 호출하지 않는다.");
  });

  it("accepts a frozen complete run before recording its workflow receipt", async () => {
    const root = await createFrozenRun();

    const result = await preflightKoreanProseEvaluation("record", 1, root);

    expect(result.ids).toEqual(["case-1", "case-2"]);
    expect(result.digests).toMatchObject({ input: expect.any(String), candidate: expect.any(String) });
  });

  it("blocks a provider phase when its output already exists", async () => {
    const root = await createFrozenRun();

    await expect(preflightKoreanProseEvaluation("selection", 1, root)).rejects.toMatchObject({
      code: "OUTPUT_EXISTS",
    });
  });

  it("keeps an unreadable metadata file distinct from invalid JSON", async () => {
    const root = await createFrozenRun();
    const metaPath = path.join(root, "evals", "runs", "run-1", "verification-meta.json");
    await rm(metaPath, { force: true });
    await mkdir(metaPath);

    const failure = await preflightKoreanProseEvaluation("record", 1, root).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "EISDIR" });
    expect(failure).not.toMatchObject({ name: "EvaluationPreflightError" });

    await rm(metaPath, { recursive: true });
    await writeFile(metaPath, "{ not json", "utf8");
    await expect(preflightKoreanProseEvaluation("record", 1, root)).rejects.toMatchObject({
      code: "INVALID_JSONL",
    });
  });

  it("blocks recording when the verification actor reuses another role", async () => {
    const root = await createFrozenRun();
    const metaPath = path.join(root, "evals", "runs", "run-1", "verification-meta.json");
    const verificationInput = await frozenVerificationInput();
    const rubric = "# Frozen rubric\n";
    await writeJson(metaPath, {
      role: "verification",
      actorId: editorActor,
      caseCount: 2,
      verificationInputSha256: sha256(verificationInput),
      rubricSha256: sha256(rubric),
    });

    await expect(preflightKoreanProseEvaluation("record", 1, root)).rejects.toMatchObject({
      code: "ACTOR_REUSE",
    });
  });

  it("preflights and records an explicit legacy cycle directory instead of default evals/runs (AGS-D-0126)", async () => {
    const root = await createFrozenRun("evals/custom-legacy");
    const aliasContainer = await mkdtemp(path.join(tmpdir(), "korean-prose-alias-"));
    temporaryDirectories.push(aliasContainer);
    const nonCanonicalRoot = path.join(aliasContainer, "runner~1-alias");
    await symlink(root, nonCanonicalRoot, process.platform === "win32" ? "junction" : "dir");
    const layout = await resolveEvaluationLayout(nonCanonicalRoot, 1, "evals/custom-legacy");
    expect(layout.structured).toBe(false);
    expect(layout.cycleDirectory).toBe(path.join(root, "evals", "custom-legacy"));

    const recorded = spawnSync(
      process.execPath,
      ["--import", "tsx", recorderPath, "1", nonCanonicalRoot, "--cycle-dir", "evals/custom-legacy"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(recorded.status, recorded.stderr).toBe(0);
    await expect(
      readFile(path.join(root, "evals", "custom-legacy", "run-1", "workflow-receipt.json"), "utf8"),
    ).resolves.toContain("korean-prose-evaluation-run-1");

    const mixedRoot = await createFrozenRun("evals/runs");
    await populateFrozenRunAt(mixedRoot, "evals/bad-legacy");
    const tamperedVerificationInput = [
      JSON.stringify({ id: "case-1", sourceText: "변조된 원문", candidateText: "수정 하나" }),
      JSON.stringify({ id: "case-2", sourceText: "원문 둘", candidateText: "원문 둘" }),
    ].join("\n");
    await writeFile(
      path.join(mixedRoot, "evals", "bad-legacy", "run-1", "verification-input.jsonl"),
      tamperedVerificationInput,
      "utf8",
    );
    await writeJson(path.join(mixedRoot, "evals", "bad-legacy", "run-1", "verification-input-meta.json"), {
      run: 1,
      caseCount: 2,
      sha256: sha256(tamperedVerificationInput),
      containsExpectedDecision: false,
      containsEditorRationale: false,
      status: "frozen",
    });
    await writeJson(path.join(mixedRoot, "evals", "bad-legacy", "run-1", "verification-meta.json"), {
      role: "verification",
      actorId: verifierActor,
      caseCount: 2,
      verificationInputSha256: sha256(tamperedVerificationInput),
      rubricSha256: sha256("# Frozen rubric\n"),
    });

    await expect(preflightKoreanProseEvaluation("record", 1, mixedRoot, "evals/bad-legacy")).rejects.toMatchObject({
      code: "ARTIFACT_BINDING_MISMATCH",
    });
    const rejected = spawnSync(
      process.execPath,
      ["--import", "tsx", recorderPath, "1", mixedRoot, "--cycle-dir", "evals/bad-legacy"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("ARTIFACT_BINDING_MISMATCH");
  });
});

async function createFrozenRun(relativeRunsRoot = path.join("evals", "runs")): Promise<string> {
  const rawRoot = await mkdtemp(path.join(tmpdir(), "korean-prose-preflight-"));
  const root = await realpath(rawRoot);
  temporaryDirectories.push(root);
  await populateFrozenRunAt(root, relativeRunsRoot);
  return root;
}

async function populateFrozenRunAt(root: string, relativeRunsRoot: string): Promise<void> {
  const runsRoot = path.join(root, relativeRunsRoot);
  const runDirectory = path.join(runsRoot, "run-1");
  const references = path.join(root, "skills", "korean-prose-editor", "references");
  await Promise.all([
    mkdir(runDirectory, { recursive: true }),
    mkdir(references, { recursive: true }),
  ]);

  const input = [
    JSON.stringify({ id: "case-1", sourceText: "원문 하나" }),
    JSON.stringify({ id: "case-2", sourceText: "원문 둘" }),
  ].join("\n");
  const selection = [
    JSON.stringify({ id: "case-1", actorId: selectorActor, action: "edit" }),
    JSON.stringify({ id: "case-2", actorId: selectorActor, action: "retain" }),
  ].join("\n");
  const candidate = [
    JSON.stringify({ id: "case-1", actorId: editorActor, candidateText: "수정 하나" }),
    JSON.stringify({ id: "case-2", actorId: editorActor, candidateText: "원문 둘" }),
  ].join("\n");
  const verificationInput = await frozenVerificationInput();
  const verification = [
    JSON.stringify({ id: "case-1", actorId: verifierActor, finalDecision: "accept" }),
    JSON.stringify({ id: "case-2", actorId: verifierActor, finalDecision: "retain" }),
  ].join("\n");
  const final = [
    JSON.stringify({ id: "case-1", finalText: "수정 하나", finalAction: "edit" }),
    JSON.stringify({ id: "case-2", finalText: "원문 둘", finalAction: "retain" }),
  ].join("\n");
  const rubric = "# Frozen rubric\n";

  await Promise.all([
    writeFile(path.join(runsRoot, "input.jsonl"), input, "utf8"),
    writeJson(path.join(runsRoot, "manifest.json"), {
      caseCount: 2,
      inputSha256: sha256(input),
      runCount: 1,
    }),
    writeFile(path.join(runDirectory, "selection.jsonl"), selection, "utf8"),
    writeJson(path.join(runDirectory, "selection-meta.json"), {
      run: 1,
      role: "selection",
      actorId: selectorActor,
      caseCount: 2,
      inputSha256: sha256(input),
      status: "complete",
    }),
    writeFile(path.join(runDirectory, "candidate.jsonl"), candidate, "utf8"),
    writeJson(path.join(runDirectory, "editing-meta.json"), {
      run: 1,
      role: "editing",
      actorId: editorActor,
      selectorActorId: selectorActor,
      caseCount: 2,
      inputSha256: sha256(input),
      status: "complete",
    }),
    writeFile(path.join(runDirectory, "verification-input.jsonl"), verificationInput, "utf8"),
    writeJson(path.join(runDirectory, "verification-input-meta.json"), {
      run: 1,
      caseCount: 2,
      sha256: sha256(verificationInput),
      containsExpectedDecision: false,
      containsEditorRationale: false,
      status: "frozen",
    }),
    writeFile(path.join(runDirectory, "verification.jsonl"), verification, "utf8"),
    writeJson(path.join(runDirectory, "verification-meta.json"), {
      role: "verification",
      actorId: verifierActor,
      caseCount: 2,
      verificationInputSha256: sha256(verificationInput),
      rubricSha256: sha256(rubric),
    }),
    writeFile(path.join(runDirectory, "final.jsonl"), final, "utf8"),
    writeJson(path.join(runDirectory, "metrics.json"), {
      actorIds: [selectorActor, editorActor, verifierActor],
      counts: {
        selection: { edit: 1, retain: 1 },
        final: { edit: 1, retain: 1 },
        restored: 0,
      },
    }),
    writeFile(path.join(references, "verification-rubric.md"), rubric, "utf8"),
  ]);
}

async function frozenVerificationInput(): Promise<string> {
  return [
    JSON.stringify({ id: "case-1", sourceText: "원문 하나", candidateText: "수정 하나" }),
    JSON.stringify({ id: "case-2", sourceText: "원문 둘", candidateText: "원문 둘" }),
  ].join("\n");
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
