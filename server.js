// ======================================================
// TANK GAME - AUTHORITATIVE 2-PLAYER WEBSOCKET SERVER
// ROAD-ONLY MOVEMENT + TANK COLLISIONS
// ======================================================

const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8080;

// ---------------- MAP CONFIGURATION ----------------

const MAP_LEFT = 0;
const MAP_TOP = -256;
const MAP_WIDTH = 5376;
const MAP_HEIGHT = 1664;

const MAP_RIGHT = MAP_LEFT + MAP_WIDTH;
const MAP_BOTTOM = MAP_TOP + MAP_HEIGHT;

// ---------------- ROAD MASK ----------------
// road_mask.json must be in the same folder as server.js.

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

    // The mask stores pixels least-significant bit first.
    return (ROAD_BITS[byteIndex] & (1 << bitOffset)) !== 0;
}

// Check the centre and the circular footprint of the tank.
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

    const radii = [
        TANK_R * 0.55,
        TANK_R * 0.82,
        TANK_R
    ];

    const samples = 16;

    for (const radius of radii) {
        for (let i = 0; i < samples; i++) {
            const angle = (Math.PI * 2 * i) / samples;

            const sampleX = x + Math.cos(angle) * radius;
            const sampleY = y + Math.sin(angle) * radius;

            if (!isRoadAt(sampleX, sampleY)) {
                return false;
            }
        }
    }

    return true;
}

// Try the requested movement, then try each axis separately to allow sliding.
function moveTankOnRoad(tank, deltaX, deltaY) {
    const nextX = tank.x + deltaX;
    const nextY = tank.y + deltaY;

    if (canTankOccupy(nextX, nextY)) {
        tank.x = nextX;
        tank.y = nextY;
        return;
    }

    let movedX = false;
    let movedY = false;

    if (
        Math.abs(deltaX) > 0.0001 &&
        canTankOccupy(nextX, tank.y)
    ) {
        tank.x = nextX;
        movedX = true;
    }

    if (
        Math.abs(deltaY) > 0.0001 &&
        canTankOccupy(tank.x, nextY)
    ) {
        tank.y = nextY;
        movedY = true;
    }

    if (!movedX) tank.vx = 0;
    if (!movedY) tank.vy = 0;
}

// ======================================================
// TANK COLLISION SYSTEM
// ======================================================

function resolveTankCollision(a, b) {

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
