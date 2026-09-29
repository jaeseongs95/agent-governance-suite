// Audit-only broker preload: records the size of every request chunk the broker's TLS server hands to its handler.
import tls from "node:tls";
import { appendFileSync } from "node:fs";
const create = tls.createServer;
tls.createServer = function (options, handler) {
  return create.call(this, options, (socket) => {
    const id = Math.random().toString(36).slice(2, 8);
    socket.on("data", (chunk) => { if (process.env.AGS_AUDIT_CHUNKS) appendFileSync(process.env.AGS_AUDIT_CHUNKS, JSON.stringify({ side: "broker-request", socket: id, size: chunk.length }) + "\n"); });
    handler(socket);
  });
};
