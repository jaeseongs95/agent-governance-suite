import type { ModelCatalogV1, ModelRoutingPolicyV1 } from "../../../contracts/model-routing-types.js";

export declare function loadCatalog(options?: { directory?: string; providers?: string[] | null; role?: string | null }): ModelCatalogV1;
export declare function loadPolicy(directory?: string): ModelRoutingPolicyV1;
