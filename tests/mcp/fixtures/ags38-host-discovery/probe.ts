import {createInstalledHostSkillObserver} from "../../../../mcp-server/src/skill-classification/installed-host-observer.js";
import {loadHostObservedInventory} from "../../../../mcp-server/src/skill-classification/host-discovery-adapter.js";
const root = process.argv[2]!;
const inventory = await loadHostObservedInventory({root, observeHostSkills: createInstalledHostSkillObserver(root)});
process.stdout.write(JSON.stringify(inventory));
