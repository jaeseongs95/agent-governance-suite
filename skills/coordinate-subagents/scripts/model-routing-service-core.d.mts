export type RoutingApiResult = {schemaVersion:'1.0.0';ok:boolean;data:unknown;error:null|{code:'INVALID_INPUT'|'MCP_UNAVAILABLE';message:string;details:{routingCode:string}}};
export interface RoutingServiceOptions {store?:unknown;catalogDirectory?:string;clock?:()=>string;historyProvider?:null|((binding:unknown)=>{actors:string[];sessions:string[]});}
export declare class ModelRoutingServiceCore {
  constructor(options?:RoutingServiceOptions);
  query(input:unknown):unknown;
  resolve(input:unknown):unknown;
  record(input:unknown):unknown;
  call(name:string,input:unknown):RoutingApiResult;
}
export declare function checkApplicationArtifactBinding(record:unknown,context:{binding:unknown;target:unknown;requiredFields?:string[];store?:unknown}):unknown;
