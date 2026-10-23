import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import { makeCommandId } from './command-id.js';
import { completeSeatClaim, prepareSeatClaim, readPendingClaim } from './seat-claim.js';
import './style.css';

type Move = { from: string; to: string; san: string; color: Color; promotion?: string };
type State = {type:'state';roomId:string;seat:Color;version:number;fen:string;moves:Move[];whiteMs:number;blackMs:number;initialSeconds:number;incrementMs:number;running:boolean;turn:Color;outcome:{winner:Color|null;reason:string}|null;check:boolean;blackJoined:boolean;serverNow:number;legalMoves:{from:string;to:string;promotion?:string}[];online:{w:boolean;b:boolean}};
type Identity = {roomId:string;token?:string;invite?:string};
type PendingCommand = {type:'move'|'resign';commandId:string;expectedVersion:number;from?:string;to?:string;promotion?:string};
const glyphs:Record<PieceSymbol,string>={k:'♚',q:'♛',r:'♜',b:'♝',n:'♞',p:'♟'};
const names:Record<PieceSymbol,string>={k:'king',q:'queen',r:'rook',b:'bishop',n:'knight',p:'pawn'};
function readIdentity():Identity|null {const p=new URLSearchParams(location.hash.slice(1)),roomId=p.get('room');return roomId?{roomId,token:p.get('token')||undefined,invite:p.get('invite')||undefined}:null;}
function clock(value:number) {const s=Math.max(0,Math.ceil(value/1000));return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;}
function Icon({name}:{name:'copy'|'arrow'|'rotate'|'link'|'check'}) {
  const paths={copy:<><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></>,arrow:<><path d="M4 12h15m-6-6 6 6-6 6"/></>,rotate:<><path d="M20 9a8 8 0 1 0 0 6M20 3v6h-6"/></>,link:<><path d="m10 13 4-4m-6 6-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 0 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 1) scale(.9)"/></>,check:<path d="m5 12 4 4L19 6"/>};
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
function App(){
  const [identity,setIdentity]=useState<Identity|null>(readIdentity),[state,setState]=useState<State|null>(null);
  const [connection,setConnection]=useState<'offline'|'connecting'|'online'|'reconnecting'>('offline');
  const [selected,setSelected]=useState<string|null>(null),[promotion,setPromotion]=useState<{from:string;to:string}|null>(null);
  const [message,setMessage]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[control,setControl]=useState('600+5'),[flipped,setFlipped]=useState(false),[now,setNow]=useState(Date.now()),[received,setReceived]=useState(Date.now()),[awaiting,setAwaiting]=useState(false);
  const [confirm,setConfirm]=useState<'resign'|'new'|null>(null),[inviteVisible,setInviteVisible]=useState(false),[copyValue,setCopyValue]=useState('');
  const socket=useRef<WebSocket|null>(null), pending=useRef<PendingCommand|null>(null),stateRef=useRef<State|null>(null),sentOn=useRef<WebSocket|null>(null),boardRef=useRef<HTMLDivElement|null>(null),dialogRef=useRef<HTMLDialogElement|null>(null);
  useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),100);return()=>clearInterval(t);},[]);
  useEffect(()=>{const changed=()=>{setIdentity(readIdentity());setState(null);setSelected(null);setError('');pending.current=null;setAwaiting(false);};window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[]);
  useEffect(()=>{if(identity?.invite&&!identity.token){try{if(readPendingClaim(window.sessionStorage,identity.roomId))setMessage('Your previous seat request is saved in this tab. Retry to restore your Black seat.');}catch{/* The join action shows storage errors before any HTTP request. */}}},[identity?.roomId,identity?.token,identity?.invite]);
  useEffect(()=>{stateRef.current=state;},[state]);
  useEffect(()=>{if(confirm||promotion)dialogRef.current?.showModal();else dialogRef.current?.close();},[confirm,promotion]);
  useEffect(()=>{
    if(!identity?.token){setConnection('offline');return;}
    let disposed=false,retry:ReturnType<typeof setTimeout>|undefined,attempt=0;
    function connect(){
      if(disposed)return;setConnection(attempt?'reconnecting':'connecting');
      const ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/socket`);socket.current=ws;
      ws.onopen=()=>ws.send(JSON.stringify({type:'hello',roomId:identity!.roomId,token:identity!.token}));
      ws.onmessage=(e)=>{
        const msg=JSON.parse(e.data);
        if(msg.type==='state'){
          attempt=0;setState(msg);stateRef.current=msg;setReceived(Date.now());setConnection('online');
          setSelected(current=>current&&msg.legalMoves.some((m:{from:string})=>m.from===current)?current:null);
          if(pending.current&&sentOn.current!==ws){ws.send(JSON.stringify(pending.current));sentOn.current=ws;}
        }else if(msg.type==='ack'){
          if(pending.current?.commandId===msg.commandId){pending.current=null;setAwaiting(false);}
          if(!msg.ok)setError(msg.message||'The move was not accepted.');
        }else if(msg.type==='error'){
          setError(msg.message);if(msg.code==='unauthorized'||msg.code==='room_not_found'){disposed=true;ws.close();setConnection('offline');}
          if(pending.current){pending.current=null;setAwaiting(false);}
        }
      };
      ws.onclose=()=>{if(disposed)return;setConnection('reconnecting');attempt++;retry=setTimeout(connect,Math.min(5000,500*2**Math.min(attempt,4)));};
      ws.onerror=()=>{};
    }
    connect();const sync=setInterval(()=>{if(socket.current?.readyState===WebSocket.OPEN)socket.current.send(JSON.stringify({type:'sync'}));},5000);
    return()=>{disposed=true;clearInterval(sync);clearTimeout(retry);socket.current?.close();socket.current=null;};
  },[identity?.roomId,identity?.token]);
  function enter(next:Identity){const params=new URLSearchParams({room:next.roomId,...(next.token?{token:next.token}:{}),...(next.invite?{invite:next.invite}:{})});history.replaceState(null,'','#'+params);pending.current=null;sentOn.current=null;setAwaiting(false);setState(null);setIdentity(next);setSelected(null);setFlipped(false);setMessage('');setError('');setInviteVisible(false);}
  async function request(path:string,data:unknown){const res=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await res.json();if(!res.ok)throw new Error(result.message||'The table is unavailable.');return result;}
  async function create(){setBusy(true);setError('');try{const [seconds,increment]=control.split('+').map(Number);enter(await request('/api/rooms',{seconds,increment}));}catch(e){setError((e as Error).message);}finally{setBusy(false);setConfirm(null);}}
  async function join(){
    if(!identity)return;setBusy(true);setError('');
    try {
      let storage:Storage;
      try {storage=window.sessionStorage;}catch{throw new Error('Enable browser storage before joining so your seat can be recovered after an interrupted request.');}
      const claimToken=prepareSeatClaim(storage,identity.roomId);
      setMessage('Your seat request is saved in this tab. If the connection interrupts, retry here.');
      const result=await request(`/api/rooms/${identity.roomId}/join`,{invite:identity.invite,claimToken});
      enter(result);completeSeatClaim(storage,identity.roomId);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  function send(command:Omit<PendingCommand,'commandId'|'expectedVersion'>){
    if(!state||connection!=='online'||awaiting)return;
    if(socket.current?.readyState!==WebSocket.OPEN){setError('The connection changed. Wait for your table to reconnect.');return;}
    try {
      const value={...command,commandId:makeCommandId(),expectedVersion:state.version};
      pending.current=value;sentOn.current=socket.current;setAwaiting(true);setError('');socket.current.send(JSON.stringify(value));setSelected(null);
    } catch(error) {pending.current=null;setAwaiting(false);setError(error instanceof Error?error.message:'The move could not be sent. Please try again.');}
  }
  function choose(square:string){if(!state||state.outcome||connection!=='online'||awaiting||state.turn!==state.seat)return;setError('');
    if(selected===square){setSelected(null);return;}
    const matches=state.legalMoves.filter(m=>m.from===selected&&m.to===square);
    if(matches.length){if(matches.some(m=>m.promotion))setPromotion({from:selected!,to:square});else send({type:'move',from:selected!,to:square});return;}
    setSelected(state.legalMoves.some(m=>m.from===square)?square:null);
  }
  const chess=new Chess(state?.fen),baseBlack=state?.seat==='b'||!!identity?.invite&&!identity?.token;
  const orientation=baseBlack!==flipped?'b':'w';
  const files=orientation==='w'?'abcdefgh':'hgfedcba',ranks=orientation==='w'?[8,7,6,5,4,3,2,1]:[1,2,3,4,5,6,7,8];
  const lastMove=state?.moves.at(-1),canMove=!!state&&!state.outcome&&state.blackJoined&&state.turn===state.seat&&connection==='online';
  const invitation=!!identity?.invite&&!identity?.token;
  const outcome=state?.outcome;
  const status=outcome?outcome.winner===null?'A well-played draw':outcome.winner===state?.seat?'The game is yours':'A game to learn from':!state?'A fresh board awaits':!state.blackJoined?'Save a seat for a friend':connection!=='online'?'Reconnecting to your table':state.turn===state.seat?state.check?'Your king is in check':'Your move. Take your time.':state.check?'Your friend is in check':'A little time to think.';
  function remaining(color:Color){if(!state)return control.split('+').map(Number)[0]*1000;const base=color==='w'?state.whiteMs:state.blackMs;return base-(state.running&&state.turn===color?Math.max(0,now-received):0);}
  function seatLabel(color:Color){return !state?color==='w'?'White pieces':'Black pieces':state.seat===color?'You':state.blackJoined?'Your friend':'Waiting for a friend';}
  const topColor:Color=orientation==='w'?'b':'w',bottomColor:Color=orientation==='w'?'w':'b';
  const inviteUrl=identity?.invite?`${location.origin}${location.pathname}#${new URLSearchParams({room:identity.roomId,invite:identity.invite})}`:'';
  async function copy(value:string,label:string){try{await navigator.clipboard.writeText(value);setMessage(label);}catch{setCopyValue(value);setMessage('Copy the link from the field below.');setInviteVisible(true);}}
  function keyboard(e:React.KeyboardEvent<HTMLButtonElement>,i:number){const delta:Record<string,number>={ArrowLeft:-1,ArrowRight:1,ArrowUp:-8,ArrowDown:8};if(e.key==='Escape'){setSelected(null);return;}if(e.key in delta){e.preventDefault();const next=Math.max(0,Math.min(63,i+delta[e.key]));(boardRef.current?.querySelectorAll('button')[next] as HTMLButtonElement)?.focus();}}
  function playerRow(color:Color){const active=!!state&&state.running&&state.turn===color;return <div className={`player-row ${active?'active':''}`}><div className={`avatar ${color==='w'?'ivory':'ink'}`}>{glyphs.k}</div><div className="player-name"><strong>{seatLabel(color)}</strong><span>{color==='w'?'White':'Black'}{state&&<><i className={state.online[color]?'presence':'presence absent'}/>{state.online[color]?'At the table':'Away'}</>}</span></div><div className={`clock ${active?'ticking':''} ${remaining(color)<20000&&state?.running?'low':''}`} aria-label={`${color==='w'?'White':'Black'} time remaining`}>{active&&<span className="clock-dot"/>}{clock(remaining(color))}</div></div>;}
  return <div className="app-shell">
    <header className="header"><a className="wordmark" href="/" onClick={e=>{if(state&&!state.outcome){e.preventDefault();setConfirm('new');}}}><span className="brand-mark">♞</span>open table<span className="brand-dot">.</span></a><div className="header-note"><span className="tiny-star">✳</span> GOOD GAMES, GOOD COMPANY</div><span className="edition">No. 001 / Chess</span></header>
    <main>
      <section className="intro"><div><p className="eyebrow">ONE BOARD. TWO PEOPLE.</p><h1>A little room to think.</h1><p className="intro-text">Pull up a chair. Share a link. Make your next move.</p></div><div className={`connection ${connection==='online'?'connected':''}`}><span/>{state?connection==='online'?'Table connected':connection==='connecting'?'Finding your table…':'Connection interrupted':'Private by invitation'}</div></section>
      <div className="game-layout">
        <section className="play-area" aria-label="Chess table">
          {playerRow(topColor)}
          <div className="board-frame"><div className="rank-labels" aria-hidden="true">{ranks.map(r=><span key={r}>{r}</span>)}</div><div className="board" ref={boardRef} role="grid" aria-label={`Chessboard, ${orientation==='w'?'White':'Black'} at the bottom. Arrow keys navigate; Enter or Space selects.`}>
            {ranks.flatMap((rank,row)=>[...files].map((file,col)=>{const square=file+rank,piece=chess.get(square as Square),target=selected&&state?.legalMoves.some(m=>m.from===selected&&m.to===square),last=lastMove&&(lastMove.from===square||lastMove.to===square);return <button key={square} type="button" role="gridcell" className={`square ${(file.charCodeAt(0)-97+rank)%2===0?'dark':'light'} ${selected===square?'selected':''} ${last?'last':''} ${target?'target':''} ${piece?.type==='k'&&piece.color===state?.turn&&state.check?'checked':''}`} aria-label={`${square}${piece?`, ${piece.color==='w'?'white':'black'} ${names[piece.type]}`:', empty'}${target?', legal destination':''}`} aria-selected={selected===square} onClick={()=>choose(square)} onKeyDown={e=>keyboard(e,row*8+col)} tabIndex={row===0&&col===0?0:-1}>{piece&&<span className={`piece ${piece.color==='w'?'white':'black'}`} aria-hidden="true">{glyphs[piece.type]}</span>}{target&&<span className={piece?'capture-ring':'move-dot'}/>}</button>;}))}
          </div><div className="file-labels" aria-hidden="true">{[...files].map(f=><span key={f}>{f}</span>)}</div></div>
          {playerRow(bottomColor)}
          <div className="board-caption"><span>{state?`Move ${Math.floor(state.moves.length/2)+1} · ${state.initialSeconds/60} + ${state.incrementMs/1000}`:'The best conversations happen across a board.'}</span><button className="text-button" onClick={()=>setFlipped(v=>!v)}><Icon name="rotate"/>Flip board</button></div>
        </section>
        <aside className="side-panel">
          <section className="status-card"><div className="status-heading"><span className={`status-indicator ${canMove?'live':''}`}/><p className="eyebrow">{outcome?'FINAL POSITION':state?'AT YOUR TABLE':'WELCOME TO OPEN TABLE'}</p></div><h2>{invitation?'A seat with your name on it.':status}</h2><p>{outcome?outcome.reason:invitation?'You’ve been invited to play Black. Take your seat when you’re ready.':!state?'A private game with someone you know. No accounts, no crowds, just chess.':!state.blackJoined?'Send your invitation. The clock starts after White makes the first move.':state.turn===state.seat?'Select a piece, then its destination. Legal moves are marked on the board.':'The board will update as soon as your friend makes a move.'}</p>
            {!identity?.token&&!invitation&&<><label className="field-label" htmlFor="time-control">SET THE PACE</label><select id="time-control" value={control} onChange={e=>setControl(e.target.value)}><option value="180+2">A quick game · 3 + 2</option><option value="300+3">A nice rhythm · 5 + 3</option><option value="600+5">Room to think · 10 + 5</option><option value="900+10">A slow afternoon · 15 + 10</option></select><button className="primary" disabled={busy} onClick={create}>{busy?'Setting the table…':'Create a private table'}<Icon name="arrow"/></button><div className="small-note">Minutes per player + seconds added per move.</div></>}
            {invitation&&<button className="primary" disabled={busy} onClick={join}>{busy?'Taking your seat…':'Take the Black seat'}<Icon name="arrow"/></button>}
            {identity?.token&&!state&&<p className="small-note">Connecting with your private seat link…</p>}
            {identity?.token&&identity.invite&&!state?.blackJoined&&<button className="primary" onClick={()=>copy(inviteUrl,'Invitation copied. Send it to your friend.')}><Icon name="link"/>Copy invitation</button>}
            {state&&state.blackJoined&&!outcome&&<div className="turn-note"><span className={state.turn==='w'?'turn-piece white-turn':'turn-piece'}>♟</span><span>{state.turn===state.seat?'You’re playing':'Your friend is playing'} {state.turn==='w'?'White':'Black'}{awaiting?' · Sending move…':''}</span></div>}
            {outcome&&<button className="primary" onClick={()=>setConfirm('new')}>Set a new table<Icon name="arrow"/></button>}
            {message&&<p className="feedback" role="status"><Icon name="check"/>{message}</p>}
            {error&&<p className="error" role="alert">{error}</p>}
            {inviteVisible&&<input className="copy-field" aria-label="Link to copy" value={copyValue} readOnly onFocus={e=>e.currentTarget.select()}/>}
          </section>
          <section className="moves-card"><div className="section-title"><h3>The game so far</h3><span>{state?.moves.length||0} moves</span></div>{!state?.moves.length?<div className="empty-moves"><span>♘</span><p>Every good game<br/>starts with a first move.</p></div>:<div className="moves-scroll" tabIndex={0} aria-label="Move history"><table><thead><tr><th>Turn</th><th>White</th><th>Black</th></tr></thead><tbody>{Array.from({length:Math.ceil(state.moves.length/2)},(_,i)=><tr key={i}><th>{i+1}.</th><td>{state.moves[i*2].san}</td><td>{state.moves[i*2+1]?.san||'—'}</td></tr>)}</tbody></table></div>}</section>
          {state&&<div className="table-actions"><button className="text-button" onClick={()=>copy(location.href,'Private seat link copied. Keep this one for yourself.')}><Icon name="copy"/>Save my seat link</button>{!outcome&&<button className="text-button muted" disabled={!state.blackJoined||awaiting||connection!=='online'} onClick={()=>setConfirm('resign')}>Resign</button>}</div>}
          <div className="house-note"><span>✳</span><p><strong>A friendly house rule.</strong> Clocks keep running if you disconnect. Return with your private seat link; your game will be waiting.</p></div>
        </aside>
      </div>
      <section className="quiet-details"><div><span>01</span><p><strong>Just you and a friend</strong>Private invitations. No accounts required.</p></div><div><span>02</span><p><strong>A shared, honest board</strong>One server keeps moves and clocks in sync.</p></div><div><span>03</span><p><strong>Come back to your game</strong>Your seat link brings you right back.</p></div></section>
    </main>
    <footer><span>OPEN TABLE · MADE FOR THE LOVE OF THE GAME</span><a href="https://github.com/jhlywa/chess.js" target="_blank" rel="noreferrer">Rules powered by chess.js ↗</a></footer>
    <dialog ref={dialogRef} onCancel={()=>{setConfirm(null);setPromotion(null);}}><div className="dialog-content">{promotion?<><p className="eyebrow">A NEW POSSIBILITY</p><h2>Choose your promotion.</h2><div className="promotion-options">{(['q','r','b','n'] as const).map(p=><button key={p} onClick={()=>{send({type:'move',...promotion,promotion:p});setPromotion(null);}}><span>{glyphs[p]}</span>{names[p]}</button>)}</div><button className="text-button" onClick={()=>setPromotion(null)}>Back to the board</button></>:<><p className="eyebrow">A MOMENT TO DECIDE</p><h2>{confirm==='resign'?'Ready to offer your hand?':'Set a new table?'}</h2><p>{confirm==='resign'?'Resigning ends this game and awards the win to your friend.':'This creates a new game with a new invitation. Keep your current seat link if you want to return; its clock will keep running.'}</p><div className="dialog-actions"><button className="secondary" onClick={()=>setConfirm(null)}>Keep playing</button><button className="primary" disabled={busy} onClick={()=>{if(confirm==='resign'){send({type:'resign'});setConfirm(null);}else void create();}}>{confirm==='resign'?'Resign game':'Create new table'}</button></div></>}</div></dialog>
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
