import { FXPLCClientMock } from '../lib/FXPLCClientMock.js';
import { NoResponseError } from '../lib/errors.js';

function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function test_readBit_mock() {
  const plc = new FXPLCClientMock();
  const bit = await plc.readBit('M0');
  assert(bit === false, 'FXPLCClientMock.readBit deve restituire false');
}

async function test_error_on_invalid_register() {
  const plc = new FXPLCClientMock();
  let err = null;
  try { await plc.readBit('Z999'); } catch(e) { err = e; }
  assert(err && err.message.includes('registro non valido'), 'Deve lanciare errore su registro non valido');
}

async function test_callback_style() {
  const plc = new FXPLCClientMock();
  let called = false;
  plc.readBit('M0', (err, bit) => {
    assert(!err && bit === false, 'Callback-style deve funzionare');
    called = true;
  });
  await new Promise(r=>setTimeout(r,10));
  assert(called, 'Callback deve essere chiamata');
}

async function runAll() {
  await test_readBit_mock();
  await test_error_on_invalid_register();
  await test_callback_style();
  console.log('Tutti i test FXPLCClientMock superati!');
}

runAll().catch(e => { console.error('Test fallito:', e); process.exit(1); });
