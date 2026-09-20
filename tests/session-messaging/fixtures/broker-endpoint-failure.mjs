import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const rename = fs.renameSync;
let failures = 0;
fs.renameSync = (source, destination) => {
  if (path.basename(destination) === "endpoint.json"
    && (["permanent", "ENOSPC"].includes(process.env.BROKER_TEST_RENAME_FAILURE) || failures++ < 2)) {
    const error = new Error("Simulated endpoint sharing violation");
    error.code = process.env.BROKER_TEST_RENAME_FAILURE === "ENOSPC" ? "ENOSPC" : "EPERM";
    throw error;
  }
  return rename(source, destination);
};
syncBuiltinESMExports();
