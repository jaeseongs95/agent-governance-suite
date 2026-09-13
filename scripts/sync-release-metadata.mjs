import { syncReleaseMetadata } from "./release-metadata.mjs";

const write = process.argv.slice(2).includes("--write");
const unexpected = process.argv.slice(2).filter((argument) => argument !== "--write" && argument !== "--");
if (unexpected.length > 0) throw new Error(`Unexpected argument: ${unexpected[0]}`);

const stale = await syncReleaseMetadata({ write });
console.log(write
  ? `synchronized ${stale.length} release metadata file(s)`
  : "release metadata is synchronized");
