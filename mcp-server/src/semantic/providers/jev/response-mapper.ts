import type { SemanticDecisionRequestV1 } from "../../../../../contracts/types.js";
import { digest, verifySeal } from "../../../../../skills/coordinate-subagents/scripts/model-routing-core.mjs";
import { ContractValidator } from "../../../schema-validator.js";
import { type SemanticProviderResultV1 } from "../../provider-port.js";
import { JEV_MODEL_CHOICE_QUESTION_ID } from "./request-mapper.js";

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => value !== null
  && typeof value === "object" && !Array.isArray(value);
const probability = (value: unknown): value is number => typeof value === "number"
  && Number.isFinite(value) && value >= 0 && value <= 1;

/** Normalize only the documented Choice shape. Invalid upstream data never becomes advice. */
export function mapJevChoiceResponse(
  raw: unknown,
  preparedValue: Readonly<SemanticDecisionRequestV1>,
): SemanticProviderResultV1 {
  const prepared = new ContractValidator().semanticDecisionRequestV1(preparedValue);
  verifySeal(prepared, "requestDigest");
  if (prepared.optionMappingDigest !== digest(prepared.options)) {
    throw new TypeError("Jev response mapping requires a consistent prepared option set.");
  }
  if (raw === null) return { status: "abstained" };
  if (!object(raw) || raw.model !== prepared.provider.model || !object(raw.answers)
    || !object(raw.usage) || Object.keys(raw.answers).length !== 1
    || !Object.hasOwn(raw.answers, JEV_MODEL_CHOICE_QUESTION_ID)
    || !Number.isSafeInteger(raw.usage.input_tokens) || Number(raw.usage.input_tokens) < 0
    || !Number.isSafeInteger(raw.usage.output_tokens) || Number(raw.usage.output_tokens) < 0) {
    return { status: "invalid" };
  }
  const answer = raw.answers[JEV_MODEL_CHOICE_QUESTION_ID];
  if (answer === null) return { status: "abstained" };
  if (!object(answer) || answer.type !== "choice" || typeof answer.choice !== "string"
    || !probability(answer.confidence) || !object(answer.probabilities)) {
    return { status: "invalid" };
  }
  const allowed = new Set(prepared.options.map(option => option.optionId));
  const probabilities = answer.probabilities;
  if (allowed.size !== prepared.options.length || !allowed.has(answer.choice)
    || Object.keys(probabilities).length !== allowed.size
    || Object.keys(probabilities).some(id => !allowed.has(id) || !probability(probabilities[id]))) {
    return { status: "invalid" };
  }
  const selected = probabilities[answer.choice] as number;
  if (Object.values(probabilities).some(value => (value as number) > selected)) {
    return { status: "invalid" };
  }
  return { status: "success", choice: {
    kind: "Choice", selectedOptionIds: [answer.choice], confidence: answer.confidence,
  } };
}
