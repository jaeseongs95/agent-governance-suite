import { PLUGIN_INFO } from "../../mcp-server/src/plugin-info.js";

const parts = PLUGIN_INFO.version.split(".").map(Number);
if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
  throw new Error(`PLUGIN_INFO.version is not stable SemVer: ${PLUGIN_INFO.version}`);
}

const [major, minor] = parts as [number, number, number];

export const CURRENT_VERSION = PLUGIN_INFO.version;
export const NEXT_VERSION = `${major}.${minor + 1}.0`;
export const NEXT_TAG = `v${NEXT_VERSION}`;
export const NEXT_NEXT_VERSION = `${major}.${minor + 2}.0`;
export const NEXT_NEXT_TAG = `v${NEXT_NEXT_VERSION}`;
