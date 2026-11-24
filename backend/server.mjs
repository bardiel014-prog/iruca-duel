import { randomBytes, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { roster, fresh, attacks, defenses, resolve, cap, limit } from './rules.mjs';

const db = new DatabaseSync(process.env.KENKI_DB ?? 'kenki-friend.sqlite');
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)');
const getRoom = db.prepare('SELECT data FROM rooms WHERE code = ? AND expires > ?');
const saveRoom = db.prepare('INSERT INTO rooms VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET data=excluded.data,expires=excluded.expires');
const pruneRooms = db.prepare('DELETE FROM rooms WHERE expires <= ?');
const day = 86400000;
const choiceMs = 20000;
const confirmMs = 5000;
const openingMs = 1750;
const cookieName = 'kenki_friend';

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function requireState(condition, message, status = 409) {
  if (!condition) throw new RequestError(status,message);
}

function publicRoom(room, seat) {
  return {
    code:room.code, seat, revision:room.revision, match:room.match, phase:room.phase,
    fighters:room.fighters, occupied:room.seats.map(Boolean),
    acknowledged:room.acknowledged, turn:room.turn, attacker:room.attacker,
    players:room.players, result:room.result, deadline:room.deadline ?? null, serverNow:Date.now(),
    revealed:room.phase === 'reveal' && seat !== room.attacker ? room.attack : null,
  };
}

function play(room, seat, move) {
  const {fighters,players,attacker} = room;
  if (room.phase === 'attack') {
    requireState(seat === attacker && attacks(fighters,players,seat).includes(move),'この攻め技は使えません。');
    room.attack = move;
    room.phase = 'defend';
    return;
  }
  requireState(['defend','reveal'].includes(room.phase) && seat !== attacker &&
    defenses(fighters,players,seat,room.phase).includes(move),'この受け技は使えません。');
  if (move === 'two') {
    players[seat].special--;
    room.phase = 'reveal';
    return;
  }
  const previousLife = players.map(player=>cap-player.damage);
  const {passiveEffects} = resolve(fighters,players,attacker,room.attack,move);
  room.result = {attack:room.attack,defense:move,previousLife,passiveEffects};
  room.attack = null;
  room.acknowledged = [false,false];
  room.phase = players.some(player=>player.damage === cap) || room.turn === limit ? 'done' : 'result';
}

function resetLobby(room) {
  Object.assign(room,{phase:'lobby',fighters:[null,null],players:null,result:null,
    acknowledged:[false,false],turn:null,attacker:null});
}

function advanceTurn(room) {
  room.turn++;
  room.attacker = 1-room.attacker;
  room.result = null;
  room.acknowledged = [false,false];
  room.phase = 'attack';
}

function setDeadline(room, now) {
  const duration = room.phase === 'opening' ? openingMs + confirmMs
    : ['attack','defend','reveal'].includes(room.phase) ? choiceMs
    : ['result','done'].includes(room.phase) ? confirmMs : 0;
  room.deadline = duration ? now + duration : null;
}

function applyTimeout(room, now) {
  if (room.deadline === undefined) {
    setDeadline(room,now);
  } else if (!room.deadline || room.deadline > now) {
    return;
  } else {
    const {fighters,players,attacker} = room;
    switch (room.phase) {
      case 'opening':
        room.phase = 'attack';
        room.acknowledged = [false,false];
        break;
      case 'attack':
        play(room,attacker,attacks(fighters,players,attacker)[0]);
        break;
      case 'defend':
      case 'reveal':
        play(room,1-attacker,defenses(fighters,players,1-attacker,room.phase)[0]);
        break;
      case 'result':
        advanceTurn(room);
        break;
      case 'done':
        resetLobby(room);
        break;
    }
    setDeadline(room,now);
  }
  room.revision++;
  saveRoom.run(room.code,JSON.stringify(room),now+day);
}

function updateRoom(room, seat, input) {
  const sameStep = input.match === room.match && input.phase === room.phase && input.turn === room.turn;
  requireState(sameStep && (input.op !== 'move' || input.revision === room.revision),
    '盤面が更新されました。もう一度操作してください。');
  switch (input.op) {
    case 'pick':
      requireState(room.phase === 'lobby' && room.seats.every(Boolean) && room.fighters[seat] === null && Number.isInteger(input.fighter) && input.fighter >= 0 &&
        input.fighter < roster.length,'剣士を選べません。');
      room.fighters[seat] = input.fighter;
      if (room.fighters.every(Number.isInteger)) {
        room.players = fresh(room.fighters);
        room.match++;
        room.turn = 1;
        room.attacker = randomInt(2);
        room.phase = 'opening';
      }
      break;
    case 'ready':
      requireState(room.phase === 'opening','すでに戦闘が始まりました。');
      room.acknowledged[seat] = true;
      if (room.acknowledged.every(Boolean)) {
        room.phase = 'attack';
        room.acknowledged = [false,false];
      }
      break;
    case 'move':
      play(room,seat,input.move);
      break;
    case 'next':
      requireState(room.phase === 'result','次のターンには進めません。');
      room.acknowledged[seat] = true;
      if (room.acknowledged.every(Boolean)) advanceTurn(room);
      break;
    case 'rematch':
      requireState(room.phase === 'done','再戦は決着後に選べます。');
      room.acknowledged[seat] = true;
      if (room.acknowledged.every(Boolean)) resetLobby(room);
      break;
    default:
      throw new RequestError(400,'操作が無効です。');
  }
}

async function parseBody(req) {
  const body = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new RequestError(413,'リクエストが大きすぎます。');
    body.push(chunk);
  }
  try {
    const input = JSON.parse(Buffer.concat(body).toString());
    if (input && typeof input === 'object' && !Array.isArray(input)) return input;
  } catch {}
  throw new RequestError(400,'入力を読み取れません。');
}

async function api(req,res,url) {
  const token = req.headers.cookie?.match(/(?:^|;\s*)kenki_friend=([a-f0-9]{48})(?:;|$)/)?.[1];
  const now = Date.now();
  if (req.method === 'GET') {
    const room = loadRoom(url.searchParams.get('code'),now);
    const seat = room.seats.indexOf(token);
    requireState(seat >= 0,'この部屋に参加してください。',403);
    applyTimeout(room,now);
    return json(res,publicRoom(room,seat));
  }
  requireState(req.method === 'POST','操作が無効です。',405);
  requireState(req.headers['sec-fetch-site'] !== 'cross-site' &&
    req.headers['content-type']?.split(';')[0] === 'application/json','リクエストを確認できません。',403);
  const input = await parseBody(req);
  const guest = token ?? randomBytes(24).toString('hex');
  let room, seat;
  if (input.op === 'create') {
    pruneRooms.run(now);
    let code;
    do { code = randomBytes(5).toString('hex'); } while (getRoom.get(code,now));
    room = {code,seats:[guest,null],revision:0,match:0,phase:'lobby',fighters:[null,null],
      acknowledged:[false,false],turn:null,attacker:null,players:null,result:null,attack:null,deadline:null};
    seat = 0;
  } else {
    room = loadRoom(input.code,now);
    seat = room.seats.indexOf(guest);
    if (input.op === 'join' && seat < 0) {
      seat = room.seats.indexOf(null);
      requireState(seat >= 0,'この部屋は満員です。');
      room.seats[seat] = guest;
    } else if (input.op !== 'join') {
      requireState(seat >= 0,'この部屋に参加してください。',403);
      const actionTime = Date.now();
      applyTimeout(room,actionTime);
      const priorPhase = room.phase;
      const priorTurn = room.turn;
      updateRoom(room,seat,input);
      if (priorPhase !== room.phase || priorTurn !== room.turn) setDeadline(room,actionTime);
    }
  }
  room.revision++;
  saveRoom.run(room.code,JSON.stringify(room),now+day);
  if (!token) {
    const secure = req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie',`${cookieName}=${guest}; HttpOnly; SameSite=Strict; Path=/duel/; Max-Age=86400${secure ? '; Secure' : ''}`);
  }
  json(res,publicRoom(room,seat));
}
function loadRoom(code,now) {
  requireState(typeof code === 'string' && /^[a-f0-9]{10}$/.test(code),'招待リンクを確認してください。',400);
  const row = getRoom.get(code,now);
  requireState(row,'部屋が見つかりません。',404);
  return JSON.parse(row.data);
}
function json(res,data,status=200) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(data));
}

const server = createServer(async (req,res)=>{
  try {
    const url = new URL(req.url,'http://localhost');
    if (url.pathname === '/duel/friend-api') return await api(req,res,url);
    if (url.pathname === '/duel') return res.writeHead(308,{Location:'/duel/'}).end();
    if (!['GET','HEAD'].includes(req.method)) return res.writeHead(405).end();
    const path = url.pathname.slice('/duel/'.length);
    if (!url.pathname.startsWith('/duel/') ||
        !/^(?:index\.html|rules\.mjs|assets\/v20\/[a-z0-9-]+\.webp)?$/.test(path)) {
      return res.writeHead(404).end();
    }
    const file = await readFile(new URL(path || 'index.html',import.meta.url));
    const type = path.endsWith('.mjs') ? 'text/javascript' : path.endsWith('.webp') ? 'image/webp' : 'text/html';
    res.writeHead(200,{'Content-Type':type,'X-Content-Type-Options':'nosniff'});
    res.end(req.method === 'HEAD' ? undefined : file);
  } catch (error) {
    if (error instanceof RequestError) return json(res,{error:error.message},error.status);
    if (error.code === 'ENOENT') return res.writeHead(404).end();
    console.error(error);
    json(res,{error:'通信に失敗しました。'},500);
  }
});
server.requestTimeout = 10000;
server.listen(Number(process.env.PORT ?? 4188),process.env.HOST ?? '127.0.0.1');
