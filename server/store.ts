import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Chess, type Color, type Square } from 'chess.js';

export type Outcome = { winner: Color | null; reason: string };
export type PlayedMove = { san: string; from: string; to: string; color: Color; promotion?: string };
export type Game = { version: number; moves: PlayedMove[]; whiteMs: number; blackMs: number; incrementMs: number; initialSeconds: number; anchor: number; started: boolean; outcome: Outcome | null };
type Row = { id: string; white_hash: string; black_hash: string | null; invite_hash: string; state: string };
export type Command = { type: 'move'; commandId: string; expectedVersion: number; from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' } | { type: 'resign'; commandId: string; expectedVersion: number };
export type Receipt = { type: 'ack'; commandId: string; ok: boolean; version: number; code?: string; message?: string };
const secret = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sameHash = (a: string, b: string) => timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const ROOM_ID = /^[a-zA-Z0-9_-]{16}$/;
export class Problem extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

export function parseCommand(input: unknown): Command {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Problem('invalid_command', 'Expected a command object.');
  const c = input as Record<string, unknown>;
  if (typeof c.commandId !== 'string' || !/^[\w-]{8,80}$/.test(c.commandId) || !Number.isSafeInteger(c.expectedVersion) || Number(c.expectedVersion) < 0)
    throw new Problem('invalid_command', 'A command ID and nonnegative integer version are required.');
  if (c.type === 'resign') return { type: 'resign', commandId: c.commandId, expectedVersion: Number(c.expectedVersion) };
  if (c.type !== 'move' || typeof c.from !== 'string' || typeof c.to !== 'string' || !/^[a-h][1-8]$/.test(c.from) || !/^[a-h][1-8]$/.test(c.to) || (c.promotion !== undefined && !['q','r','b','n'].includes(String(c.promotion))))
    throw new Problem('invalid_command', 'Choose valid source, destination and promotion pieces.');
  return { type: 'move', commandId: c.commandId, expectedVersion: Number(c.expectedVersion), from: c.from, to: c.to, ...(c.promotion !== undefined ? { promotion: c.promotion as 'q' | 'r' | 'b' | 'n' } : {}) };
}

export class GameStore {
  readonly db: DatabaseSync;
  constructor(path: string, private now: () => number = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, white_hash TEXT NOT NULL, black_hash TEXT, invite_hash TEXT NOT NULL, state TEXT NOT NULL, deadline INTEGER);
      CREATE INDEX IF NOT EXISTS room_deadline ON rooms(deadline);
      CREATE TABLE IF NOT EXISTS commands(room_id TEXT NOT NULL, command_id TEXT NOT NULL, actor TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(room_id,command_id));
      CREATE TABLE IF NOT EXISTS moves(room_id TEXT NOT NULL, ply INTEGER NOT NULL, command_id TEXT NOT NULL, san TEXT NOT NULL, fen TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(room_id,ply));`);
  }
  private transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  private row(id: string): Row {
    if (!ROOM_ID.test(id)) throw new Problem('room_not_found', 'This table could not be found.', 404);
    const row = this.db.prepare('SELECT * FROM rooms WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Problem('room_not_found', 'This table could not be found.', 404);
    return row;
  }
  private game(row: Row): Game { return JSON.parse(row.state) as Game; }
  private chess(g: Game): Chess { const chess = new Chess(); for (const move of g.moves) chess.move(move.san); return chess; }
  private write(id: string, g: Game) {
    const turn = g.moves.length % 2 === 0 ? 'w' : 'b';
    const deadline = g.started && !g.outcome ? g.anchor + (turn === 'w' ? g.whiteMs : g.blackMs) : null;
    this.db.prepare('UPDATE rooms SET state=?,deadline=? WHERE id=?').run(JSON.stringify(g), deadline, id);
  }
  create(seconds: number, increment: number) {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600 || !Number.isInteger(increment) || increment < 0 || increment > 30) throw new Problem('invalid_clock', 'Use 1–3600 seconds and an increment of 0–30 seconds.');
    const id = randomBytes(12).toString('base64url'), token = secret(), invite = secret();
    const game: Game = { version: 0, moves: [], whiteMs: seconds * 1000, blackMs: seconds * 1000, incrementMs: increment * 1000, initialSeconds: seconds, anchor: this.now(), started: false, outcome: null };
    this.db.prepare('INSERT INTO rooms(id,white_hash,invite_hash,state) VALUES(?,?,?,?)').run(id,digest(token),digest(invite),JSON.stringify(game));
    return { roomId: id, token, invite };
  }
  join(id: string, invite: unknown) {
    if (typeof invite !== 'string' || invite.length !== 43) throw new Problem('invalid_invite', 'That invitation is invalid.', 403);
    return this.transaction(() => {
      const row = this.row(id);
      if (!sameHash(row.invite_hash, digest(invite))) throw new Problem('invalid_invite', 'That invitation is invalid.', 403);
      if (row.black_hash) throw new Problem('invite_claimed', 'The Black seat has already been claimed. Use your saved seat link to return.', 409);
      const token = secret();
      this.db.prepare('UPDATE rooms SET black_hash=? WHERE id=?').run(digest(token),id);
      return { roomId: id, token };
    });
  }
  authenticate(id: string, token: unknown): Color {
    if (typeof token !== 'string' || token.length !== 43) throw new Problem('unauthorized', 'The private seat link is invalid.', 403);
    const row = this.row(id), hashed = digest(token);
    if (sameHash(row.white_hash,hashed)) return 'w';
    if (row.black_hash && sameHash(row.black_hash,hashed)) return 'b';
    throw new Problem('unauthorized', 'The private seat link is invalid.', 403);
  }
  private remaining(g: Game, now: number) {
    const turn = g.moves.length % 2 === 0 ? 'w' : 'b';
    const elapsed = g.started && !g.outcome ? Math.max(0, now-g.anchor) : 0;
    return { whiteMs: Math.max(0,g.whiteMs-(turn === 'w' ? elapsed : 0)), blackMs: Math.max(0,g.blackMs-(turn === 'b' ? elapsed : 0)) };
  }
  private expire(id: string, g: Game, now: number): boolean {
    if (!g.started || g.outcome) return false;
    const clocks = this.remaining(g,now), turn = g.moves.length % 2 === 0 ? 'w' : 'b';
    if ((turn === 'w' ? clocks.whiteMs : clocks.blackMs) > 0) return false;
    const winner = turn === 'w' ? 'b' : 'w', chess = this.chess(g);
    const otherHasPiece = chess.board().flat().some(p=>p && p.color === winner && p.type !== 'k');
    Object.assign(g,clocks);
    g.anchor = now; g.version++;
    g.outcome = !otherHasPiece || chess.isInsufficientMaterial() ? { winner: null, reason: 'Timeout · insufficient material' } : { winner, reason: 'Time expired' };
    this.write(id,g); return true;
  }
  expireDue(): string[] {
    const now = this.now();
    const rows = this.db.prepare('SELECT id FROM rooms WHERE deadline IS NOT NULL AND deadline<=?').all(now) as {id:string}[];
    return rows.filter(({id}) => this.transaction(() => this.expire(id,this.game(this.row(id)),now))).map(r=>r.id);
  }
  snapshot(id: string, seat: Color) {
    return this.transaction(() => {
      const row = this.row(id), g = this.game(row), now = this.now(); this.expire(id,g,now);
      const chess = this.chess(g);
      return { type: 'state' as const, roomId: id, seat, version: g.version, fen: chess.fen(), moves: g.moves, ...this.remaining(g,now), initialSeconds: g.initialSeconds, incrementMs: g.incrementMs, running: g.started && !g.outcome, turn: chess.turn(), outcome: g.outcome, check: chess.isCheck(), blackJoined: !!row.black_hash, serverNow: now, legalMoves: !g.outcome && seat === chess.turn() && !!row.black_hash ? chess.moves({verbose:true}).map(m=>({from:m.from,to:m.to,promotion:m.promotion})) : [] };
    });
  }
  command(id: string, seat: Color, command: Command): Receipt {
    return this.transaction(() => {
      const row = this.row(id), g = this.game(row), now = this.now(); this.expire(id,g,now);
      const payload = JSON.stringify(command);
      const prior = this.db.prepare('SELECT actor,payload,receipt FROM commands WHERE room_id=? AND command_id=?').get(id,command.commandId) as {actor:string,payload:string,receipt:string} | undefined;
      if (prior) {
        if (prior.actor !== seat || prior.payload !== payload) return {type:'ack',commandId:command.commandId,ok:false,version:g.version,code:'command_conflict',message:'This command ID belongs to another action.'};
        return JSON.parse(prior.receipt) as Receipt;
      }
      const fail = (code: string, message: string): Receipt => ({ type:'ack',commandId:command.commandId,ok:false,version:g.version,code,message });
      let reply: Receipt;
      if (command.expectedVersion !== g.version) reply = fail('stale_version','The table changed. Try again from the current position.');
      else if (g.outcome) reply = fail('game_over','This game has ended.');
      else if (!row.black_hash) reply = fail('waiting_for_opponent','Invite a friend before making the first move.');
      else if (command.type === 'resign') {
        Object.assign(g,this.remaining(g,now)); g.anchor = now; g.outcome = {winner:seat === 'w' ? 'b' : 'w',reason:'Resignation'}; g.version++;
        this.write(id,g); reply = {type:'ack',commandId:command.commandId,ok:true,version:g.version};
      } else {
        const chess = this.chess(g);
        if (chess.turn() !== seat) reply = fail('out_of_turn','It is your friend’s turn.');
        else {
          let move;
          try { move = chess.move({from:command.from as Square,to:command.to as Square,promotion:command.promotion}); } catch { move = null; }
          if (!move) reply = fail('illegal_move','That move is not legal.');
          else {
            Object.assign(g,this.remaining(g,now));
            if (seat === 'w') g.whiteMs += g.incrementMs; else g.blackMs += g.incrementMs;
            g.moves.push({san:move.san,from:move.from,to:move.to,color:move.color,...(move.promotion ? {promotion:move.promotion} : {})});
            g.started = true; g.anchor = now; g.version++;
            if (chess.isCheckmate()) g.outcome = {winner:seat,reason:'Checkmate'};
            else if (chess.isStalemate()) g.outcome = {winner:null,reason:'Stalemate'};
            else if (chess.isInsufficientMaterial()) g.outcome = {winner:null,reason:'Insufficient material'};
            else if (chess.isThreefoldRepetition()) g.outcome = {winner:null,reason:'Threefold repetition'};
            else if (chess.isDrawByFiftyMoves()) g.outcome = {winner:null,reason:'Fifty-move rule'};
            else if (g.moves.length >= 2048) g.outcome = {winner:null,reason:'2048-ply room limit'};
            this.write(id,g);
            this.db.prepare('INSERT INTO moves(room_id,ply,command_id,san,fen,created_at) VALUES(?,?,?,?,?,?)').run(id,g.moves.length,command.commandId,move.san,chess.fen(),now);
            reply = {type:'ack',commandId:command.commandId,ok:true,version:g.version};
          }
        }
      }
      this.db.prepare('INSERT INTO commands(room_id,command_id,actor,payload,receipt,created_at) VALUES(?,?,?,?,?,?)').run(id,command.commandId,seat,payload,JSON.stringify(reply),now);
      return reply;
    });
  }
  close() { this.db.close(); }
}
