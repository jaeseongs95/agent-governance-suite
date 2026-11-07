// Shared installation adapter data. The catalog lives here so core never depends on a skill folder; skills read this file.
export {default as defaultModelRoutingPresets} from "./model-routing-presets.json" with {type: "json"};
