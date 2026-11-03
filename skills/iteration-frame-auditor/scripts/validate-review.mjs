#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { hostText } from "../../../runtime/i18n.mjs";

import { validateReview } from "./core.mjs";
import { readJsonArgument, writeJson } from "./io.mjs";

try {
  const args = process.argv.slice(2);
  const requestIndex = args.indexOf("--request");
  const reviewIndex = args.indexOf("--review");
  const comparisonIndex = args.indexOf("--comparison");
  const digestIndex = args.indexOf("--request-digest");
  let request;
  let review;
  let comparison;
  let requestArtifactDigest;

  if (requestIndex >= 0 || reviewIndex >= 0 || comparisonIndex >= 0 || digestIndex >= 0) {
    if (!args[requestIndex + 1]) throw new Error(hostText("skillTools.iterationFrame.flagNeedsPath", { flag: "--request" }));
    if (!args[reviewIndex + 1]) throw new Error(hostText("skillTools.iterationFrame.flagNeedsPath", { flag: "--review" }));
    if (!args[comparisonIndex + 1]) throw new Error(hostText("skillTools.iterationFrame.flagNeedsPath", { flag: "--comparison" }));
    if (!args[digestIndex + 1]) throw new Error(hostText("skillTools.iterationFrame.digestFlagNeedsValue"));
    request = JSON.parse(await readFile(args[requestIndex + 1], "utf8"));
    review = JSON.parse(await readFile(args[reviewIndex + 1], "utf8"));
    comparison = JSON.parse(await readFile(args[comparisonIndex + 1], "utf8"));
    requestArtifactDigest = args[digestIndex + 1];
  } else {
    const input = await readJsonArgument(args);
    ({ request, review, comparison, requestArtifactDigest } = input ?? {});
  }

  const errors = validateReview(review, comparison, request, requestArtifactDigest);
  writeJson({ valid: errors.length === 0, errors });
  if (errors.length > 0) process.exitCode = 1;
} catch (error) {
  writeJson({ valid: false, errors: [error instanceof Error ? error.message : String(error)] });
  process.exitCode = 2;
}
