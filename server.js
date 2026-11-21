
// ======================================================
// TANK GAME - AUTHORITATIVE 2-PLAYER WEBSOCKET SERVER
// Tank-to-tank collision detection added
// ======================================================

const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;

// ---------------- MAP CONFIGURATION ----------------

const MAP_LEFT = 0;
const MAP_TOP = -256;
const MAP_WIDTH = 5376;
const MAP_HEIGHT = 1664;

const MAP_RIGHT = MAP_LEFT + MAP_WIDTH;
const MAP_BOTTOM = MAP_TOP + MAP_HEIGHT;

// ---------------- SPAWN POSITIONS ----------------

const SPAWNS = [
    { x: 320, y: 20, angle: 0 },
    { x: 3920, y: 961, angle: Math.PI }
];

// ---------------- TANK CONFIGURATION ----------------

const TANK_R = 22;
const TANK_DIAMETER = TANK_R * 2;

const MOVE_SPEED = 200;
const ACCELERATION = 800;
const FRICTION = 1000;
const TURN_SPEED = 10;

const MAX_HP = 100;

// ---------------- BULLET CONFIGURATION ----------------

const BULLET_SPEED = 600;
const BULLET_DMG = 25;
const BULLET_LIFE = 1.5;
const FIRE_COOLDOWN = 0.5;

// ---------------- GAME LOOP ----------------

const TICK = 1 / 60;
const SEND_EVERY = 3;

// ---------------- ROOM STORAGE ----------------

const rooms = new Map();

// ======================================================
// ANGLE HELPER
// ======================================================

function lerpAngle(from, to, weight) {
    const difference = Math.atan2(
        Math.sin(to - from),
        Math.cos(to - from)
    );

    return from + difference * Math.max(
        0,
        Math.min(1, weight)
    );
}

// ======================================================
// MAP BOUNDARY HELPER
// ======================================================

function keepTankInsideMap(tank) {
    const minX = MAP_LEFT + TANK_R;
    const maxX = MAP_RIGHT - TANK_R;

    const minY = MAP_TOP + TANK_R;
    const maxY = MAP_BOTTOM - TANK_R;

    if (tank.x < minX) {
        tank.x = minX;
        tank.vx = Math.max(0, tank.vx);
    }

    if (tank.x > maxX) {
        tank.x = maxX;
        tank.vx = Math.min(0, tank.vx);
    }

    if (tank.y < minY) {
        tank.y = minY;
        tank.vy = Math.max(0, tank.vy);
    }

    if (tank.y > maxY) {
        tank.y = maxY;
        tank.vy = Math.min(0, tank.vy);
    }
}

// ======================================================
// TANK COLLISION SYSTEM
// ======================================================

function resolveTankCollision(a, b) {

    const dx = b.x - a.x;
    const dy = b.y - a.y;

    const distance = Math.hypot(dx, dy);

    // Minimum distance between tank centers.
    const minimumDistance = TANK_DIAMETER;

    // No collision if tanks are sufficiently separated.
    if (distance >= minimumDistance) {
        return;
    }

    // Calculate collision direction.
    let normalX;
    let normalY;

    if (distance < 0.001) {

        // Prevent division by zero if tanks overlap exactly.
        normalX = 1;
        normalY = 0;

    } else {

        normalX = dx / distance;
        normalY = dy / distance;

    }

    // Calculate how deeply the tanks overlap.
    const overlap = minimumDistance - distance;

    // Move both tanks apart.
    const correction = (overlap / 2) + 0.01;

    a.x -= normalX * correction;
    a.y -= normalY * correction;

    b.x += normalX * correction;
    b.y += normalY * correction;

    // Calculate relative velocity.
    const relativeVelocityX = b.vx - a.vx;
    const relativeVelocityY = b.vy - a.vy;

    const closingSpeed =
        relativeVelocityX * normalX +
        relativeVelocityY * normalY;

    // Remove velocity pushing the tanks into each other.
    if (closingSpeed < 0) {

        const impulse = -closingSpeed / 2;

        a.vx -= impulse * normalX;
        a.vy -= impulse * normalY;

        b.vx += impulse * normalX;
        b.vy += impulse * normalY;

    }

    // Recheck map boundaries after collision correction.
    keepTankInsideMap(a);
    keepTankInsideMap(b);
}

// ======================================================
// TANK CREATION
// ======================================================

function makeTank(index, playerId) {

    const spawn = SPAWNS[index];

    return {
        playerId,
        ws: null,

        hp: MAX_HP,
        dmgDealt: 0,
        shots: 0,
        cooldown: 0,

        x: spawn.x,
        y: spawn.y,

        vx: 0,
        vy: 0,

        angle: spawn.angle,
        turretAngle: spawn.angle,

        input: {
            moveX: 0,
            moveY: 0,
            fire: false
        }
    };
}

// ======================================================
// COMMUNICATION
// ======================================================

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

// ======================================================
// ROOM CODE GENERATION
// ======================================================

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

// ======================================================
// HOST ROOM
// ======================================================

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

// ======================================================
// JOIN ROOM
// ======================================================

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

// ======================================================
// END GAME
// ======================================================

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

// ======================================================
// GAME SIMULATION
// ======================================================

function step(room) {

    const [a, b] = room.tanks;

    if (!a || !b) return;

    // --------------------------------------------------
    // MOVE TANKS
    // --------------------------------------------------

    for (const tank of room.tanks) {

        const input = tank.input;

        const direction = Math.hypot(
            input.moveX,
            input.moveY
        );

        if (direction > 0.01) {

            const moveX = input.moveX / direction;
            const moveY = input.moveY / direction;

            const targetAngle =
                Math.atan2(moveY, moveX) + Math.PI / 2;

            tank.angle = lerpAngle(
                tank.angle,
                targetAngle,
                TURN_SPEED * TICK
            );

            tank.vx += moveX * ACCELERATION * TICK;
            tank.vy += moveY * ACCELERATION * TICK;

            const velocityLength = Math.hypot(
                tank.vx,
                tank.vy
            );

            if (velocityLength > MOVE_SPEED) {

                tank.vx =
                    tank.vx / velocityLength * MOVE_SPEED;

                tank.vy =
                    tank.vy / velocityLength * MOVE_SPEED;

            }

        } else {

            const velocityLength = Math.hypot(
                tank.vx,
                tank.vy
            );

            if (velocityLength > 0) {

                const newLength = Math.max(
                    0,
                    velocityLength - FRICTION * TICK
                );

                tank.vx =
                    tank.vx / velocityLength * newLength;

                tank.vy =
                    tank.vy / velocityLength * newLength;

            }

        }

        tank.x += tank.vx * TICK;
        tank.y += tank.vy * TICK;

        keepTankInsideMap(tank);

        tank.cooldown = Math.max(
            0,
            tank.cooldown - TICK
        );

        // --------------------------------------------------
        // SHOOTING
        // --------------------------------------------------

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

    // --------------------------------------------------
    // TANK-TO-TANK COLLISION
    // --------------------------------------------------

    resolveTankCollision(a, b);

    // --------------------------------------------------
    // BULLET MOVEMENT AND COLLISION
    // --------------------------------------------------

    room.bullets = room.bullets.filter(bullet => {

        bullet.x += bullet.vx * TICK;
        bullet.y += bullet.vy * TICK;

        bullet.life -= TICK;

        if (
            bullet.life <= 0 ||
            bullet.x < MAP_LEFT ||
            bullet.x > MAP_RIGHT ||
            bullet.y < MAP_TOP ||
            bullet.y > MAP_BOTTOM
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

    // --------------------------------------------------
    // CHECK DEFEATED PLAYERS
    // --------------------------------------------------

    const dead = room.tanks.filter(
        tank => tank.hp <= 0
    );

    if (dead.length === 1) {

        finish(
            room,
            dead[0] === a ? b : a,
            "score"
        );

    } else if (dead.length === 2) {

        const winner =
            a.dmgDealt !== b.dmgDealt
                ? (a.dmgDealt > b.dmgDealt ? a : b)
                : (a.shots !== b.shots
                    ? (a.shots < b.shots ? a : b)
                    : a);

        finish(room, winner, "tiebreak");

    }

}

// ======================================================
// GAME STATE
// ======================================================

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

// ======================================================
// GAME LOOP
// ======================================================

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

// ======================================================
// WEBSOCKET SERVER
// ======================================================

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

        // --------------------------------------------------
        // HOST
        // --------------------------------------------------

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

        // --------------------------------------------------
        // JOIN
        // --------------------------------------------------

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

        // --------------------------------------------------
        // PLAYER INPUT
        // --------------------------------------------------

        if (
            message.type === "input" &&
            tank &&
            room &&
            room.running &&
            !room.over
        ) {

            const input = message.input || {};

            let moveX = Number(input.moveX);
            let moveY = Number(input.moveY);

            // Compatibility with older input format.
            if (
                !Number.isFinite(moveX) ||
                !Number.isFinite(moveY)
            ) {

                moveX =
                    (input.right ? 1 : 0) -
                    (input.left ? 1 : 0);

                moveY =
                    (input.down ? 1 : 0) -
                    (input.up ? 1 : 0);

            }

            const length = Math.hypot(moveX, moveY);

            if (length > 1) {
                moveX /= length;
                moveY /= length;
            }

            tank.input = {

                moveX,
                moveY,

                fire: !!input.fire

            };

            if (
                typeof input.turretAngle === "number" &&
                Number.isFinite(input.turretAngle)
            ) {

                tank.turretAngle = input.turretAngle;

            }

            return;
        }

    });

    // --------------------------------------------------
    // DISCONNECT
    // --------------------------------------------------

    ws.on("close", () => {

        console.log("Player disconnected.");

        if (!tank || !room || room.over) {
            return;
        }

        tank.ws = null;

        if (!room.running) {

            rooms.delete(room.roomCode);

            console.log(
                "Waiting room deleted:",
                room.roomCode
            );

            return;
        }

        const opponent = room.tanks.find(
            other => other !== tank
        );

        if (opponent) {
            finish(room, opponent, "forfeit");
        }

    });

    ws.on("error", error => {

        console.error(
            "WebSocket error:",
            error.message
        );

    });

});

// ======================================================
// SERVER START
// ======================================================

console.log(
    "Tank multiplayer server listening on port " + PORT
);
