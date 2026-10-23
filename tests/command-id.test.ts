import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCommandId } from '../src/command-id.js';
import { parseCommand } from '../server/store.js';

test('command identity uses native randomUUID when available',()=>{
  const id='85e46461-9fd7-4450-9500-4d2f3289ef44';
  assert.equal(makeCommandId({randomUUID:()=>id,getRandomValues:()=>{throw new Error('not needed');}}),id);
});
test('HTTP-context fallback uses secure random bytes and conforms to the server protocol',()=>{
  let calls=0;
  const id=makeCommandId({getRandomValues(bytes){calls++;assert.equal(bytes.length,16);return bytes.map((_,i)=>i);}});
  assert.equal(calls,1);assert.equal(id,'cmd_000102030405060708090a0b0c0d0e0f');
  assert.equal(parseCommand({type:'move',commandId:id,expectedVersion:0,from:'e2',to:'e4'}).commandId,id);
});
test('missing secure randomness produces an actionable error instead of a weak fallback',()=>{
  assert.throws(()=>makeCommandId({}),/cannot create a secure move ID/);
});
