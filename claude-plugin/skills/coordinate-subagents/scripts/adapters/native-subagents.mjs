import { assert, canonical, validateSelection } from '../model-routing-core.mjs';

export function codexSubagentArguments(selection, { contextMode='limited', forkTurns='none' } = {}) {
  validateSelection(selection);
  assert(contextMode === 'limited' && forkTurns !== 'all', 'FULL_HISTORY_REQUIRES_LEGACY_INHERITANCE');
  assert(forkTurns === 'none' || /^[1-9][0-9]*$/u.test(forkTurns),'INVALID_CONTEXT');
  assert(selection.modelOrigin === 'openai' && selection.nativeReasoning.kind === 'enum','UNSUPPORTED_NATIVE_CONTROL');
  assert(selection.runtimeMode === 'standard','RUNTIME_MODE_REQUIRES_HOST_TOOL_CONTRACT');
  assert(['low','medium','high','xhigh','max'].includes(selection.nativeReasoning.value),'UNSUPPORTED_NATIVE_CONTROL');
  return {model:selection.model,reasoning_effort:selection.nativeReasoning.value,fork_turns:forkTurns};
}
export function claudeSubagentArguments(selection, { definition={}, environmentEffort=null } = {}) {
  validateSelection(selection);
  assert(selection.modelOrigin === 'anthropic','ORIGIN_MISMATCH');
  assert(selection.runtimeMode === 'standard','RUNTIME_MODE_REQUIRES_HOST_TOOL_CONTRACT');
  // A budget is neither an Agent invocation effort nor an arbitrary native enum.
  assert(selection.nativeReasoning.kind === 'enum','NATIVE_CONTROL_REQUIRES_VERIFIED_INHERITANCE');
  assert(!selection.resolvedModel.includes('haiku'),'HAIKU_DOES_NOT_EXPOSE_NATIVE_EFFORT');
  assert(['low','medium','high','xhigh','max'].includes(selection.nativeReasoning.value),'UNSUPPORTED_NATIVE_CONTROL');
  assert(environmentEffort === null || environmentEffort === selection.nativeReasoning.value,'ENVIRONMENT_EFFORT_CONFLICT');
  assert(!definition.model || definition.model === selection.model,'AGENT_DEFINITION_MODEL_CONFLICT');
  assert(!definition.effort || definition.effort === selection.nativeReasoning.value,'AGENT_DEFINITION_EFFORT_CONFLICT');
  return { invocationArguments:{model:selection.model}, agentDefinition:{...structuredClone(definition),model:selection.model,effort:selection.nativeReasoning.value}, environmentEffort };
}
export function observedCodexSettings(actualArguments) {
  assert(actualArguments && typeof actualArguments==='object','INVALID_INPUT');
  return {model:actualArguments.model ?? null,nativeReasoning:typeof actualArguments.reasoning_effort==='string'?{kind:'enum',value:actualArguments.reasoning_effort}:null,
    // This is argument observation, not effective host-state observation.
    runtimeMode:null,source:'invocation-arguments',effectiveSettingsVerified:false};
}
export function assertDispatchedNativeArguments(host,selection,actual,options={}) {
  const expected=host==='openai-codex'?codexSubagentArguments(selection,options):host==='anthropic-claude-code'?claudeSubagentArguments(selection,options):null;
  assert(expected!==null,'HOST_UNSUPPORTED');
  assert(canonical(expected)===canonical(actual),'DISPATCH_MISMATCH');
  return true;
}
