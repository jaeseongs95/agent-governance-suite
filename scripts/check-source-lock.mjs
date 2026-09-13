import { verifySourceLockOffline, verifySourceLockRemote } from "./source-lock.mjs";

const remote = process.argv.slice(2).includes("--remote");
const unexpected = process.argv.slice(2).filter((argument) => argument !== "--remote");
if (unexpected.length > 0) throw new Error(`Unexpected argument: ${unexpected[0]}`);

const errors = [
  ...await verifySourceLockOffline(),
  ...(remote ? await verifySourceLockRemote() : []),
];
if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`source lock ${remote ? "and remote refs are" : "is"} consistent`);
}
