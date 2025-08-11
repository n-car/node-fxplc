import { RegisterDef } from '../lib/registers.js';
function assert(c,m){ if(!c) throw new Error(m); }
const rd = RegisterDef.parse('M10');
assert(rd.type==='M','tipo');
assert(rd.num===10,'num');
const [addr, bit] = rd.getBitImageAddress();
console.log('addr',addr,'bit',bit);
assert(bit<8,'bit range');
