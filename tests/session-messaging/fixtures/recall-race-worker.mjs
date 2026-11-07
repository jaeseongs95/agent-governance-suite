import { SessionMessageStore } from '../../../mcp-server/src/session-message-store.ts';

// One side of the recall/claim race (message-recall.test.ts RC09): its own connection to the shared file, started on "go".
const [mode, database, input] = process.argv.slice(2);
const { sender, target, ids } = JSON.parse(input);
const store = new SessionMessageStore(database);
process.send({ type: 'ready' });
process.once('message', () => {
  try {
    if (mode === 'recall') {
      // Newest first while the claimer takes oldest first, so the two meet inside the queue instead of one trailing the other.
      const results = [...ids].reverse().map((id) => {
        const result = store.recall(sender, id);
        return { id, recalled: result.recalled, ...(result.reason ? { reason: result.reason } : {}) };
      });
      process.send({ results, claimed: [] }, () => { store.close(); process.exit(0); });
      return;
    }
    const claimed = [];
    for (;;) {
      const batch = store.claim(target, undefined, { maxMessages: 1 });
      if (batch.length === 0) break;
      claimed.push(...batch.map((message) => message.messageId));
    }
    process.send({ results: [], claimed }, () => { store.close(); process.exit(0); });
  } catch (error) {
    process.send({ results: [], claimed: [], error: String(error?.stack ?? error) }, () => process.exit(1));
  }
});
