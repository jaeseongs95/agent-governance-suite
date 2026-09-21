import assert from 'node:assert/strict';
import { test } from 'vitest';

import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';
import { loadCatalog, loadPolicy } from '../../../skills/coordinate-subagents/scripts/model-catalog.mjs';
import { recordV2, resolveV2 } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { application, capability, fixture, observation, request, sample } from './fixtures.mjs';

// The engine validates by hand; these checks keep its inputs and outputs inside the published JSON Schemas.
test('engine inputs and outputs match the published model routing contracts', () => {
  const validator = new ContractValidator();
  const { req, env, decision } = fixture();
  validator.modelCatalogV1(loadCatalog());
  validator.modelRoutingPolicyV1(loadPolicy());
  validator.hostModelCapabilitiesV1(capability());
  validator.modelSelectionRequestV2(req);
  validator.modelRoutingDecisionV2(decision);
  validator.modelRoutingDecisionV2(resolveV2(request({ user: { strength: 'required', model: 'unknown-model' } }), env));
  validator.modelApplicationRequestV2(application(req, decision, { observation: observation(req, decision) }));
  validator.modelApplicationRecordV2(recordV2(application(req, decision), { ...env, request: req, decision, admittedObservation: observation(req, decision) }));
  validator.modelEvaluationRecordV1(sample());
});

test('contracts reject policies without the host-neutral floor data', () => {
  const validator = new ContractValidator();
  const policy = loadPolicy();
  delete policy.modelMinimums;
  assert.throws(() => validator.modelRoutingPolicyV1(policy));
  assert.throws(() => validator.modelSelectionRequestV2(request({ role: 'independent-audit', highRisk: false })));
});
