import { PLUGIN_INFO } from "../../mcp-server/src/plugin-info.js";

const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/u.exec(PLUGIN_INFO.version);
if (!match) {
  throw new Error(`PLUGIN_INFO.version is not SemVer: ${PLUGIN_INFO.version}`);
}

const [major, minor, patch] = match.slice(1, 4).map(Number) as [number, number, number];

export const CURRENT_VERSION = PLUGIN_INFO.version;
// The newest published stable release a fixture stores. A prerelease build precedes its own
// release, so for one such as 3.0.0-rc.1 the newest stable release is an earlier version.
export const STABLE_VERSION = match[4] === undefined
  ? CURRENT_VERSION
  : patch > 0 ? `${major}.${minor}.${patch - 1}` : minor > 0 ? `${major}.${minor - 1}.0` : `${major - 1}.0.0`;
export const NEXT_VERSION = `${major}.${minor + 1}.0`;
export const NEXT_TAG = `v${NEXT_VERSION}`;
export const NEXT_NEXT_VERSION = `${major}.${minor + 2}.0`;
export const NEXT_NEXT_TAG = `v${NEXT_NEXT_VERSION}`;
