// FXPLCClientMock.js - mock client for tests & demos (returns static values)
import { FXPLCClient } from './FXPLCClient.js';
import { TransportNull } from './TransportNull.js';
import { NumberType } from './number-types.js';
import { RegisterDef, registersMapBitImages } from './registers.js';

export class FXPLCClientMock extends FXPLCClient {
  constructor(){ super(new TransportNull()); }
  readBit(register, cb){
    const prom = (async () => {
      const reg = register instanceof RegisterDef ? register : RegisterDef.parse(register);
      if (!registersMapBitImages[reg.type]) {
        throw new Error('readBit: registro non valido: ' + register);
      }
      return false;
    })();
    if (cb) prom.then(value => cb(null, value)).catch(error => cb(error));
    else return prom;
  }
  async writeBit(_register,_value){ /* noop */ }
  async readInt(_register){ return 0; }
  async readNumber(_register,_type=NumberType.WordSigned){ return 0; }
  async readBytes(_addr,_count=1){ return Buffer.alloc(_count); }
  async writeBytes(_addr,_values){ /* noop */ }
  async writeInt(_register,_value){ /* noop */ }
  async writeNumber(_register,_value,_type){ /* noop */ }
}
