// Controlled AgentAPI stand-in. No shell, network, credentials or descendants.
const process = globalThis.process;
const { setTimeout, setInterval } = globalThis;
const { appendFileSync } = process.getBuiltinModule('node:fs');
const argv = process.argv.slice(2);
appendFileSync(process.env.AGS_ARGV_WITNESS, JSON.stringify({
  pid: process.pid, argv,
  entry: process.argv[1], executable: process.execPath,
  project: process.env.ANTIGRAVITY_PROJECT_ID ?? null,
  sourceMetadataPresent: Object.hasOwn(process.env, 'ANTIGRAVITY_SOURCE_METADATA'),
}) + '\n', { encoding: 'utf8' });
const mode = process.env.AGS_ARGV_MODE;
// Independent finite lifetime if the parent runner dies; not a Windows Job Object.
setTimeout(() => process.exit(124), 20_000).unref();
if (argv[0] === 'get-conversation-metadata') {
  if (mode === 'invalid-json') process.stdout.write('{');
  else {
    process.stdout.write('{"response":{"conversationMetadata":{"metadata":{"projectId":"source-project"}}}}');
    if (mode === 'metadata-error') process.exitCode = 23;
  }
} else if (argv[0] === 'send-message') {
  if (mode === 'send-error') process.exitCode = 29;
  else if (mode === 'send-timeout') setInterval(() => {}, 1_000);
} else {
  process.exitCode = 31;
}
