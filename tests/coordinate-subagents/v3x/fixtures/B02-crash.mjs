import { DatabaseSync } from 'node:sqlite';

import { initializeResourceStoreSchema } from '../../../../mcp-server/src/resource/store-schema.ts';

const config = JSON.parse(process.argv[2]);
const database = new DatabaseSync(config.databasePath);
const abrupt = new Proxy(database, {
  get(target, key) {
    const value = target[key];
    if (key === 'exec') return sql => {
      const result = value.call(target, sql);
      if (sql.includes('CREATE TABLE resource_authority')) process.exit(71);
      return result;
    };
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

initializeResourceStoreSchema(abrupt, config);
process.exitCode = 1;
