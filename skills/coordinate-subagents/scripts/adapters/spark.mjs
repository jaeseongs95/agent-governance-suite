import { assert } from '../model-routing-core.mjs';
export const SPARK_RUNTIME=Object.freeze({id:'gemini-spark',kind:'runtime',modelOrigin:null,autoDispatch:false,status:'descriptor-only',
 externalDispatch:'unknown',sessionIdentity:'unknown',modelSelection:'unknown',effortSelection:'unknown',approvalBoundary:'unknown',cancel:'unknown',terminalOutcome:'unknown',evidenceReference:'unknown'});
/** Produces an activation review, not authority, and never changes the catalog. */
export function reviewSparkActivation({highRisk,requiredObservable=[],verifiedCapabilities={}}){
  assert(typeof highRisk==='boolean'&&Array.isArray(requiredObservable),'INVALID_INPUT');
  const required=['externalDispatch','sessionIdentity','approvalBoundary','terminalOutcome','evidenceReference',...requiredObservable];
  const missing=required.filter(k=>verifiedCapabilities[k]!==true);
  return {runtimeId:SPARK_RUNTIME.id,eligibleForLimitedRole:!highRisk&&missing.length===0,missing,
    highRiskAllowed:false,autoDispatch:false,activationRequiresReviewedConfiguration:true};
}
