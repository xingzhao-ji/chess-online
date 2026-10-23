import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { GameStore, parseCommand } from '../server/store.js';

type Message = Record<string,any>;
class Peer {
  messages:Message[]=[];
  waiters:{predicate:(message:Message)=>boolean,resolve:(message:Message)=>void,reject:(e:Error)=>void,timer:ReturnType<typeof setTimeout>}[]=[];
  constructor(readonly ws:WebSocket){ws.on('message',raw=>{const message=JSON.parse(raw.toString());const i=this.waiters.findIndex(w=>w.predicate(message));if(i>=0){const w=this.waiters.splice(i,1)[0];clearTimeout(w.timer);w.resolve(message);}else this.messages.push(message);});}
  static async open(port:number,roomId:string,token:string){const ws=new WebSocket(`ws://127.0.0.1:${port}/socket`);const peer=new Peer(ws);await once(ws,'open');peer.send({type:'hello',roomId,token});return peer;}
  send(value:unknown){this.ws.send(JSON.stringify(value));}
  wait(predicate:(message:Message)=>boolean,timeout=5000):Promise<Message>{const i=this.messages.findIndex(predicate);if(i>=0)return Promise.resolve(this.messages.splice(i,1)[0]);return new Promise((resolve,reject)=>{const waiter={predicate,resolve,reject,timer:setTimeout(()=>{this.waiters=this.waiters.filter(w=>w!==waiter);reject(new Error('Expected socket message timed out.'));},timeout)};this.waiters.push(waiter);});}
  async command(value:Message){const commandId=value.commandId||randomUUID();this.send({...value,commandId});return this.wait(m=>m.type==='ack'&&m.commandId===commandId);}
  async state(version?:number){this.send({type:'sync'});return this.wait(m=>m.type==='state'&&(version===undefined||m.version===version));}
  close(){for(const waiter of this.waiters){clearTimeout(waiter.timer);waiter.reject(new Error('Peer closed'));}this.waiters=[];this.ws.terminate();}
}
async function post(port:number,path:string,body:unknown,headers:Record<string,string>={}){const res=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});return {status:res.status,body:await res.json() as Message};}
async function seats(port:number,seconds=60,increment=0){const created=await post(port,'/api/rooms',{seconds,increment});assert.equal(created.status,201);const black=await post(port,`/api/rooms/${created.body.roomId}/join`,{invite:created.body.invite});assert.equal(black.status,200);return {white:created.body,black:black.body};}
async function fixture(t:TestContext,seconds=60){const dir=await mkdtemp(join(tmpdir(),'chess-protocol-'));const app=createApp({dbPath:join(dir,'room.sqlite')});const port=await app.listen(0);const s=await seats(port,seconds);const white=await Peer.open(port,s.white.roomId,s.white.token),black=await Peer.open(port,s.black.roomId,s.black.token);await white.wait(m=>m.type==='state');await black.wait(m=>m.type==='state');t.after(async()=>{white.close();black.close();await app.close();await rm(dir,{recursive:true,force:true});});return {app,port,white,black,seats:s};}
const move=(expectedVersion:number,from:string,to:string,extra:Message={})=>({type:'move',expectedVersion,from,to,...extra});

test('two real sockets enforce legality, turn/version checks and actor/payload-bound idempotency',async t=>{
  const f=await fixture(t);
  assert.equal((await f.white.command(move(0,'e2','e5'))).code,'illegal_move');
  assert.equal((await f.black.command(move(0,'e7','e5'))).code,'out_of_turn');
  const command=move(0,'e2','e4',{commandId:randomUUID()});
  const accepted=await f.white.command(command);assert.equal(accepted.ok,true);assert.equal(accepted.version,1);
  assert.deepEqual(await f.white.command(command),accepted);
  assert.equal((await f.white.command({...command,to:'e3'})).code,'command_conflict');
  assert.equal((await f.black.command(command)).code,'command_conflict');
  assert.equal((await f.black.command(move(0,'e7','e5'))).code,'stale_version');
  assert.equal((await f.black.command(move(1,'e7','e5'))).ok,true);
  const [w,b]=await Promise.all([f.white.state(2),f.black.state(2)]);
  assert.equal(w.fen,b.fen);assert.deepEqual(w.moves.map((m:Message)=>m.san),['e4','e5']);assert.equal(w.seat,'w');assert.equal(b.seat,'b');
  assert.equal((f.app.store.db.prepare('SELECT COUNT(*) AS n FROM moves').get() as {n:number}).n,2);
});

test('simultaneous commands from two connections for one seat cannot both change the same version',async t=>{
  const f=await fixture(t);const second=await Peer.open(f.port,f.seats.white.roomId,f.seats.white.token);t.after(()=>second.close());await second.wait(m=>m.type==='state');
  const results=await Promise.all([f.white.command(move(0,'d2','d4')),second.command(move(0,'e2','e4'))]);
  assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.filter(r=>r.code==='stale_version').length,1);
  assert.equal((await f.black.state(1)).moves.length,1);
});

test('capabilities protect seats; invite is single-use; cross-origin and malformed messages are rejected',async t=>{
  const f=await fixture(t);
  const bad=await Peer.open(f.port,f.seats.white.roomId,'x'.repeat(43));t.after(()=>bad.close());
  assert.equal((await bad.wait(m=>m.type==='error')).code,'unauthorized');
  const claimed=await post(f.port,`/api/rooms/${f.seats.white.roomId}/join`,{invite:f.seats.white.invite});assert.equal(claimed.status,409);
  const rejected=await post(f.port,'/api/rooms',{seconds:60,increment:0},{Origin:'https://unrelated.example'});assert.equal(rejected.status,403);
  const invalidClock=await post(f.port,'/api/rooms',{seconds:true,increment:0});assert.equal(invalidClock.status,400);
  const tooLarge=await post(f.port,'/api/rooms',{seconds:60,increment:0,padding:'x'.repeat(5000)});assert.equal(tooLarge.status,413);
  f.white.send({type:'move',commandId:'valid-id-1',expectedVersion:0,from:'__proto__',to:'e4'});assert.equal((await f.white.wait(m=>m.type==='error')).code,'invalid_command');
  f.white.ws.send('{');assert.equal((await f.white.wait(m=>m.type==='error')).code,'invalid_json');
  assert.equal((await f.white.state(0)).moves.length,0);
  const rows=JSON.stringify(f.app.store.db.prepare('SELECT white_hash,black_hash,invite_hash FROM rooms').all());assert.ok(!rows.includes(f.seats.white.token));assert.ok(!rows.includes(f.seats.white.invite));
  const large=await Peer.open(f.port,f.seats.white.roomId,f.seats.white.token);await large.wait(m=>m.type==='state');const closed=once(large.ws,'close');large.ws.send('x'.repeat(9000));assert.equal((await closed)[0],1009);
});

test('socket reconnect restores state and retrying an acknowledged move never repeats it',async t=>{
  const f=await fixture(t);const command=move(0,'g1','f3',{commandId:randomUUID()});await f.white.command(command);f.white.close();
  const reconnect=await Peer.open(f.port,f.seats.white.roomId,f.seats.white.token);t.after(()=>reconnect.close());const state=await reconnect.wait(m=>m.type==='state');assert.equal(state.version,1);assert.equal(state.moves[0].san,'Nf3');
  assert.equal((await reconnect.command(command)).ok,true);assert.equal((await reconnect.state(1)).moves.length,1);
});

test('promotion requires a selected piece and supports underpromotion through the socket protocol',async t=>{
  const f=await fixture(t);const steps=[['a2','a4'],['h7','h5'],['a4','a5'],['h5','h4'],['a5','a6'],['h4','h3'],['a6','b7'],['h3','g2']];
  for(let i=0;i<steps.length;i++)assert.equal((await (i%2?f.black:f.white).command(move(i,steps[i][0],steps[i][1]))).ok,true);
  assert.equal((await f.white.command(move(8,'b7','a8'))).code,'illegal_move');
  assert.equal((await f.white.command(move(8,'b7','a8',{promotion:'n'}))).ok,true);assert.equal((await f.white.state(9)).moves.at(-1).san,'bxa8=N');
});

test('checkmate is terminal and resignation persists an explicit winner',async t=>{
  const f=await fixture(t);const steps=[['f2','f3'],['e7','e5'],['g2','g4'],['d8','h4']];for(let i=0;i<steps.length;i++)await (i%2?f.black:f.white).command(move(i,...steps[i] as [string,string]));
  const final=await f.white.state(4);assert.deepEqual(final.outcome,{winner:'b',reason:'Checkmate'});assert.equal((await f.white.command(move(4,'e2','e4'))).code,'game_over');
  const other=await fixture(t);assert.equal((await other.white.command({type:'resign',expectedVersion:0})).ok,true);assert.deepEqual((await other.black.state(1)).outcome,{winner:'b',reason:'Resignation'});
});

test('threefold repetition survives reconstructing the chess position from persisted moves',async t=>{
  const f=await fixture(t);const steps=[['g1','f3'],['g8','f6'],['f3','g1'],['f6','g8'],['g1','f3'],['g8','f6'],['f3','g1'],['f6','g8']];for(let i=0;i<steps.length;i++)assert.equal((await(i%2?f.black:f.white).command(move(i,...steps[i] as [string,string]))).ok,true);
  assert.deepEqual((await f.white.state(8)).outcome,{winner:null,reason:'Threefold repetition'});
});

test('server-owned clocks do not start while waiting and timeout once after the first move',async t=>{
  const f=await fixture(t,1);await delay(1100);const before=await f.white.state(0);assert.equal(before.whiteMs,1000);assert.equal(before.blackMs,1000);
  await f.white.command(move(0,'e2','e4'));const ended=await f.white.wait(m=>m.type==='state'&&m.outcome);assert.deepEqual(ended.outcome,{winner:'w',reason:'Time expired'});assert.equal(ended.blackMs,0);assert.equal(ended.version,2);await delay(250);assert.equal((await f.black.state(2)).version,2);
});

test('SQLite transaction rolls back game, move and receipt together after an injected write failure',async()=>{
  const store=new GameStore(':memory:');try{const seat=store.create(60,0);store.join(seat.roomId,seat.invite);store.db.exec("CREATE TRIGGER fail_move BEFORE INSERT ON moves BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    const command=parseCommand(move(0,'e2','e4',{commandId:'transaction-test'}));assert.throws(()=>store.command(seat.roomId,'w',command),/injected failure/);assert.equal(store.snapshot(seat.roomId,'w').version,0);assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM commands').get() as {n:number}).n,0);
    store.db.exec('DROP TRIGGER fail_move');assert.equal(store.command(seat.roomId,'w',command).ok,true);
  }finally{store.close();}
});

async function startChild(dbPath:string):Promise<{child:ChildProcess,port:number}>{
  const child=spawn(process.execPath,['--import','tsx','server/cli.ts'],{cwd:process.cwd(),env:{...process.env,PORT:'0',DB_PATH:dbPath,HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
  return new Promise((resolve,reject)=>{let output='',errors='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Child server startup timed out'));},10000);child.stderr!.on('data',data=>{errors+=data;});child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Child exited ${code}: ${errors}`));});child.stdout!.on('data',data=>{output+=data;for(const line of output.split('\n')){try{const value=JSON.parse(line);if(value.event==='listening'){clearTimeout(timer);resolve({child,port:value.port});return;}}catch{}}});});
}
async function stopChild(child:ChildProcess,signal:'SIGKILL'|'SIGTERM'='SIGTERM'){if(child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit');child.kill(signal);await exited;}
test('actual process recreation on the same SQLite file retains moves/receipts and charges downtime to the clock',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'chess-restart-'));let instance=await startChild(join(dir,'room.sqlite'));const peers:Peer[]=[];
  t.after(async()=>{for(const peer of peers)peer.close();await stopChild(instance.child);await rm(dir,{recursive:true,force:true});});
  const s=await seats(instance.port,1);const player=await Peer.open(instance.port,s.white.roomId,s.white.token);peers.push(player);await player.wait(m=>m.type==='state');const command=move(0,'d2','d4',{commandId:randomUUID()});assert.equal((await player.command(command)).ok,true);
  await stopChild(instance.child,'SIGKILL');await delay(1100);instance=await startChild(join(dir,'room.sqlite'));
  const reconnect=await Peer.open(instance.port,s.white.roomId,s.white.token);peers.push(reconnect);const state=await reconnect.wait(m=>m.type==='state');assert.equal(state.version,2);assert.equal(state.moves.length,1);assert.equal(state.moves[0].san,'d4');assert.deepEqual(state.outcome,{winner:'w',reason:'Time expired'});
  assert.equal((await reconnect.command(command)).version,1);assert.equal((await reconnect.state(2)).moves.length,1);
});
