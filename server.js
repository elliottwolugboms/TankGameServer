const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8080;

// ======================================================
// MAP CONFIGURATION
// ======================================================

const MAP_LEFT = 0;
const MAP_TOP = -256;
const MAP_WIDTH = 5376;
const MAP_HEIGHT = 1664;

const MAP_RIGHT = MAP_LEFT + MAP_WIDTH;
const MAP_BOTTOM = MAP_TOP + MAP_HEIGHT;

// ======================================================
// ROAD MASK
// road_mask.json must be beside server.js.
// ======================================================

const ROAD_MASK_PATH = path.join(__dirname, "road_mask.json");
let roadMask;

try {
    roadMask = JSON.parse(fs.readFileSync(ROAD_MASK_PATH, "utf8"));
} catch (error) {
    console.error("Could not load road_mask.json. Place it beside server.js.");
    console.error(error.message);
    process.exit(1);
}

if (
    !roadMask ||
    !Number.isInteger(roadMask.cell_size) ||
    !Number.isInteger(roadMask.width) ||
    !Number.isInteger(roadMask.height) ||
    typeof roadMask.mask !== "string"
) {
    console.error("road_mask.json has an invalid format.");
    process.exit(1);
}

const ROAD_BITS = Buffer.from(roadMask.mask, "base64");

const ROAD_CELL_SIZE = roadMask.cell_size;
const ROAD_WIDTH = roadMask.width;
const ROAD_HEIGHT = roadMask.height;

const ROAD_LEFT = roadMask.map_left;
const ROAD_TOP = roadMask.map_top;

if (ROAD_BITS.length * 8 !== ROAD_WIDTH * ROAD_HEIGHT) {
    console.error("road_mask.json has an invalid mask size.");
    process.exit(1);
}

// ======================================================
// SPAWNS
// ======================================================

const SPAWNS = [
    { x: 320, y: 20, angle: 0 },
    { x: 3920, y: 961, angle: Math.PI }
];

// ======================================================
// TANK CONFIGURATION
// ======================================================

const TANK_R = 22;
const TANK_DIAMETER = TANK_R * 2;

const MOVE_SPEED = 200;
const ACCELERATION = 800;
const FRICTION = 1000;
const TURN_SPEED = 10;

const MAX_HP = 100;

// ======================================================
// BULLET CONFIGURATION
// ======================================================

const BULLET_SPEED = 600;
const BULLET_DMG = 25;
const BULLET_LIFE = 1.5;
const FIRE_COOLDOWN = 0.5;

// ======================================================
// GAME LOOP
// ======================================================

const TICK = 1 / 60;
const SEND_EVERY = 3;

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
// BULLET COLLISION HELPER
// Checks the entire path travelled by a bullet.
// ======================================================

function distanceToSegment(px, py, x1, y1, x2, y2) {

    const dx = x2 - x1;
    const dy = y2 - y1;

    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared === 0) {
        return Math.hypot(px - x1, py - y1);
    }

    let t = (
        (px - x1) * dx +
        (py - y1) * dy
    ) / lengthSquared;

    t = Math.max(0, Math.min(1, t));

    const closestX = x1 + t * dx;
    const closestY = y1 + t * dy;

    return Math.hypot(
        px - closestX,
        py - closestY
    );
}

// ======================================================
// MAP BOUNDARIES
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
// ROAD COLLISION SYSTEM
// ======================================================

function isRoadAt(worldX, worldY) {

    const column = Math.floor(
        (worldX - ROAD_LEFT) / ROAD_CELL_SIZE
    );

    const row = Math.floor(
        (worldY - ROAD_TOP) / ROAD_CELL_SIZE
    );

    if (
        column < 0 ||
        column >= ROAD_WIDTH ||
        row < 0 ||
        row >= ROAD_HEIGHT
    ) {
        return false;
    }

    const bitIndex = row * ROAD_WIDTH + column;
    const byteIndex = Math.floor(bitIndex / 8);
    const bitOffset = bitIndex % 8;

    return (ROAD_BITS[byteIndex] & (1 << bitOffset)) !== 0;
}

// ======================================================
// CHECK IF TANK CAN OCCUPY A POSITION
// ======================================================

function canTankOccupy(x, y) {

    if (
        x - TANK_R < MAP_LEFT ||
        x + TANK_R > MAP_RIGHT ||
        y - TANK_R < MAP_TOP ||
        y + TANK_R > MAP_BOTTOM
    ) {
        return false;
    }

    if (!isRoadAt(x, y)) {
        return false;
    }

    const collisionRadius = TANK_R * 0.65;
    const samples = 12;

    for (let i = 0; i < samples; i++) {

        const angle = (Math.PI * 2 * i) / samples;

        const sampleX =
            x + Math.cos(angle) * collisionRadius;

        const sampleY =
            y + Math.sin(angle) * collisionRadius;

        if (!isRoadAt(sampleX, sampleY)) {
            return false;
        }
    }

    return true;
}

// ======================================================
// TANK MOVEMENT ON ROADS
// ======================================================

function moveTankOnRoad(tank, deltaX, deltaY) {

    const distance = Math.hypot(deltaX, deltaY);

    if (distance <= 0.0001) {
        return;
    }

    const maxStep = ROAD_CELL_SIZE * 0.5;

    const steps = Math.max(
        1,
        Math.ceil(distance / maxStep)
    );

    const stepX = deltaX / steps;
    const stepY = deltaY / steps;

    let blockedX = false;
    let blockedY = false;

    for (let i = 0; i < steps; i++) {

        const nextX = tank.x + stepX;
        const nextY = tank.y + stepY;

        if (canTankOccupy(nextX, nextY)) {

            tank.x = nextX;
            tank.y = nextY;

            continue;
        }

        if (
            !blockedX &&
            Math.abs(stepX) > 0.0001
        ) {

            if (canTankOccupy(nextX, tank.y)) {

                tank.x = nextX;

            } else {

                blockedX = true;
                tank.vx = 0;
            }
        }

        if (
            !blockedY &&
            Math.abs(stepY) > 0.0001
        ) {

            if (canTankOccupy(tank.x, nextY)) {

                tank.y = nextY;

            } else {

                blockedY = true;
                tank.vy = 0;
            }
        }
    }
}

// ======================================================
// TANK COLLISION
// ======================================================

function resolveTankCollision(a, b) {

    const originalA = {
        x: a.x,
        y: a.y,
        vx: a.vx,
        vy: a.vy
    };

    const originalB = {
        x: b.x,
        y: b.y,
        vx: b.vx,
        vy: b.vy
    };

    const dx = b.x - a.x;
    const dy = b.y - a.y;

    const distance = Math.hypot(dx, dy);
    const minimumDistance = TANK_DIAMETER;

    if (distance >= minimumDistance) {
        return;
    }

    let normalX;
    let normalY;

    if (distance < 0.001) {

        normalX = 1;
        normalY = 0;

    } else {

        normalX = dx / distance;
        normalY = dy / distance;
    }

    const overlap = minimumDistance - distance;
    const correction = (overlap / 2) + 0.01;

    a.x -= normalX * correction;
    a.y -= normalY * correction;

    b.x += normalX * correction;
    b.y += normalY * correction;

    const relativeVelocityX = b.vx - a.vx;
    const relativeVelocityY = b.vy - a.vy;

    const closingSpeed =
        relativeVelocityX * normalX +
        relativeVelocityY * normalY;

    if (closingSpeed < 0) {

        const impulse = -closingSpeed / 2;

        a.vx -= impulse * normalX;
        a.vy -= impulse * normalY;

        b.vx += impulse * normalX;
        b.vy += impulse * normalY;
    }

    keepTankInsideMap(a);
    keepTankInsideMap(b);

    if (
        !canTankOccupy(a.x, a.y) ||
        !canTankOccupy(b.x, b.y)
    ) {

        Object.assign(a, originalA);
        Object.assign(b, originalB);
    }
}

// ======================================================
// CREATE TANK
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
// ROOM CODE
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
// CREATE ROOM
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

    // ==================================================
    // MOVE TANKS
    // ==================================================

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

        // ROAD-ONLY MOVEMENT

        moveTankOnRoad(
            tank,
            tank.vx * TICK,
            tank.vy * TICK
        );

        keepTankInsideMap(tank);

        // UPDATE SHOOTING COOLDOWN

        tank.cooldown = Math.max(
            0,
            tank.cooldown - TICK
        );

        // SHOOTING

        if (input.fire && tank.cooldown <= 0) {

            tank.cooldown = FIRE_COOLDOWN;
            tank.shots++;

            const directionX = Math.cos(tank.turretAngle);
            const directionY = Math.sin(tank.turretAngle);

            room.bullets.push({

                id: crypto.randomUUID(),

                x: tank.x + directionX * 30,
                y: tank.y + directionY * 30,

                vx: directionX * BULLET_SPEED,
                vy: directionY * BULLET_SPEED,

                owner: tank,
                life: BULLET_LIFE
            });
        }
    }

    // ==================================================
    // TANK-TO-TANK COLLISION
    // ==================================================

    resolveTankCollision(a, b);

    // ==================================================
    // BULLET MOVEMENT AND COLLISION
    // ==================================================

    let healthChanged = false;

    room.bullets = room.bullets.filter(bullet => {

        const previousX = bullet.x;
        const previousY = bullet.y;

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

        const distance = distanceToSegment(
            target.x,
            target.y,
            previousX,
            previousY,
            bullet.x,
            bullet.y
        );

        if (distance <= TANK_R) {

            const oldHP = target.hp;

            target.hp = Math.max(
                0,
                target.hp - BULLET_DMG
            );

            const actualDamage = oldHP - target.hp;

            bullet.owner.dmgDealt += actualDamage;

            healthChanged = true;

            console.log(
                "BULLET HIT:",
                bullet.owner.playerId,
                "hit",
                target.playerId,
                "| Damage:",
                actualDamage,
                "| HP remaining:",
                target.hp
            );

            return false;
        }

        return true;
    });

    // ==================================================
    // IMMEDIATE HEALTH SYNCHRONIZATION
    // ==================================================

    if (healthChanged) {
        broadcast(room, snapshot(room));
    }

    // ==================================================
    // CHECK DEFEATED PLAYERS
    // ==================================================

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

            id: bullet.id,

            x: bullet.x,
            y: bullet.y,

            angle: Math.atan2(
                bullet.vy,
                bullet.vx
            )
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

        // ==============================================
        // HOST
        // ==============================================

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

        // ==============================================
        // JOIN
        // ==============================================

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

        // ==============================================
        // PLAYER INPUT
        // ==============================================

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

    // ==============================================
    // DISCONNECT
    // ==============================================

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

    // ==============================================
    // WEBSOCKET ERROR
    // ==============================================

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
    "Road mask loaded:",
    ROAD_WIDTH + "x" + ROAD_HEIGHT
);

console.log(
    "Tank multiplayer server listening on port " + PORT
);
