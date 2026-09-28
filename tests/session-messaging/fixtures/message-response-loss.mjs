import tls from "node:tls";
import { writeFileSync } from "node:fs";

// Disposable broker only. Drop one post-dispatch response without logging payloads.
const createServer = tls.createServer;
let dropped = false;
const counts = {};
tls.createServer = function (options, listener) {
  return createServer.call(this, options, (socket) => {
    let operation;
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      try {
        operation = JSON.parse(buffer.split("\n")[0]).operation;
        counts[operation] = (counts[operation] ?? 0) + 1;
        writeFileSync(process.env.AGS_MESSAGE_COUNTS_PATH, JSON.stringify(counts), "utf8");
      } catch { /* Product owns malformed input handling. */ }
      buffer = "";
    });
    const drop = () => {
      if (dropped || operation !== process.env.AGS_DROP_MESSAGE_OPERATION) return false;
      dropped = true;
      counts.responseDrops = 1;
      writeFileSync(process.env.AGS_MESSAGE_COUNTS_PATH, JSON.stringify(counts), "utf8");
      const error = process.env.AGS_FORCE_SOCKET_ERROR === "1"
        ? Object.assign(new Error("Synthetic connection reset after dispatch."), { code: "ECONNRESET" }) : undefined;
      socket.destroy(error);
      return true;
    };
    const write = socket.write;
    socket.write = function (...args) {
      if (drop()) return true;
      return write.apply(this, args);
    };
    const end = socket.end;
    socket.end = function (...args) {
      if (drop()) return this;
      return end.apply(this, args);
    };
    listener(socket);
  });
};
