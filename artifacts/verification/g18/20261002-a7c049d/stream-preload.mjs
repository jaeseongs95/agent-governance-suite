import { Readable } from 'node:stream';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const bytes = readFileSync(process.env.G18_INPUT);
const cuts = JSON.parse(process.env.G18_CUTS || '[]');
let readCalls = 0, scheduledTicks = 0, pushedChunks = 0;
if (process.env.G18_TRANSPORT === 'readable') {
  let position = 0, cutIndex = 0, pending = false;
  const stream = new Readable({objectMode:false, highWaterMark:1,
    read() {
      readCalls++;
      if (pending) return;
      pending = true;
      setImmediate(() => {
        scheduledTicks++; pending = false;
        if (position === bytes.length) { this.push(null); return; }
        const end = cuts[cutIndex++] ?? bytes.length;
        if (!(end > position && end <= bytes.length)) throw new Error('Invalid byte cut');
        const chunk = bytes.subarray(position,end); position = end;
        pushedChunks++; this.push(chunk);
      });
    }
  });
  Object.defineProperty(process,'stdin',{value:stream,configurable:true});
}
// Wrap Node's real async iterator only to observe untouched values; no emit(data),
// injected decoder output or mocked async iterator supplies the values.
const stream = process.stdin;
const originalIterator = stream[Symbol.asyncIterator].bind(stream);
const received = [], types = new Set(), sizes = [];
let concatenated = '';
stream[Symbol.asyncIterator] = async function* () {
  for await (const chunk of { [Symbol.asyncIterator]: originalIterator }) {
    types.add(typeof chunk === 'string' ? 'string' : Buffer.isBuffer(chunk) ? 'Buffer' : typeof chunk);
    const raw = typeof chunk === 'string' ? Buffer.from(chunk,'utf8') : chunk;
    received.push(raw); sizes.push(raw.length); concatenated += chunk;
    yield chunk;
  }
};
const sha = value => createHash('sha256').update(value).digest('hex');
process.once('exit',() => writeFileSync(process.env.G18_TRACE,JSON.stringify({
  transport:process.env.G18_TRANSPORT,objectMode:stream.readableObjectMode,
  inputBytes:bytes.length,inputSha256:sha(bytes),readCalls,scheduledTicks,pushedChunks,
  iteratorChunkCount:sizes.length,iteratorTypes:[...types],firstChunkSizes:sizes.slice(0,12),
  iteratorByteSha256:sha(Buffer.concat(received)),concatenatedTextSha256:sha(concatenated),
  replacementCharacters:(concatenated.match(/\uFFFD/g)||[]).length,
  readableEncoding:stream.readableEncoding
},null,2)+'\n'));
