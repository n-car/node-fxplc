// FXPLCClientMock.js - mock client for tests & demos (returns static values)
import { FXPLCClient } from './FXPLCClient.js';
import { TransportNull } from './TransportNull.js';
import { NumberType } from './number-types.js';

export class FXPLCClientMock extends FXPLCClient {
  constructor(){ super(new TransportNull()); }
  async readBit(_register){ return false; }
  async writeBit(_register,_value){ /* noop */ }
  async readInt(_register){ return 0; }
  async readNumber(_register,_type=NumberType.WordSigned){ return 0; }
  async readBytes(_addr,_count=1){ return Buffer.alloc(_count); }
  async writeBytes(_addr,_values){ /* noop */ }
  async writeInt(_register,_value){ /* noop */ }
  async writeNumber(_register,_value,_type){ /* noop */ }
}
