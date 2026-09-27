import tls from "node:tls";
import { writeFileSync } from "node:fs";

// Counts only the operation name at the disposable broker's execution boundary.
const createServer = tls.createServer;
tls.createServer = function (options, listener) {
  let count = 0;
  return createServer.call(this, options, (socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      try {
        if (JSON.parse(buffer.split("\n")[0]).operation === "peer-wait") {
          writeFileSync(process.env.AGS_PEER_WAIT_COUNT_PATH, String(++count), "utf8");
        }
      } catch { /* The product broker owns malformed-request handling. */ }
      buffer = "";
    });
    listener(socket);
  });
};
