import type {DatabaseSync} from 'node:sqlite';
export declare class ModelRoutingStore {
  readonly database:DatabaseSync;
  constructor(database:DatabaseSync);
  capabilities():unknown[];
  application(digest:string):unknown;
}
