// Authoritative 2-player tank server with automatic matchmaking.
// Players send inputs; the server decides everything.

const { WebSocketServer } = require("ws");
const PORT = process.env.PORT || 8080;

const W = 1280, H = 720;
const TANK_R = 22, MOVE_SPEED = 180, TURN_SPEED = 2.6, MAX_HP = 100;
const BULLET_SPEED = 600, BULLET_DMG = 25, BULLET_LIFE = 1.5, FIRE_COOLDOWN = 0.5;
const TICK = 1 / 60, SEND_EVERY = 3;

const rooms = new Map();
let waitingRoom = null;   // a room with one player waiting for an opponent
let nextRoomId = 1;

function makeTank(i, playerId) {
  return {
    playerId, ws: null, hp: MAX_HP, dmgDealt: 0, shots: 0, cooldown: 0,
    x: i === 0 ? 200 : W - 200, y: H / 2, angle: i === 0 ? 0 : Math.PI,
    input: { up: false, down: false, left: false, right: false, fire: false }
  };
}

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg) { room.tanks.forEach(t => send(t.ws, msg)); }

// Put the player in the waiting room, or pair them with the player already waiting.
function findMatch(ws, playerId) {
  if (waitingRoom && (waitingRoom.over || !waitingRoom.tanks[0].ws || waitingRoom.tanks[0].ws.readyState !== 1)) {
    rooms.delete(waitingRoom.matchId);
    waitingRoom = null;
  }
  if (!waitingRoom) {
    const room = { matchId: "m" + nextRoomId++, tanks: [], bullets: [], running: false, over: false, tick: 0 };
    const tank = makeTank(0, playerId);
    tank.ws = ws;
    room.tanks.push(tank);
    rooms.set(room.matchId, room);
    waitingRoom = room;
    send(ws, { type: "waiting" });
    return { room, tank };
  }
  const room = waitingRoom;
  waitingRoom = null;
  const tank = makeTank(1, playerId);
  tank.ws = ws;
  room.tanks.push(tank);
  room.running = true;
  broadcast(room, { type: "start" });
  console.log("Match started:", room.matchId);
  return { room, tank };
}

function finish(room, winner, decidedBy) {
  if (room.over) return;
  room.over = true;
  room.running = false;
  broadcast(room, { type: "end", winner: winner.playerId, decidedBy });
  console.log("Match over:", room.matchId, "winner", winner.playerId, decidedBy);
  setTimeout(() => rooms.delete(room.matchId), 5000);
}

function step(room) {
  const [a, b] = room.tanks;
  if (!a || !b) return;

  for (const t of room.tanks) {
    const i = t.input;
    if (i.left) t.angle -= TURN_SPEED * TICK;
    if (i.right) t.angle += TURN_SPEED * TICK;
    const dir = (i.up ? 1 : 0) - (i.down ? 1 : 0);
    t.x = Math.min(W - TANK_R, Math.max(TANK_R, t.x + Math.cos(t.angle) * dir * MOVE_SPEED * TICK));
    t.y = Math.min(H - TANK_R, Math.max(TANK_R, t.y + Math.sin(t.angle) * dir * MOVE_SPEED * TICK));
    t.cooldown = Math.max(0, t.cooldown - TICK);
    if (i.fire && t.cooldown === 0) {
      t.cooldown = FIRE_COOLDOWN;
      t.shots++;
      room.bullets.push({
        x: t.x + Math.cos(t.angle) * 30, y: t.y + Math.sin(t.angle) * 30,
        vx: Math.cos(t.angle) * BULLET_SPEED, vy: Math.sin(t.angle) * BULLET_SPEED,
        owner: t, life: BULLET_LIFE
      });
    }
  }

  room.bullets = room.bullets.filter(bu => {
    bu.x += bu.vx * TICK;
    bu.y += bu.vy * TICK;
    bu.life -= TICK;
    if (bu.life <= 0 || bu.x < 0 || bu.x > W || bu.y < 0 || bu.y > H) return false;
    const target = bu.owner === a ? b : a;
    if (Math.hypot(target.x - bu.x, target.y - bu.y) < TANK_R) {
      target.hp -= BULLET_DMG;
      bu.owner.dmgDealt += BULLET_DMG;
      return false;
    }
    return true;
  });

  const dead = room.tanks.filter(t => t.hp <= 0);
  if (dead.length === 1) {
    finish(room, dead[0] === a ? b : a, "score");
  } else if (dead.length === 2) {
    // Both died on the same tick. No draws allowed: tie-break, then backup tie-break.
    const w = a.dmgDealt !== b.dmgDealt ? (a.dmgDealt > b.dmgDealt ? a : b)
            : a.shots !== b.shots ? (a.shots < b.shots ? a : b)
            : a;
    finish(room, w, a.dmgDealt !== b.dmgDealt ? "tiebreak" : "tiebreak-backup");
  }
}

function snapshot(room) {
  return {
    type: "state",
    tanks: room.tanks.map(t => ({ id: t.playerId, x: t.x, y: t.y, a: t.angle, hp: t.hp })),
    bullets: room.bullets.map(b => ({ x: b.x, y: b.y }))
  };
}

setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.running || room.over) continue;
    step(room);
    room.tick++;
    if (room.tick % SEND_EVERY === 0) broadcast(room, snapshot(room));
  }
}, TICK * 1000);

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", ws => {
  let tank = null;
  let room = null;

  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.type === "find_match" && (!tank || (room && room.over))) {
      if (typeof m.playerId !== "string" || !m.playerId || m.playerId.length > 64) {
        return send(ws, { type: "error", message: "Invalid player ID" });
      }
      const result = findMatch(ws, m.playerId);
      room = result.room;
      tank = result.tank;
    } else if (m.type === "input" && tank && room && room.running && !room.over) {
      const i = m.input || {};
      tank.input = { up: !!i.up, down: !!i.down, left: !!i.left, right: !!i.right, fire: !!i.fire };
    }
  });

  ws.on("close", () => {
    if (!tank || !room || room.over) return;
    tank.ws = null;
    if (!room.running) {
      // left while waiting for an opponent
      rooms.delete(room.matchId);
      if (waitingRoom === room) waitingRoom = null;
      return;
    }
    // left in the middle of a match: the other player wins by forfeit
    const other = room.tanks.find(t => t !== tank);
    if (other) finish(room, other, "forfeit");
  });
});

console.log("Tank server listening on port " + PORT);
