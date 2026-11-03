import { parseJson, readArtifact, readBoundedFile, hashBytes, hashJson, canonicalJson, sameSet, requireCondition as need } from './io.mjs';
import { validateSchema } from './schema.mjs';
import { validatePlan, validateProof, validateReview } from './core.mjs';

// A private-root local bundle closes selected stage evidence; it is not host attestation.
export function checkStageBundle(root, input, bundleDigest, taskDigest, capability) {
  const bytes = readBoundedFile(root, input);
  need(hashBytes(bytes) === bundleDigest, 'INTEGRITY_FAILED', 'practices.stageBundle.stageBundleBytesChanged');
  const bundle = parseJson(bytes);
  const test = capability === 'test-sensitivity-review';
  need(test || capability === 'change-code-review', 'INVALID_INPUT', 'practices.stageBundle.unsupportedEngineeringStageCapability');
  const names = test ? ['task', 'plan', 'proof', 'result'] : ['task', 'request', 'report', 'result'];
  need(sameSet(Object.keys(bundle), ['schemaVersion', 'kind', 'capability', ...names])
    && bundle.schemaVersion === '1.0.0' && bundle.kind === 'engineering-stage-bundle'
    && bundle.capability === capability, 'INVALID_INPUT', 'practices.stageBundle.invalidOrMismatchedStageBundle');
  const values = Object.fromEntries(names.map(name => {
    const ref = bundle[name];
    need(ref && sameSet(Object.keys(ref), ['path', 'digest']), 'INVALID_INPUT', 'practices.stageBundle.expectedAClosedRawFileReference');
    return [name, parseJson(readArtifact(root, ref, 8 * 1024 * 1024))];
  }));
  const task = validateSchema('task-envelope', values.task);
  need(hashJson(task) === taskDigest, 'INTEGRITY_FAILED', 'practices.stageBundle.bundleDoesNotBindTheSigned');
  need(task.requiredCapabilities.includes(capability), 'INVALID_INPUT', 'practices.stageBundle.taskDidNotSelectThisEngineering');
  const prepared = test ? values.plan : values.request;
  need(prepared.taskId === task.taskId && prepared.contractDigest === taskDigest,
    'INTEGRITY_FAILED', 'practices.stageBundle.preparedInputDoesNotBindThis');
  need(sameSet(prepared.requirements, task.acceptanceCriteria), 'INVALID_INPUT', 'practices.stageBundle.preparedRequirementsDifferFromTheFrozen');
  let result;
  if (test) {
    validatePlan(prepared);
    const requiredCoverage = new Set(prepared.cases.filter(c => c.required).flatMap(c => c.requirementIds));
    need(task.acceptanceCriteria.every(id => requiredCoverage.has(id)), 'INVALID_INPUT', 'practices.stageBundle.aFrozenRequirementHasNoRequired');
    need(prepared.cases.filter(c => c.required).every(c => ['red-green', 'mutation'].includes(c.sensitivity)),
      'INVALID_INPUT', 'practices.stageBundle.requiredSensitivityEvidenceCannotBeDowngraded');
    result = validateProof(root, prepared, values.proof);
  } else result = validateReview(root, prepared, values.report);
  need(canonicalJson(result) === canonicalJson(values.result), 'INTEGRITY_FAILED', 'practices.stageBundle.stageResultDiffersFromCurrentRaw');
  return { kind: 'engineering-stage-check', task, capability, result, resultRef: bundle.result,
    targetDigest: result.targetDigest, limitations: result.limitations };
}
