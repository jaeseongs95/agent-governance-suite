import { writeFile } from "node:fs/promises";

import { discoverUpstreamUpdates } from "./source-lock.mjs";

const results = await discoverUpstreamUpdates();
const auto = results.filter((result) => result.policy === "auto-pr" && result.updateAvailable && !result.error);
const notify = results.filter((result) => result.policy === "notify-only");
// Entries the automatic path skips but a maintainer has to look at.
const attention = results.filter((result) => result.pinMismatch || (result.policy === "auto-pr" && result.error));
const report = { checkedAt: new Date().toISOString(), auto, notify, attention, all: results };
const output = `${JSON.stringify(report, null, 2)}\n`;
const outputPath = process.argv[2];
if (outputPath) await writeFile(outputPath, output, "utf8");
else process.stdout.write(output);
