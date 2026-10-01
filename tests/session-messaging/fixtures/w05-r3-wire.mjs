import tls from 'node:tls';
import { writeFileSync } from 'node:fs';

// Disposable TLS observation/fault port. Normal operations use the actual broker unchanged.
const createServer = tls.createServer;
const observations = [];
tls.createServer = function (options, listener) {
  return createServer.call(this, options, socket => {
    const chunks = []; let request;
    socket.on('data', chunk => {
      chunks.push(chunk);
      const bytes = Buffer.concat(chunks); const newline = bytes.indexOf(10);
      if (newline < 0 || request) return;
      try { request = JSON.parse(bytes.subarray(0, newline).toString('utf8')); } catch { return; }
    });
    const end = socket.end;
    socket.end = function (response, ...args) {
      // Synthetic successful ping response tests the client framing independently of dispatch effects.
      if (request?.operation === 'ping' && request.payload?.responseBytes) {
        const data = JSON.parse(response); data.data.padding = '';
        let raw = `${JSON.stringify(data)}\n`;
        const prefixBytes = Buffer.byteLength(raw.slice(0, raw.indexOf('"padding":"') + 11));
        data.data.padding = `${'x'.repeat(16383 - prefixBytes)}한😀`;
        raw = `${JSON.stringify(data)}\n`;
        data.data.padding += 'x'.repeat(request.payload.responseBytes - Buffer.byteLength(raw));
        response = `${JSON.stringify(data)}\n`;
      }
      observations.push({ operation: request?.operation ?? null, requestChunks: chunks.map(c => c.length),
        requestBytes: chunks.reduce((n, c) => n + c.length, 0), responseBytes: Buffer.byteLength(response) });
      writeFileSync(process.env.AGS_W05_WIRE_OBSERVATIONS, JSON.stringify(observations), 'utf8');
      return end.call(this, response, ...args);
    };
    listener(socket);
  });
};
