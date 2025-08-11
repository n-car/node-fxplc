// CommonJS entrypoint for node-fxplc
// Allows: const { FXPLCClient, TransportSerial } = require('node-fxplc');

const FXPLCClient = require('./FXPLCClient.js');
const FXPLCClientMock = require('./FXPLCClientMock.js');
const TransportTCP = require('./TransportTCP.js');
const TransportSerial = require('./TransportSerial.js');
const TransportNull = require('./TransportNull.js');
const registers = require('./registers.js');
const numberTypes = require('./number-types.js');
const errors = require('./errors.js');

module.exports = {
  ...FXPLCClient,
  ...FXPLCClientMock,
  ...TransportTCP,
  ...TransportSerial,
  ...TransportNull,
  ...registers,
  ...numberTypes,
  ...errors
};
