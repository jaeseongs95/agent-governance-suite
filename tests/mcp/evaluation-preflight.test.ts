import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertEvaluationPreflight,
  EvaluationPreflightError,
  type EvaluationPreflightRequest,
} from "../../mcp-server/src/evaluation-preflight.js";

const temporaryDirectories: string[] = [];
const sourceText = [
  JSON.stringify({ id: "case-1", sourceText: "source one" }),
  JSON.stringify({ id: "case-2", sourceText: "source two" }),
].join("\n");
const candidateText = [
  JSON.stringify({ id: "case-1", actorId: "editor-actor", candidateText: "candidate one" }),
  JSON.stringify({ id: "case-2", actorId: "editor-actor", candidateText: "candidate two" }),
].join("\n");
const verificationInputText = [
  JSON.stringify({ id: "case-1", sourceText: "source one", candidateText: "candidate one" }),
  JSON.stringify({ id: "case-2", sourceText: "source two", candidateText: "candidate two" }),
].join("\n");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function request(overrides: Partial<EvaluationPreflightRequest> = {}): EvaluationPreflightRequest {
  return {
    runOrdinal: 1,
    approvedRunCount: 1,
    expectedRecordCount: 2,
    outputPaths: [join(tmpdir(), `evaluation-preflight-${randomUUID()}.json`)],
    actors: [{ role: "editing", actorId: "editor-actor", declaredActorId: "editor-actor" }],
    artifacts: [
      {
        name: "source",
        text: sourceText,
        canonicalIds: true,
        idField: "id",
        requiredFields: ["id", "sourceText"],
        nonEmptyStringFields: ["sourceText"],
      },
      {
        name: "candidate",
        text: candidateText,
        idField: "id",
        requiredFields: ["id", "actorId", "candidateText"],
        nonEmptyStringFields: ["candidateText"],
        actorRole: "editing",
      },
      {
        name: "verification-input",
        text: verificationInputText,
        idField: "id",
        requiredFields: ["id", "sourceText", "candidateText"],
        forbiddenVisibleFields: ["expectedDecision", "editorRationale"],
      },
    ],
    digestBindings: [{ name: "source", value: sourceText, expectedSha256: sha256(sourceText) }],
    recordBindings: [
      { sourceArtifact: "source", targetArtifact: "verification-input", fields: ["sourceText"] },
      { sourceArtifact: "candidate", targetArtifact: "verification-input", fields: ["candidateText"] },
    ],
    ...overrides,
  };
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(EvaluationPreflightError);
  expect((error as EvaluationPreflightError).code).toBe(code);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("evaluation preflight", () => {
  it("accepts frozen artifacts with matching IDs, actors, visibility, and digests", async () => {
    const result = await assertEvaluationPreflight(request());

    expect(result.ids).toEqual(["case-1", "case-2"]);
    expect(result.digests.source).toBe(sha256(sourceText));
    expect(result.digests.candidate).toBe(sha256(candidateText));
  });

  it("rejects runs outside the approved count before inspecting artifacts", async () => {
    await expect(assertEvaluationPreflight(request({ runOrdinal: 2 }))).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "RUN_OUT_OF_BUDGET");
      return true;
    });
  });

  it("refuses to overwrite an existing evaluation output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "evaluation-preflight-output-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "receipt.json");
    await writeFile(outputPath, "existing", "utf8");

    await expect(assertEvaluationPreflight(request({ outputPaths: [outputPath] }))).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "OUTPUT_EXISTS");
      return true;
    });
  });

  it("rejects empty required candidate text", async () => {
    const invalid = request();
    invalid.artifacts[1] = {
      ...invalid.artifacts[1]!,
      text: JSON.stringify({ id: "case-1", actorId: "editor-actor", candidateText: "" })
        + "\n"
        + JSON.stringify({ id: "case-2", actorId: "editor-actor", candidateText: "candidate two" }),
    };

    await expect(assertEvaluationPreflight(invalid)).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "EMPTY_REQUIRED_FIELD");
      return true;
    });
  });

  it("rejects duplicate or changed case IDs", async () => {
    const duplicate = request();
    duplicate.artifacts[1] = {
      ...duplicate.artifacts[1]!,
      text: candidateText.replace('"case-2"', '"case-1"'),
    };
    await expect(assertEvaluationPreflight(duplicate)).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "DUPLICATE_ID");
      return true;
    });

    const changed = request();
    changed.artifacts[1] = {
      ...changed.artifacts[1]!,
      text: candidateText.replace('"case-2"', '"case-x"'),
    };
    await expect(assertEvaluationPreflight(changed)).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "ID_SEQUENCE_MISMATCH");
      return true;
    });
  });

  it("rejects frozen digest mismatches and hidden fields visible to a reviewer", async () => {
    await expect(assertEvaluationPreflight(request({
      digestBindings: [{ name: "source", value: sourceText, expectedSha256: "0".repeat(64) }],
    }))).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "DIGEST_MISMATCH");
      return true;
    });

    const leaked = request();
    leaked.artifacts[2] = {
      ...leaked.artifacts[2]!,
      text: verificationInputText.replace('"candidate one"', '"candidate one","expectedDecision":"edit"'),
    };
    await expect(assertEvaluationPreflight(leaked)).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "FORBIDDEN_VISIBLE_FIELD");
      return true;
    });
  });

  it("rejects a blind-review input that no longer matches the frozen candidate", async () => {
    const changed = request();
    changed.artifacts[2] = {
      ...changed.artifacts[2]!,
      text: verificationInputText.replace("candidate two", "different candidate"),
    };

    await expect(assertEvaluationPreflight(changed)).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "ARTIFACT_BINDING_MISMATCH");
      return true;
    });
  });

  it("rejects actor reuse and artifact actor mismatches", async () => {
    await expect(assertEvaluationPreflight(request({
      actors: [
        { role: "selection", actorId: "same-actor" },
        { role: "editing", actorId: "same-actor" },
      ],
    }))).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "ACTOR_REUSE");
      return true;
    });

    const mismatch = request();
    mismatch.artifacts[1] = {
      ...mismatch.artifacts[1]!,
      text: candidateText.replaceAll("editor-actor", "other-actor"),
    };
    await expect(assertEvaluationPreflight(mismatch)).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "ACTOR_BINDING_MISMATCH");
      return true;
    });
  });
});
