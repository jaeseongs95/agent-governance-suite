#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemas = [];

function collectSchemas(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectSchemas(path);
    else if (entry.isFile() && entry.name.endsWith(".schema.json")) {
      const schema = JSON.parse(readFileSync(path, "utf8"));
      if (schema.$schema) schemas.push(schema);
    }
  }
}

collectSchemas(join(root, "contracts"));
collectSchemas(join(root, "integration"));

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const schema of schemas) ajv.addSchema(schema);
for (const schema of schemas) ajv.getSchema(schema.$id);

process.stdout.write(`schemas: ${schemas.length} compiled\n`);
