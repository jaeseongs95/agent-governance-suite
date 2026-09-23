import { readFileSync } from 'node:fs';
import { ObservationChallengeAuthority, registerVmObservationReader } from '../../../../mcp-server/src/host-integration/observation-challenge.ts';
import { SqliteWorkflowStore } from '../../../../mcp-server/src/sqlite-workflow-store.ts';

const input = JSON.parse(readFileSync(0, 'utf8'));
const store = new SqliteWorkflowStore(input.databasePath);
try {
  const reader = registerVmObservationReader({ readCurrentInvocation: () => input.invocation });
  const authority = new ObservationChallengeAuthority(store, reader, 'host', () => new Date(input.now));
  const result = input.mode === 'issue'
    ? { accepted: true, token: authority.issue() }
    : { accepted: true, observationId: authority.verifyAndConsume(input.token).observationId };
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stdout.write(JSON.stringify({ accepted: false, reason: String(error) }));
} finally {
  store.close();
}
