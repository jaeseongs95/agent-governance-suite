import tls from "node:tls";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setInterval, clearInterval } from "node:timers";

// Disposable broker only: hold an armed, already-dispatched ping response while
// the caller observes its own candidate fail. Authentication and dispatch stay real.
const directory = process.env.AGS_STARTUP_PROBE_GATE;
const createServer = tls.createServer;
tls.createServer = function (options, listener) {
  return createServer.call(this, options, (socket) => {
    const end = socket.end;
    let gated = false;
    socket.end = function (...args) {
      if (gated || !existsSync(path.join(directory, "arm-ping"))) return end.apply(this, args);
      gated = true;
      writeFileSync(path.join(directory, "ping-response-held"), "1");
      const timer = setInterval(() => {
        if (!existsSync(path.join(directory, "release-ping"))) return;
        clearInterval(timer);
        end.apply(socket, args);
      }, 5);
      socket.once("close", () => clearInterval(timer));
      return this;
    };
    listener(socket);
  });
};
