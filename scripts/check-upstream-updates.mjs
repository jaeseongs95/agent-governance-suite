import { writeFile } from "node:fs/promises";

import { discoverUpstreamUpdates } from "./source-lock.mjs";

const results = await discoverUpstreamUpdates();
const auto = results.filter((result) => result.policy === "auto-pr" && result.updateAvailable && !result.error);
const notify = results.filter((result) => result.policy === "notify-only");
const report = { checkedAt: new Date().toISOString(), auto, notify, all: results };
const output = `${JSON.stringify(report, null, 2)}\n`;
const outputPath = process.argv[2];
if (outputPath) await writeFile(outputPath, output, "utf8");
else process.stdout.write(output);
