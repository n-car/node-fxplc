import { FXPLCClient } from '../lib/FXPLCClient.js';
import { RegisterDef } from '../lib/registers.js';
import { ResponseMalformedError } from '../lib/errors.js';

function assert(c,m){ if(!c) throw new Error(m); }

// Transport mock
class TransportMock {
  constructor(data){ this.data = data; this.offset=0; }
  async write(_d){ /* capture if needed */ }
  async read(size){
    if(this.offset>=this.data.length) return Buffer.alloc(0);
    const out = this.data.slice(this.offset, this.offset+size);
    this.offset += size;
    return out;
  }
  close(){}
}

// Build a frame response for readBytes returning single byte 0b00010000 (bit4=1)
// Protocol: STX + <hexpayload> + ETX + checksum
// For readBytes( addr, 1 ) il payload decodificato (bytes PLC) sarà un solo byte 0x10 -> hex '10'
function buildFrame(hexPayload){
  const STX=0x02, ETX=0x03;
  const payloadBuf = Buffer.from(hexPayload,'ascii');
  const calcChecksum = (pl) => { const sum = pl.reduce((a,b)=>a+b,0); return Buffer.from(((sum&0xFF).toString(16).toUpperCase().padStart(2,'0')),'ascii'); };
  const checksum = calcChecksum(Buffer.concat([payloadBuf, Buffer.from([ETX])]));
  return Buffer.concat([Buffer.from([STX]), payloadBuf, Buffer.from([ETX]), checksum]);
}

(async () => {
  const frame = buildFrame('10');
  const transport = new TransportMock(frame);
  const client = new FXPLCClient(transport);
  const bit = await client.readBit(new RegisterDef('M', 4)); // bit 4 del byte
  console.log('bit letto', bit);
  assert(bit===true,'bit atteso true');

  // Caso frame malformato (checksum errato)
  const badFrame = Buffer.from(frame); badFrame[badFrame.length-1]=0x00; // corrompe checksum
  const badTransport = new TransportMock(badFrame);
  const badClient = new FXPLCClient(badTransport);
  let threw=false; try { await badClient.readBit(new RegisterDef('M',4)); } catch(e){ threw = e instanceof ResponseMalformedError; }
  assert(threw,'attesa ResponseMalformedError');
})();
