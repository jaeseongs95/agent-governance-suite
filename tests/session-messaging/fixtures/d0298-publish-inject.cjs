/* global require, process */
/* eslint-disable @typescript-eslint/no-require-imports -- Node --require uses this CommonJS preload. */
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const rename = fs.renameSync;
fs.renameSync = function (from, to) {
  if (String(from).includes('broker.lock.stage-') && String(to).endsWith('broker.lock')) {
    throw Object.assign(new Error('PRIVATE_INJECTED_MARKER'), { code: process.env.AGS_TEST_PUBLISH_CODE });
  }
  return Reflect.apply(rename, this, [from, to]);
};
syncBuiltinESMExports();
