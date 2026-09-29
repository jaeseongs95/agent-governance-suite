import { Worker } from "node:worker_threads";
const w = new Worker(new URL("./worker.ts", import.meta.url), { execArgv: ["--import", "tsx"] });
w.on("message", m => { console.log("WORKER_MSG", m); });
w.on("error", e => { console.log("WORKER_ERR", e.code, e.message); });
w.on("exit", c => console.log("WORKER_EXIT", c));
