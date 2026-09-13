import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule, { type FormatsPlugin } from "ajv-formats";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  type ApiResultV1,
  type PluginUpdateNoticeV1,
  type ProviderResultV1,
  type PluginUpdateStatusV1,
  type SchemaReferenceV1,
  type SkillDescriptorV2,
  type StageResultV1,
  type TaskEnvelopeV1,
  type WorkflowPlanV1,
  type WorkflowReceiptV1,
  WorkflowContractError,
} from "../../contracts/types.js";

type JsonSchema = Record<string, unknown>;
const addFormats = addFormatsModule as unknown as FormatsPlugin;

function loadSchema(fileName: string): JsonSchema {
  const path = new URL(`../../contracts/${fileName}`, import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as JsonSchema;
}

/** The wire schemas are loaded from contracts/ so MCP and direct callers share one definition. */
export const contractSchemas = {
  apiResult: loadSchema("api-result.v1.schema.json"),
  pluginUpdateStatus: loadSchema("plugin-update-status.v1.schema.json"),
  pluginUpdateNotice: loadSchema("plugin-update-notice.v1.schema.json"),
  taskEnvelope: loadSchema("task-envelope.v1.schema.json"),
  skillDescriptor: loadSchema("skill-descriptor.v1.schema.json"),
  skillDescriptorV2: loadSchema("skill-descriptor.v2.schema.json"),
  workflowPlan: loadSchema("workflow-plan.v1.schema.json"),
  stageResult: loadSchema("stage-result.v1.schema.json"),
  workflowReceipt: loadSchema("workflow-receipt.v1.schema.json"),
};

function errorText(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

export class ContractValidator {
  private readonly validators: Record<string, ValidateFunction>;

  constructor() {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    for (const schema of Object.values(contractSchemas)) {
      ajv.addSchema(schema);
    }
    this.validators = {
      apiResult: ajv.getSchema("https://skill-suite.local/contracts/api-result.v1.schema.json")!,
      pluginUpdateStatus: ajv.getSchema("https://skill-suite.local/contracts/plugin-update-status.v1.schema.json")!,
      pluginUpdateNotice: ajv.getSchema("https://skill-suite.local/contracts/plugin-update-notice.v1.schema.json")!,
      taskEnvelope: ajv.getSchema("https://skill-suite.local/contracts/task-envelope.v1.schema.json")!,
      skillDescriptor: ajv.getSchema("https://skill-suite.local/contracts/skill-descriptor.v1.schema.json")!,
      skillDescriptorV2: ajv.getSchema("https://skill-suite.local/contracts/skill-descriptor.v2.schema.json")!,
      workflowPlan: ajv.getSchema("https://skill-suite.local/contracts/workflow-plan.v1.schema.json")!,
      stageResult: ajv.getSchema("https://skill-suite.local/contracts/stage-result.v1.schema.json")!,
      workflowReceipt: ajv.getSchema("https://skill-suite.local/contracts/workflow-receipt.v1.schema.json")!,
    };
  }

  private assert<T>(name: keyof ContractValidator["validators"], value: unknown): T {
    const validate = this.validators[name];
    if (!validate) {
      throw new WorkflowContractError("INVALID_INPUT", `Validator '${name}' is not registered.`);
    }
    if (!validate(value)) {
      throw new WorkflowContractError("INVALID_INPUT", `${name} does not match its v1 contract.`, {
        validationErrors: errorText(validate.errors),
      });
    }
    return value as T;
  }

  taskEnvelope(value: unknown): TaskEnvelopeV1 {
    return this.assert<TaskEnvelopeV1>("taskEnvelope", value);
  }

  skillDescriptorV2(value: unknown): SkillDescriptorV2 {
    return this.assert<SkillDescriptorV2>("skillDescriptorV2", value);
  }

  stageResult(value: unknown): StageResultV1 {
    return this.assert<StageResultV1>("stageResult", value);
  }

  workflowPlan(value: unknown): WorkflowPlanV1 {
    return this.assert<WorkflowPlanV1>("workflowPlan", value);
  }

  workflowReceipt(value: unknown): WorkflowReceiptV1 {
    return this.assert<WorkflowReceiptV1>("workflowReceipt", value);
  }

  apiResult<T>(value: unknown): ApiResultV1<T> {
    return this.assert<ApiResultV1<T>>("apiResult", value);
  }

  pluginUpdateStatus(value: unknown): PluginUpdateStatusV1 {
    return this.assert<PluginUpdateStatusV1>("pluginUpdateStatus", value);
  }

  pluginUpdateNotice(value: unknown): PluginUpdateNoticeV1 {
    return this.assert<PluginUpdateNoticeV1>("pluginUpdateNotice", value);
  }

  providerResult(
    rootDirectory: string,
    resultSchema: SchemaReferenceV1,
    outputSchema: SchemaReferenceV1,
    value: unknown,
  ): ProviderResultV1 {
    const result = this.assertSchemaFile<ProviderResultV1>(rootDirectory, resultSchema, value, "provider result");
    if (result.output !== null) {
      this.assertSchemaFile(rootDirectory, outputSchema, result.output, "provider output");
    }
    return result;
  }

  declaredSchema(
    rootDirectory: string,
    reference: SchemaReferenceV1,
    value: unknown,
    label: string,
  ): Record<string, unknown> {
    return this.assertSchemaFile<Record<string, unknown>>(rootDirectory, reference, value, label);
  }

  referenceOnlyFixedTokens(
    rootDirectory: string,
    reference: SchemaReferenceV1,
  ): Set<string> {
    const schema = this.readBoundSchema(rootDirectory, reference, "reference-only output");
    const tokens = new Set<string>();
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const record = value as Record<string, unknown>;
      if ((record.type === "object" || record.properties) && record.additionalProperties !== false) {
        throw new WorkflowContractError(
          "INVALID_INPUT",
          "A reference-only provider output schema must close every declared object.",
          { schemaPath: reference.path },
        );
      }
      if (typeof record.const === "string") tokens.add(record.const);
      if (Array.isArray(record.enum)) {
        for (const item of record.enum) if (typeof item === "string") tokens.add(item);
      }
      Object.values(record).forEach(visit);
    };
    visit(schema);
    return tokens;
  }

  private assertSchemaFile<T>(
    rootDirectory: string,
    reference: SchemaReferenceV1,
    value: unknown,
    label: string,
  ): T {
    const root = path.resolve(rootDirectory);
    const targetSchema = this.readBoundSchema(rootDirectory, reference, label);

    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const schemas = new Map<string, JsonSchema>();
    for (const directory of [path.join(root, "contracts"), this.skillSchemaRoot(root, reference.path)]) {
      for (const candidate of this.schemaFiles(directory)) {
        const schema = JSON.parse(readFileSync(candidate, "utf8")) as JsonSchema;
        const id = typeof schema.$id === "string" ? schema.$id : `file://${candidate.split(path.sep).join("/")}`;
        if (!schemas.has(id)) schemas.set(id, schema);
      }
    }
    for (const schema of schemas.values()) ajv.addSchema(schema);
    const targetId = typeof targetSchema.$id === "string" ? targetSchema.$id : undefined;
    const validate = (targetId ? ajv.getSchema(targetId) : undefined) ?? ajv.compile(targetSchema);
    if (!validate(value)) {
      throw new WorkflowContractError("INVALID_INPUT", `${label} does not match its declared schema.`, {
        schemaPath: reference.path,
        validationErrors: errorText(validate.errors),
      });
    }
    return value as T;
  }

  private readBoundSchema(
    rootDirectory: string,
    reference: SchemaReferenceV1,
    label: string,
  ): JsonSchema {
    const root = path.resolve(rootDirectory);
    const schemaPath = path.resolve(root, reference.path);
    if (schemaPath !== root && !schemaPath.startsWith(`${root}${path.sep}`)) {
      throw new WorkflowContractError("INVALID_INPUT", `${label} schema escapes the plugin root.`, {
        schemaPath: reference.path,
      });
    }
    const raw = readFileSync(schemaPath);
    const digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    if (digest !== reference.digest) {
      throw new WorkflowContractError("STALE_REVISION", `${label} schema changed after planning.`, {
        schemaPath: reference.path,
        expectedDigest: reference.digest,
        actualDigest: digest,
      });
    }
    return JSON.parse(raw.toString("utf8")) as JsonSchema;
  }

  private skillSchemaRoot(rootDirectory: string, schemaPath: string): string {
    const segments = schemaPath.split("/");
    return segments[0] === "skills" && segments[1]
      ? path.join(rootDirectory, "skills", segments[1])
      : path.join(rootDirectory, "contracts");
  }

  private schemaFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...this.schemaFiles(candidate));
      else if (entry.isFile() && entry.name.endsWith(".schema.json")) files.push(candidate);
    }
    return files;
  }
}
