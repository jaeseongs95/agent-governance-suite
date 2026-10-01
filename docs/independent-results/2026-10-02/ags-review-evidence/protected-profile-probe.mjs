import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(resolve(process.cwd(),'package.json'));
const {Ajv2020}=require('ajv/dist/2020.js');
const schema=JSON.parse(readFileSync('contracts/approved-role-source.v1.schema.json','utf8'));
const ajv=new Ajv2020({strict:true,strictRequired:false,allErrors:true}).addSchema(schema);
const valid=ajv.getSchema(`${schema.$id}#/$defs/producer`);
for(const protectedPrincipal of [true,false]) {
 const p={owner:'flowmarshal-engine',producerTask:'R16-b',verification:'vm-signed-control-one-use-registry',principal:{profileId:'vm-protected-v1',protectedPrincipal}};
 console.log(JSON.stringify({protectedPrincipal,accepted:valid(p),errors:valid.errors}));
}
