import type {DatabaseSync} from 'node:sqlite';
import type {HostModelCapabilitiesV1,ModelRoutingDecisionV2,ModelSelectionRequestV2,ModelCatalogV1,ModelRoutingPolicyV1} from '../../../../contracts/types.js';
export interface RoutingObserverReceipt {version:'1.0.0';kind:'capability'|'observation';nonce:string;issuedAt:string;expiresAt:string;payload:unknown;mac:string;}
export declare class RoutingObservationSigner {
  constructor(key:Buffer);
  issue(kind:'capability'|'observation',payload:unknown,times:{issuedAt:string;expiresAt:string}):RoutingObserverReceipt;
  verify(receipt:RoutingObserverReceipt,kind:'capability'|'observation',now:string):unknown;
}
export declare class ModelRoutingStore {
  readonly database:DatabaseSync;
  constructor(database:DatabaseSync);
  reserveDispatch(decision:ModelRoutingDecisionV2,options?:{write?:boolean}):{dispatchKey:string;duplicate:boolean;state:string;revision:number};
  transition(key:string,revision:number,state:string,reference?:string|null,now?:string|null):{dispatchKey:string;state:string;revision:number};
  capabilities():unknown[];
  application(digest:string):unknown;
  decision(digest:string):{request:ModelSelectionRequestV2;decision:ModelRoutingDecisionV2;environment:{catalog:ModelCatalogV1;policy:ModelRoutingPolicyV1;capabilities:HostModelCapabilitiesV1[];now:string};resolvedAt:string}|null;
  dispatch(key:string):{decision_digest:string;dispatched_at:string|null;state:string;revision:number}|null;
  publishCapability(receipt:RoutingObserverReceipt,signer:RoutingObservationSigner,presence:unknown,now:string):{snapshotDigest:string};
  bindNativeHookObservation(application:unknown,receipt:RoutingObserverReceipt,signer:RoutingObservationSigner,now:string):{bound:true};
  nativeHookObservationToken(application:unknown):string|null;
}
