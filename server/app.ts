import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { Color } from 'chess.js';
import { GameStore, Problem, parseCommand } from './store.js';
import { canQueueOutbound, sendBounded } from './outbound.js';

type Session = { roomId: string; seat: Color };
type Options = { dbPath: string; clientDir?: string; allowedOrigin?: string; now?: ()=>number };
const MIME: Record<string,string> = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.png':'image/png','.map':'application/json'};

export function createApp(options: Options) {
  const store = new GameStore(options.dbPath, options.now);
  const sessions = new Map<WebSocket,Session>();
  const wss = new WebSocketServer({noServer:true,maxPayload:8192,autoPong:false});
  const budgets = new Map<string,{since:number,count:number}>();
  const send = sendBounded;
  const presence = (id:string) => ({w:[...sessions.values()].some(s=>s.roomId===id&&s.seat==='w'),b:[...sessions.values()].some(s=>s.roomId===id&&s.seat==='b')});
  const state = (socket:WebSocket,s:Session) => send(socket,{...store.snapshot(s.roomId,s.seat),online:presence(s.roomId)});
  const broadcast = (id:string) => { for (const [socket,s] of sessions) if(s.roomId===id) state(socket,s); };
  function allowedOrigin(req: IncomingMessage) {
    const origin = req.headers.origin;
    if (!origin) return true; // Native clients authenticate using the same capability protocol.
    try { const url = new URL(origin); return origin === options.allowedOrigin || (url.host === req.headers.host && ['http:','https:'].includes(url.protocol)); } catch { return false; }
  }
  function budget(key:string,limit:number,window=60000) {
    const now=Date.now(); let bucket=budgets.get(key);
    if (!bucket || now-bucket.since>window) { bucket={since:now,count:0}; budgets.set(key,bucket); }
    if (++bucket.count>limit) throw new Problem('rate_limited','Please wait a moment before trying again.',429);
  }
  function json(res:ServerResponse,status:number,value:unknown) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(value)); }
  async function body(req:IncomingMessage) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')) throw new Problem('invalid_body','Send JSON.',415);
    let text='';
    for await (const chunk of req) { text+=chunk.toString(); if(Buffer.byteLength(text)>4096) throw new Problem('too_large','Request is too large.',413); }
    try { const value=JSON.parse(text); if(!value || typeof value!=='object'||Array.isArray(value)) throw new Error(); return value as Record<string,unknown>; } catch { throw new Problem('invalid_json','Send a JSON object.'); }
  }
  const server = createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      const url=new URL(req.url||'/', 'http://localhost');
      if(url.pathname==='/api/health'&&req.method==='GET') return json(res,200,{ok:true});
      if(url.pathname.startsWith('/api/')) {
        if(!allowedOrigin(req)) throw new Problem('origin_rejected','This origin is not allowed.',403);
        budget('api:'+req.socket.remoteAddress,120);
        if(url.pathname==='/api/rooms'&&req.method==='POST') {
          budget('create:'+req.socket.remoteAddress,10);
          const data=await body(req);
          if(typeof data.seconds!=='number'||typeof data.increment!=='number') throw new Problem('invalid_clock','Clock values must be numbers.');
          return json(res,201,store.create(data.seconds,data.increment));
        }
        const join=url.pathname.match(/^\/api\/rooms\/([\w-]+)\/join$/);
        if(join&&req.method==='POST') { const data=await body(req); const seat=store.join(join[1],data.invite,data.claimToken); broadcast(join[1]); return json(res,200,seat); }
        throw new Problem('not_found','Endpoint not found.',404);
      }
      if(req.method!=='GET'&&req.method!=='HEAD') throw new Problem('method_not_allowed','Use GET.',405);
      if(!options.clientDir) throw new Problem('not_found','Run the Vite client on port 5173, or build the client.',404);
      const root=resolve(options.clientDir); let file=resolve(root,'.'+decodeURIComponent(url.pathname));
      if(!file.startsWith(root+sep)&&file!==root) throw new Problem('not_found','Not found.',404);
      if(url.pathname==='/'||!extname(file)) file=resolve(root,'index.html');
      const info=await stat(file).catch(()=>null);
      if(!info?.isFile()) throw new Problem('not_found','Not found.',404);
      res.writeHead(200,{'Content-Type':MIME[extname(file)]||'application/octet-stream','Cache-Control':file.endsWith('index.html')?'no-cache':'public,max-age=3600'});
      res.end(req.method==='HEAD'?undefined:await readFile(file));
    } catch(error) { const p=error instanceof Problem?error:new Problem('internal_error','The table is temporarily unavailable.',500); if(!res.headersSent) json(res,p.status,{code:p.code,message:p.message}); else res.end(); }
  });
  server.on('upgrade',(req,socket,head)=>{
    if(req.url!=='/socket'||!allowedOrigin(req)||wss.clients.size>=500) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
  });
  wss.on('connection',socket=>{
    let count=0, window=Date.now(), alive=true;
    const authTimer=setTimeout(()=>{if(!sessions.has(socket)) socket.close(1008,'Authentication required');},5000);
    socket.on('pong',()=>{alive=true;});
    socket.on('ping',data=>{if(canQueueOutbound(socket,data.length+2))socket.pong(data);});
    const heartbeat=setInterval(()=>{if(!alive) return socket.terminate(); alive=false; if(canQueueOutbound(socket,2))socket.ping();},30000);
    socket.on('error',()=>{});
    socket.on('message',raw=>{
      try {
        if(Date.now()-window>10000) {count=0;window=Date.now();}
        if(++count>60) throw new Problem('rate_limited','Too many commands.');
        let msg:Record<string,unknown>;
        try {msg=JSON.parse(raw.toString()); if(!msg||typeof msg!=='object'||Array.isArray(msg)) throw new Error();} catch {throw new Problem('invalid_json','Send a JSON object.');}
        if(msg.type==='hello') {
          if(sessions.has(socket)) throw new Problem('already_authenticated','This connection already has a seat.');
          if(typeof msg.roomId!=='string') throw new Problem('unauthorized','A private room is required.');
          const seat=store.authenticate(msg.roomId,msg.token); sessions.set(socket,{roomId:msg.roomId,seat}); clearTimeout(authTimer); broadcast(msg.roomId); return;
        }
        const session=sessions.get(socket); if(!session) throw new Problem('unauthorized','Open your private seat link first.',403);
        if(msg.type==='sync') {state(socket,session); return;}
        const command=parseCommand(msg); const receipt=store.command(session.roomId,session.seat,command); send(socket,receipt); broadcast(session.roomId);
      } catch(error) { const p=error instanceof Problem?error:new Problem('internal_error','The action could not be completed.'); send(socket,{type:'error',code:p.code,message:p.message}); }
    });
    socket.on('close',()=>{clearTimeout(authTimer);clearInterval(heartbeat); const session=sessions.get(socket);sessions.delete(socket); if(session) broadcast(session.roomId);});
  });
  const timer=setInterval(()=>{for(const id of store.expireDue()) broadcast(id); const now=Date.now(); for(const [key,value] of budgets) if(now-value.since>60000) budgets.delete(key);},200);
  let closing=false;
  return {
    store, server,
    listen(port=3002,host='127.0.0.1'):Promise<number> {return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.off('error',reject);resolve((server.address() as {port:number}).port);});});},
    async close() {if(closing)return;closing=true;clearInterval(timer);for(const client of wss.clients)client.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();},
  };
}
