import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_OUTBOUND_BYTES, canQueueOutbound, sendBounded } from '../server/outbound.js';

function socket(bufferedAmount=0){return {readyState:1,bufferedAmount,sent:[] as string[],terminated:false,send(data:string){this.sent.push(data);this.bufferedAmount+=Buffer.byteLength(data);},terminate(){this.terminated=true;this.readyState=3;}};}
test('application frames stop before a slow consumer can exceed the outbound byte budget',()=>{
  const peer=socket();const snapshot={type:'state',moves:'x'.repeat(25000)};
  for(let i=0;i<20;i++)sendBounded(peer,snapshot);
  assert.equal(peer.terminated,true);assert.ok(peer.bufferedAmount<=MAX_OUTBOUND_BYTES);assert.ok(peer.sent.length>0);assert.ok(peer.sent.length<20);
});
test('outbound accounting includes UTF-8 bytes and the next frame, at the exact boundary',()=>{
  const payload={type:'error',message:'♚'};const bytes=Buffer.byteLength(JSON.stringify(payload));
  const exact=socket(MAX_OUTBOUND_BYTES-bytes);assert.equal(sendBounded(exact,payload),true);assert.equal(exact.bufferedAmount,MAX_OUTBOUND_BYTES);
  const over=socket(MAX_OUTBOUND_BYTES-bytes+1);assert.equal(sendBounded(over,payload),false);assert.equal(over.sent.length,0);assert.equal(over.terminated,true);
  const huge=socket();assert.equal(sendBounded(huge,{data:'x'.repeat(MAX_OUTBOUND_BYTES)}),false);assert.equal(huge.sent.length,0);
  const control=socket(MAX_OUTBOUND_BYTES-1);assert.equal(canQueueOutbound(control,2),false);assert.equal(control.terminated,true);
});
