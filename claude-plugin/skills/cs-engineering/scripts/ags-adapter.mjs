import { checkBundle, validateBinding, loadPack, providerResult, adapterError } from './core.mjs';
import { requireCondition as need, hashJson, parseJson, readArtifact } from './primitives.mjs';
import { validateSchema } from './schema-validation.mjs';

/** Embedding boundary; does NOT patch, replace or start WorkflowService. */
export function reviewForAgs(bundle, trustedContext) {
  try {
    need(trustedContext && typeof trustedContext === 'object', 'BINDING_REQUIRED', 'An embedding host context is required.');
    need(trustedContext.expectedBindingDigest === hashJson(bundle.binding), 'INTEGRITY_FAILED', 'CS binding does not match the host-pinned digest.');
    need(trustedContext.expectedCandidateDigest === hashJson(bundle.candidate), 'INTEGRITY_FAILED', 'CS candidate does not match the host-pinned digest.');
    need(trustedContext.expectedPolicyDigest === hashJson(bundle.policy), 'INTEGRITY_FAILED', 'CS policy does not match the host-pinned digest.');
    checkBundle(bundle);
    // The host must obtain these pins from its signed state, not a caller claim.
    return providerResult(bundle.review);
  } catch (error) { return adapterError(error); }
}

/** Receiver rechecks frozen inputs; this receipt does not dispatch an implementation. */
export function checkHandoff({root, binding, task, policy, pack = loadPack()}) {
  validateSchema('cs-engineering-binding', binding);
  const request = parseJson(readArtifact(root, binding.requestRef));
  const constraint = parseJson(readArtifact(root, binding.constraintReportRef));
  const {requiredObligationIds} = validateBinding(binding, {task, request, constraint, policy, pack});
  for (const ref of request.sourceRefs) readArtifact(root, ref);
  return {schemaVersion:'1.0.0', kind:'cs-handoff', taskDigest:binding.taskDigest,
    bindingDigest:hashJson(binding), constraintReportRef:binding.constraintReportRef,
    constraintReportDigest:binding.constraintReportDigest, knowledgePackDigest:pack.digest,
    requiredObligationIds, policyDigest:binding.policyDigest,
    assurance:'Rechecked input references and obligations. No dispatch, receipt of semantic instructions, policy authority or plan-wide binding.'};
}

/** Existing 2.x stage artifact boundary. Pins begin at recorded stage, not signed planning. */
export function checkStageBundle({root, reference, expectedBundleDigest, expectedTaskDigest}) {
  need(/^sha256:[a-f0-9]{64}$/u.test(expectedBundleDigest ?? '') && /^sha256:[a-f0-9]{64}$/u.test(expectedTaskDigest ?? ''), 'INVALID_INPUT', 'Stage bundle and signed task digests are required.');
  const manifest = parseJson(readArtifact(root, {path:reference, digest:expectedBundleDigest}));
  validateSchema('cs-stage-bundle', manifest);
  const bundle = {root};
  for (const name of ['binding','task','policy','review','candidate']) bundle[name] = parseJson(readArtifact(root, manifest[name]));
  need(hashJson(bundle.task) === expectedTaskDigest, 'INTEGRITY_FAILED', 'Stage bundle differs from the signed workflow task.');
  const assessment = checkBundle(bundle);
  return {...assessment, task:bundle.task, review:bundle.review, reviewRef:manifest.review};
}
