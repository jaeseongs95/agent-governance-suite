import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SYNTHETIC_CORE_HOST = 'synthetic-message-core';

/** Owned fake core schema only. No native decoder, role capture or authority evidence.
 * The caller supplies already parsed syntheticWake facts; parsing has separate coverage.
 * selectTransport exercises real queue-profile settings, never native actor identity. */
export function registerSyntheticCoreAdapters(register, selectTransport) {
  register(SYNTHETIC_CORE_HOST, {
    adaptInput(input, selectedHost) {
      const event = input.hook_event_name;
      const lifecycle = event === 'SessionStart' ? 'start' : event === 'SessionEnd' ? 'end' : 'none';
      const kind = event === 'UserPromptSubmit' ? 'user-input'
        : event === 'PreToolUse' || event === 'PostToolUse' ? 'tool-boundary'
        : event === 'Stop' || event === 'SessionEnd' ? 'turn-end' : 'unknown';
      const child = input.syntheticActor === 'child';
      return { lifecycle, outputEventName: typeof event === 'string' ? event : '', observation: {
        host: selectedHost, sessionId: typeof input.session_id === 'string' ? input.session_id : '', kind,
        actor: { role: child ? 'child' : 'root', basis: 'observed', reasonCode: child ? 'SYNTHETIC_CORE_CHILD' : 'SYNTHETIC_CORE_ROOT' },
        ...(kind === 'tool-boundary' ? { boundaryPhase: event === 'PreToolUse' ? 'before' : 'after',
          toolName: typeof input.tool_name === 'string' ? input.tool_name : '', toolInput: input.tool_input ?? {} } : {}),
        ...(kind === 'user-input' ? { wakeCandidates: input.syntheticWake?.nonces ?? [], wakeOnly: input.syntheticWake?.wakeOnly === true } : {}),
      } };
    },
    ownsTool: name => name.startsWith('mcp__agent_governance_suite__'),
    deliveryProfile(environment) {
      const transport = selectTransport(environment);
      const queued = transport === 'codex-queue';
      return { transport, capabilities: { supportedInjection: queued ? ['peer-wake', 'tool-boundary'] : ['tool-boundary'],
        idleWake: queued ? 'user-message' : 'none' }, blocksEmptyWakePrompt: true };
    },
    processPid: pid => pid,
  });
}

// A real owned Node child imports the selected source/bundle namespace and registers
// the same fake adapter there. The imported production CLI cannot consume stdin.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [modulePath, selectedHost = SYNTHETIC_CORE_HOST, hostPid = '0'] = process.argv.slice(2);
  if (!modulePath) throw new Error('Synthetic driver requires an explicit hook module.');
  const hook = await import(pathToFileURL(modulePath).href);
  registerSyntheticCoreAdapters(hook.registerHookHostAdapter, environment => hook.sessionMessageTransport('codex', environment));
  const raw = readFileSync(0, 'utf8');
  const outcome = await hook.runSessionMessageHookOutcome(selectedHost, raw, Number(hostPid));
  if (!outcome.ok) throw new Error(`Synthetic hook failed: ${outcome.failure.phase}/${outcome.failure.reason}`);
  if (outcome.output) process.stdout.write(outcome.output);
}
