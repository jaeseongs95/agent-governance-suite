import { writeAdminPageModule } from "./admin-page.mjs";
import { buildRuntimeBundles } from "./runtime-bundles.mjs";

writeAdminPageModule();
await buildRuntimeBundles();
