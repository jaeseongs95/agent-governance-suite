import type {ModelSelectionRequestV2,ModelRoutingDecisionV2} from '../../../../contracts/types.js';
export const MODEL_ROUTING_PEER_FEATURE: 'model-routing.v2';
export interface PeerAssignmentEnvelope {
 schemaVersion:'1.0.0';feature:'model-routing.v2';type:'assignment-proposal';
 binding:ModelSelectionRequestV2['binding'];target:NonNullable<ModelRoutingDecisionV2['target']>;
 decisionDigest:string;delta:string;inputReferences:Array<{uri:string;digest:string}>;
}
export declare function encodePeerAssignment(request:ModelSelectionRequestV2,decision:ModelRoutingDecisionV2,options?:{delta?:string;inputReferences?:Array<{uri:string;digest:string}>}):string;
export declare function decodePeerAssignment(body:string,features:string[]):PeerAssignmentEnvelope;
export declare function preflightPeerAssignment(request:ModelSelectionRequestV2,decision:ModelRoutingDecisionV2,environment:unknown):unknown;
export declare function acceptPeerAssignment(body:string,options:{features:string[];target:unknown;loadAssignment:(id:string)=>Promise<{request:ModelSelectionRequestV2;decision:ModelRoutingDecisionV2}>;environment:Record<string,unknown>;authorizeAndConsume:(value:unknown)=>Promise<boolean>;revalidateAuthorization?:()=>boolean;store:unknown}):Promise<{accepted:boolean;shouldExecute:boolean;duplicate?:boolean;state?:string;dispatchKey?:string;revision?:number;reason?:string}>;
