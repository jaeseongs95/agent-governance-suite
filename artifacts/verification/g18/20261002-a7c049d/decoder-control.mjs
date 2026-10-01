import { createHash } from 'node:crypto';
process.stdin.setEncoding('utf8');
let original = '';
for await (const chunk of process.stdin) original += chunk;
process.stdout.write(JSON.stringify({textSha256:createHash('sha256').update(original).digest('hex'),utf8Bytes:Buffer.byteLength(original)})+'\n');
