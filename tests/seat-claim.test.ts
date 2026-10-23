import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSeatClaim, readPendingClaim, completeSeatClaim } from '../src/seat-claim.js';

function storage(){const saved=new Map<string,string>();return {getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>{saved.set(key,value);},removeItem:(key:string)=>{saved.delete(key);}};}
test('join identity is persisted before use and is reused after failure and a simulated page reload',()=>{
  const session=storage();let calls=0;
  const rng={getRandomValues(bytes:Uint8Array){calls++;return bytes.fill(255);}};
  const first=prepareSeatClaim(session,'room-a',rng);
  assert.equal(first.length,43);assert.match(first,/^[A-Za-z0-9_-]{43}$/);assert.equal(readPendingClaim(session,'room-a'),first);
  // A new call has no in-memory state: the saved capability is its only recovery path.
  const restored=prepareSeatClaim(session,'room-a',{getRandomValues(){throw new Error('must reuse saved identity');}});
  assert.equal(restored,first);assert.equal(calls,1);
  completeSeatClaim(session,'room-a');assert.equal(readPendingClaim(session,'room-a'),null);
});
test('blocked or non-persistent session storage refuses to return a claim for HTTP submission',()=>{
  const rng={getRandomValues:(bytes:Uint8Array)=>bytes.fill(7)};
  assert.throws(()=>prepareSeatClaim({getItem(){throw new Error('blocked');},setItem(){},removeItem(){}},'room',rng),/cannot be read/);
  assert.throws(()=>prepareSeatClaim({getItem:()=>null,setItem(){throw new Error('quota');},removeItem(){}},'room',rng),/could not be saved/);
  assert.throws(()=>prepareSeatClaim({getItem:()=>null,setItem(){},removeItem(){}},'room',rng),/could not be saved/);
  assert.throws(()=>prepareSeatClaim(storage(),'room',{}),/cannot create a secure seat/);
});
