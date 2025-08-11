// TransportNull.js - no-op transport for tests / mock usage
export class TransportNull {
	/** Simulate write (discard data) */
	async write(_data){ /* noop */ }
	/** Always resolve with empty buffer */
	async read(_size){ return Buffer.alloc(0); }
	/** No resource to close */
	close(){}
}
