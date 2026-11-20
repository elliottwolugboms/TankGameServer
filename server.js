
// ======================================================
// TANK GAME - AUTHORITATIVE 2-PLAYER WEBSOCKET SERVER
// Supports room codes: HOST and JOIN
// ======================================================

const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;

// ---------------- CONFIGURATION ----------------

const W = 1280;
const H = 720;

const TANK_R = 22;
const MOVE_SPEED = 180;
const TURN_SPEED = 2.6;
const MAX_HP = 100;

const BULLET_SPEED = 600;
const BULLET_DMG = 25;
const BULLET_LIFE = 1.5;
const FIRE_COOLDOWN = 0.5;

const TICK = 1 / 60;
const SEND_EVERY = 3;

// ---------------- ROOM STORAGE ----------------

const rooms = new Map();

// ---------------- TANK CREATION ----------------

function makeTank(index, playerId) {
    return {
        playerId,
        ws: null,

        hp: MAX_HP,
        dmgDealt: 0,
        shots: 0,
        cooldown: 0,

        x: index === 0 ? 200 : W - 200,
        y: H / 2,

        angle: index === 0 ? 0 : Math.PI,
        turretAngle: index === 0 ? 0 : Math.PI,

        input: {
            up: false,
            down: false,
            left: false,
            right: false,
            fire: false
        }
    };
}

// ---------------- COMMUNICATION ----------------

function send(ws, message) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(message));
    }
}

function broadcast(room, message) {
    for (const tank of room.tanks) {
        send(tank.ws, message);
    }
}

function sendError(ws, message) {
    send(ws, {
        type: "error",
        message
    });
}

// ---------------- ROOM CODE GENERATION ----------------

function generateRoomCode() {
    const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code;

    do {
        code = "";

        for (let i = 0; i < 6; i++) {
            code += characters[
                crypto.randomInt(0, characters.length)
            ];
        }

    } while (rooms.has(code));

    return code;
}

// ---------------- HOST ROOM ----------------

function createRoom(ws, playerId) {
    const roomCode = generateRoomCode();

    const room = {
        roomCode,
        tanks: [],
        bullets: [],

        running: false,
        over: false,

        tick: 0
    };

    const tank = makeTank(0, playerId);

    tank.ws = ws;

    room.tanks.push(tank);

    rooms.set(roomCode, room);

    console.log("Room created:", roomCode);

    send(ws, {
        type: "room_created",
        roomCode,
        playerId
    });

    return {
        room,
        tank
    };
}

// ---------------- JOIN ROOM ----------------

function joinRoom(ws, playerId, roomCode) {
    const room = rooms.get(roomCode);

    if (!room) {
        sendError(ws, "Room does not exist.");
        return null;
    }

    if (room.over) {
        sendError(ws, "This room has already ended.");
        return null;
    }

    if (room.tanks.length >= 2) {
        sendError(ws, "This room is full.");
        return null;
    }

    if (room.running) {
        sendError(ws, "This game has already started.");
        return null;
    }

    const tank = makeTank(1, playerId);

    tank.ws = ws;

    room.tanks.push(tank);

    console.log("Player joined room:", roomCode);

    send(ws, {
        type: "joined",
        roomCode,
        playerId
    });

    room.running = true;

    broadcast(room, {
        type: "start",
        roomCode
    });

    console.log("Game started:", roomCode);

    return {
        room,
        tank
    };
}

// ---------------- END GAME ----------------

function finish(room, winner, decidedBy) {
    if (room.over) return;

    room.over = true;
    room.running = false;

    broadcast(room, {
        type: "end",
        winner: winner.playerId,
        decidedBy
    });

    console.log(
        "Game ended:",
        room.roomCode,
        "Winner:",
        winner.playerId,
        "Reason:",
        decidedBy
    );

    setTimeout(() => {
        rooms.delete(room.roomCode);
    }, 10000);
}

// ---------------- GAME SIMULATION ----------------

function step(room) {
    const [a, b] = room.tanks;

    if (!a || !b) return;

    // Move tanks
    for (const tank of room.tanks) {
        const input = tank.input;

        if (input.left) {
            tank.angle -= TURN_SPEED * TICK;
        }

        if (input.right) {
            tank.angle += TURN_SPEED * TICK;
        }

        const direction =
            (input.up ? 1 : 0) -
            (input.down ? 1 : 0);

        tank.x +=
            Math.cos(tank.angle) *
            direction *
            MOVE_SPEED *
            TICK;

        tank.y +=
            Math.sin(tank.angle) *
            direction *
            MOVE_SPEED *
            TICK;

        tank.x = Math.max(
            TANK_R,
            Math.min(W - TANK_R, tank.x)
        );

        tank.y = Math.max(
            TANK_R,
            Math.min(H - TANK_R, tank.y)
        );

        tank.cooldown = Math.max(
            0,
            tank.cooldown - TICK
        );

        // Fire bullets using turret direction
        if (input.fire && tank.cooldown <= 0) {
            tank.cooldown = FIRE_COOLDOWN;

            tank.shots++;

            const directionX = Math.cos(tank.turretAngle);
            const directionY = Math.sin(tank.turretAngle);

            room.bullets.push({
                x: tank.x + directionX * 30,
                y: tank.y + directionY * 30,

                vx: directionX * BULLET_SPEED,
                vy: directionY * BULLET_SPEED,

                owner: tank,
                life: BULLET_LIFE
            });
        }
    }

    // Move bullets and detect collisions
    room.bullets = room.bullets.filter(bullet => {
        bullet.x += bullet.vx * TICK;
        bullet.y += bullet.vy * TICK;

        bullet.life -= TICK;

        if (
            bullet.life <= 0 ||
            bullet.x < 0 ||
            bullet.x > W ||
            bullet.y < 0 ||
            bullet.y > H
        ) {
            return false;
        }

        const target = bullet.owner === a ? b : a;

        const distance = Math.hypot(
            target.x - bullet.x,
            target.y - bullet.y
        );

        if (distance < TANK_R) {
            target.hp -= BULLET_DMG;

            bullet.owner.dmgDealt += BULLET_DMG;

            return false;
        }

        return true;
    });

    // Check for defeated players
    const dead = room.tanks.filter(
        tank => tank.hp <= 0
    );

    if (dead.length === 1) {
        finish(
            room,
            dead[0] === a ? b : a,
            "score"
        );
    }

    else if (dead.length === 2) {
        const winner =
            a.dmgDealt !== b.dmgDealt
                ? (a.dmgDealt > b.dmgDealt ? a : b)
                : (a.shots !== b.shots
                    ? (a.shots < b.shots ? a : b)
                    : a);

        finish(room, winner, "tiebreak");
    }
}

// ---------------- GAME STATE ----------------

function snapshot(room) {
    return {
        type: "state",

        tanks: room.tanks.map(tank => ({
            id: tank.playerId,

            x: tank.x,
            y: tank.y,

            a: tank.angle,
            turretAngle: tank.turretAngle,

            hp: tank.hp
        })),

        bullets: room.bullets.map(bullet => ({
            x: bullet.x,
            y: bullet.y
        }))
    };
}

// ---------------- GAME LOOP ----------------

setInterval(() => {
    for (const room of rooms.values()) {
        if (!room.running || room.over) {
            continue;
        }

        step(room);

        room.tick++;

        if (room.tick % SEND_EVERY === 0) {
            broadcast(room, snapshot(room));
        }
    }
}, TICK * 1000);

// ---------------- WEBSOCKET SERVER ----------------

const wss = new WebSocketServer({
    port: PORT
});

wss.on("connection", ws => {
    console.log("New player connected.");

    let tank = null;
    let room = null;

    ws.on("message", raw => {
        let message;

        try {
            message = JSON.parse(raw.toString());
        } catch {
            sendError(ws, "Invalid message format.");
            return;
        }

        // HOST
        if (message.type === "host") {
            if (tank) {
                sendError(ws, "You are already in a room.");
                return;
            }

            if (
                typeof message.playerId !== "string" ||
                !message.playerId ||
                message.playerId.length > 64
            ) {
                sendError(ws, "Invalid player ID.");
                return;
            }

            const result = createRoom(
                ws,
                message.playerId
            );

            room = result.room;
            tank = result.tank;

            return;
        }

        // JOIN
        if (message.type === "join_room") {
            if (tank) {
                sendError(ws, "You are already in a room.");
                return;
            }

            if (
                typeof message.playerId !== "string" ||
                !message.playerId ||
                message.playerId.length > 64
            ) {
                sendError(ws, "Invalid player ID.");
                return;
            }

            const code = String(
                message.roomCode || ""
            ).trim().toUpperCase();

            if (!code) {
                sendError(ws, "Enter a room code.");
                return;
            }

            const result = joinRoom(
                ws,
                message.playerId,
                code
            );

            if (!result) return;

            room = result.room;
            tank = result.tank;

            return;
        }

        // PLAYER INPUT
        if (
            message.type === "input" &&
            tank &&
            room &&
            room.running &&
            !room.over
        ) {
            const input = message.input || {};

            tank.input = {
                up: !!input.up,
                down: !!input.down,
                left: !!input.left,
                right: !!input.right,
                fire: !!input.fire
            };

            // Accept independent turret direction.
            if (
                typeof input.turretAngle === "number" &&
                Number.isFinite(input.turretAngle)
            ) {
                tank.turretAngle = input.turretAngle;
            } else {
                tank.turretAngle = tank.angle;
            }

            return;
        }
    });

    // ---------------- DISCONNECT ----------------

    ws.on("close", () => {
        console.log("Player disconnected.");

        if (!tank || !room || room.over) {
            return;
        }

        tank.ws = null;

        // Host disconnected before the game started.
        if (!room.running) {
            rooms.delete(room.roomCode);

            console.log(
                "Waiting room deleted:",
                room.roomCode
            );

            return;
        }

        // Opponent wins by forfeit.
        const opponent = room.tanks.find(
            other => other !== tank
        );

        if (opponent) {
            finish(room, opponent, "forfeit");
        }
    });

    ws.on("error", error => {
        console.error("WebSocket error:", error.message);
    });
});

// ---------------- SERVER START ----------------

console.log(
    "Tank multiplayer server listening on port " + PORT
);
