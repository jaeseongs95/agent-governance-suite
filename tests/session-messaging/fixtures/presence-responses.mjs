import tls from 'node:tls';
import { writeFileSync } from 'node:fs';

// Disposable broker instrumentation: count target lookups and serialized packet bytes.
const createServer = tls.createServer;
const observations = [];
tls.createServer = function (options, listener) {
  return createServer.call(this, options, socket => {
    let request;
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (!buffer.includes('\n')) return;
      try { request = JSON.parse(buffer.split('\n')[0]); } catch { /* Product validates input. */ }
    });
    const end = socket.end;
    socket.end = function (response, ...args) {
      if (request?.operation === 'list-presence' && typeof response === 'string') {
        if (process.env.AGS_PRESENCE_RESPONSE_FAULT === 'invalid') {
          response = `${JSON.stringify({ ok: true, data: { sessions: [{ state: 'online' }] } })}\n`;
        } else if (process.env.AGS_PRESENCE_RESPONSE_FAULT === 'oversize') {
          response = `${JSON.stringify({ ok: true, data: { sessions: [], padding: 'x'.repeat(32768) } })}\n`;
        }
        observations.push({ targetCount: request.payload.targets?.length,
          responseBytes: Buffer.byteLength(response, 'utf8') });
        writeFileSync(process.env.AGS_PRESENCE_OBSERVATIONS, JSON.stringify(observations), 'utf8');
      }
      return end.call(this, response, ...args);
    };
    listener(socket);
  });
};
