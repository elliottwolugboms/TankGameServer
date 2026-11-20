
// Authoritative 2-player tank multiplayer server
// Node.js + WebSocket
// Players send inputs; the server controls the simulation.

const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;

// WORLD SETTINGS
const W = 1280;
const H = 720;

// TANK SETTINGS
const TANK_R = 22;
const MOVE_SPEED = 180;
const TURN_SPEED = 2.6;
const MAX_HP = 100;

// BULLET SETTINGS
const BULLET_SPEED = 600;
const BULLET_DMG = 25;
const BULLET_LIFE = 1.5;
const FIRE_COOLDOWN = 0.5;

// SIMULATION SETTINGS
const TICK = 1 / 60;
const SEND_EVERY = 3;

// ROOM STORAGE
const rooms = new Map();

// CREATE A TANK
function makeTank(i, playerId) {
    return {
        playerId,
        ws: null,

        hp: MAX_HP,
        dmgDealt: 0,
        shots: 0,
        cooldown: 0,

        x: i === 0 ? 200 : W - 200,
        y: H / 2,

        angle: i === 0 ? 0 : Math.PI,

        input: {
            up: false,
            down: false,
            left: false,
            right: false,
            fire: false
        }
    };
}

// GENERATE ROOM CODE
function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code;

    do {
        code = "";

        for (let i = 0; i < 6; i++) {
            code += chars[Math.floor(Math.random() * chars.length)];
        }

    } while (rooms.has(code));

    return code;
}

// SEND MESSAGE
function send(ws, msg) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(msg));
    }
}

// BROADCAST TO ROOM
function broadcast(room, msg) {
    room.tanks.forEach(tank => {
        send(tank.ws, msg);
    });
}

// CREATE ROOM
function createRoom(ws, playerId) {
    const roomCode = generateRoomCode();

    const room = {
        matchId: roomCode,
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

    return { room, tank };
}

// END MATCH
function finish(room, winner, decidedBy) {
    if (room.over) return;

    room.over = true;
    room.running = false;

    broadcast(room, {
        type: "end",
        winner: winner.playerId,
        decidedBy
    });
}

// SIMULATION
function step(room) {
    const [a, b] = room.tanks;

    if (!a || !b) return;

    // TANK MOVEMENT
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

        tank.x = Math.min(
            W - TANK_R,
            Math.max(
                TANK_R,
                tank.x +
                Math.cos(tank.angle) *
                direction *
                MOVE_SPEED *
                TICK
            )
        );

        tank.y = Math.min(
            H - TANK_R,
            Math.max(
                TANK_R,
                tank.y +
                Math.sin(tank.angle) *
                direction *
                MOVE_SPEED *
                TICK
            )
        );

        // FIRE COOLDOWN
        tank.cooldown = Math.max(
            0,
            tank.cooldown - TICK
        );

        // SHOOT
        if (input.fire && tank.cooldown === 0) {
            tank.cooldown = FIRE_COOLDOWN;
            tank.shots++;

            room.bullets.push({
                x: tank.x + Math.cos(tank.angle) * 30,
                y: tank.y + Math.sin(tank.angle) * 30,

                vx: Math.cos(tank.angle) * BULLET_SPEED,
                vy: Math.sin(tank.angle) * BULLET_SPEED,

                owner: tank,
                life: BULLET_LIFE
            });
        }
    }

    // BULLET MOVEMENT AND COLLISION
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

        const target =
            bullet.owner === a ? b : a;

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

    // CHECK DEATH
    const dead = room.tanks.filter(
        tank => tank.hp <= 0
    );

    if (dead.length === 1) {
        const winner = dead[0] === a ? b : a;

        finish(room, winner, "score");
    }

    else if (dead.length === 2) {
        const winner =
            a.dmgDealt !== b.dmgDealt
                ? (a.dmgDealt > b.dmgDealt ? a : b)
                : a;

        finish(room, winner, "tiebreak");
    }
}

// GAME STATE SNAPSHOT
function snapshot(room) {
    return {
        type: "state",

        tanks: room.tanks.map(tank => ({
            id: tank.playerId,
            x: tank.x,
            y: tank.y,
            a: tank.angle,
            hp: tank.hp
        })),

        bullets: room.bullets.map(bullet => ({
            x: bullet.x,
            y: bullet.y
        }))
    };
}

// GAME LOOP
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

// WEBSOCKET SERVER
const wss = new WebSocketServer({
    port: PORT
});

wss.on("connection", ws => {

    let tank = null;
    let room = null;

    ws.on("message", raw => {

        let message;

        try {
            message = JSON.parse(raw.toString());
        }

        catch {
            return send(ws, {
                type: "error",
                message: "Invalid message"
            });
        }

        // HOST GAME
        if (message.type === "host" && !tank) {

            if (
                typeof message.playerId !== "string" ||
                !message.playerId ||
                message.playerId.length > 64
            ) {
                return send(ws, {
                    type: "error",
                    message: "Invalid player ID"
                });
            }

            const result = createRoom(
                ws,
                message.playerId
            );

            room = result.room;
            tank = result.tank;

            send(ws, {
                type: "room_created",
                roomCode: room.matchId,
                playerId: tank.playerId
            });

            console.log(
                "Room created:",
                room.matchId
            );
        }

        // JOIN GAME
        else if (
            message.type === "join_room" &&
            !tank
        ) {

            const roomCode = String(
                message.roomCode || ""
            ).toUpperCase();

            if (
                typeof message.playerId !== "string" ||
                !message.playerId ||
                message.playerId.length > 64
            ) {
                return send(ws, {
                    type: "error",
                    message: "Invalid player ID"
                });
            }

            room = rooms.get(roomCode);

            if (!room || room.over) {
                room = null;

                return send(ws, {
                    type: "error",
                    message: "Room not found"
                });
            }

            if (
                room.tanks.length >= 2 ||
                room.running
            ) {
                room = null;

                return send(ws, {
                    type: "error",
                    message: "Room is full"
                });
            }

            tank = makeTank(
                1,
                message.playerId
            );

            tank.ws = ws;

            room.tanks.push(tank);

            send(ws, {
                type: "joined",
                roomCode,
                playerId: tank.playerId
            });

            room.running = true;

            broadcast(room, {
                type: "start"
            });

            console.log(
                "Player joined room:",
                roomCode
            );
        }

        // PLAYER INPUT
        else if (
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
        }

    });

    // DISCONNECTION
    ws.on("close", () => {

        if (!tank || !room || room.over) {
            return;
        }

        tank.ws = null;

        tank.input = {
            up: false,
            down: false,
            left: false,
            right: false,
            fire: false
        };

        console.log(
            "Player disconnected from:",
            room.matchId
        );
    });

});

console.log(
    "Tank server listening on ws://localhost:" + PORT
);
