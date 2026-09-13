import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  preflightKoreanProseEvaluation,
} from "../../scripts/korean-prose-evaluation-preflight.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Korean prose evaluation preflight", () => {
  it("requires every frozen model phase to pass the repository preflight", async () => {
    const [skill, integration] = await Promise.all([
      readFile(new URL("../../skills/korean-prose-editor/SKILL.md", import.meta.url), "utf8"),
      readFile(new URL("../../skills/korean-prose-editor/references/integration.md", import.meta.url), "utf8"),
    ]);

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

  it("blocks recording when the verification actor reuses another role", async () => {
    const root = await createFrozenRun();
    const metaPath = path.join(root, "evals", "runs", "run-1", "verification-meta.json");
    const verificationInput = await frozenVerificationInput();
    const rubric = "# Frozen rubric\n";
    await writeJson(metaPath, {
      role: "verification",
      actorId: "editor-actor",
      caseCount: 2,
      verificationInputSha256: sha256(verificationInput),
      rubricSha256: sha256(rubric),
    });

    await expect(preflightKoreanProseEvaluation("record", 1, root)).rejects.toMatchObject({
      code: "ACTOR_REUSE",
    });
  });
});

async function createFrozenRun(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "korean-prose-preflight-"));
  temporaryDirectories.push(root);
  const runsRoot = path.join(root, "evals", "runs");
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
    JSON.stringify({ id: "case-1", actorId: "selector-actor", action: "edit" }),
    JSON.stringify({ id: "case-2", actorId: "selector-actor", action: "retain" }),
  ].join("\n");
  const candidate = [
    JSON.stringify({ id: "case-1", actorId: "editor-actor", candidateText: "수정 하나" }),
    JSON.stringify({ id: "case-2", actorId: "editor-actor", candidateText: "원문 둘" }),
  ].join("\n");
  const verificationInput = await frozenVerificationInput();
  const verification = [
    JSON.stringify({ id: "case-1", actorId: "verifier-actor", finalDecision: "accept" }),
    JSON.stringify({ id: "case-2", actorId: "verifier-actor", finalDecision: "retain" }),
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
      actorId: "selector-actor",
      caseCount: 2,
      inputSha256: sha256(input),
      status: "complete",
    }),
    writeFile(path.join(runDirectory, "candidate.jsonl"), candidate, "utf8"),
    writeJson(path.join(runDirectory, "editing-meta.json"), {
      run: 1,
      role: "editing",
      actorId: "editor-actor",
      selectorActorId: "selector-actor",
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
      actorId: "verifier-actor",
      caseCount: 2,
      verificationInputSha256: sha256(verificationInput),
      rubricSha256: sha256(rubric),
    }),
    writeFile(path.join(runDirectory, "final.jsonl"), final, "utf8"),
    writeFile(path.join(references, "verification-rubric.md"), rubric, "utf8"),
  ]);
  return root;
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
