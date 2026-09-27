export type RoutingApiResult = {schemaVersion:'1.0.0';ok:boolean;data:unknown;error:null|{code:'INVALID_INPUT'|'MCP_UNAVAILABLE';message:string;details:{routingCode:string}}};
export interface RoutingServiceOptions {store?:unknown;catalogDirectory?:string;clock?:()=>string;historyProvider?:null|((binding:unknown)=>{actors:string[];sessions:string[]});recordV3?:null|((application:unknown,observationToken:string|null,now:string)=>unknown);readRecord?:null|((recordDigest:string)=>unknown);}
export declare class ModelRoutingServiceCore {
  constructor(options?:RoutingServiceOptions);
  query(input:unknown):unknown;
  resolve(input:unknown,suppliedCapabilities?:unknown[]):unknown;
  record(input:unknown):unknown;
  application(recordDigest:string):unknown;
  call(name:string,input:unknown,suppliedCapabilities?:unknown[]):RoutingApiResult;
}
export declare function checkApplicationArtifactBinding(record:unknown,context:{binding:unknown;target:unknown;requiredFields?:string[];store?:unknown}):unknown;
