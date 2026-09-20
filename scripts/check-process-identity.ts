import { processStartToken } from "../mcp-server/src/process-identity.js";

let token: string | null = null;
for (let attempt = 0; attempt < 3 && !token; attempt += 1) token = processStartToken(process.pid);
if (!token) throw new Error("The current process must expose a start token on this supported platform.");

process.stdout.write(`process identity: ready (${process.platform})\n`);
