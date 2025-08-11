import { calcChecksum } from '../lib/protocol-utils.js';

function assert(cond,msg){ if(!cond) throw new Error(msg); }

// Payload esempio: '01AB' + ETX (0x03) => somma byte ascii
const payload = Buffer.from('01AB'+String.fromCharCode(0x03),'ascii');
const cs = calcChecksum(payload);
console.log('checksum', cs.toString('ascii'));
assert(cs.length===2,'lunghezza checksum');
