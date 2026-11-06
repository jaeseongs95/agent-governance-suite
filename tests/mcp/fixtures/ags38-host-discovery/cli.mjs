#!/usr/bin/env node
// TEST-owned public CLI fixture. It does not invoke a vendor model, auth, settings or install operation.
import {appendFileSync, readFileSync} from "node:fs";
const args = process.argv.slice(2);
const responses = JSON.parse(readFileSync(process.env.HOST_DISCOVERY_FIXTURE, "utf8"));
const key = ["codex", ...args].join(" ");
if (!(key in responses)) throw new Error("Unexpected public inspection command");
appendFileSync(process.env.HOST_DISCOVERY_CALLS, JSON.stringify(args) + "\n");
process.stdout.write(responses[key]);
