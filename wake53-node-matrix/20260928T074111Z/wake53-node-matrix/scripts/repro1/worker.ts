import { parentPort } from "node:worker_threads";
import { x } from "./a.js";
parentPort!.postMessage("ok " + x);
