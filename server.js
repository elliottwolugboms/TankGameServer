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
// ======================================================

const ROAD_MASK_PATH = path.join(__dirname, "road_mask.json");
let roadMask;

try {
    roadMask = JSON.parse(fs.readFileSync(ROAD_MASK_PATH, "utf8"));
} catch (error) {
    console.error("Could not load road_mask.json.");
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
// PLAYER SPAWNS
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
// PLAYER BULLETS
// ======================================================

const BULLET_SPEED = 600;
const BULLET_DMG = 25;
const BULLET_LIFE = 1.5;
const FIRE_COOLDOWN = 0.5;

// ======================================================
// AI ENEMIES
// ======================================================

const ENEMY_MAX_HP = 100;
const ENEMY_RADIUS = 22;
const ENEMY_RESPAWN_DELAY = 2.0;

const ENEMY_IDS = [
    "enemy_1",
    "enemy_2",
    "enemy_3",
    "enemy_mg_1",
    "enemy_mg_2"
];

const ENEMY_BULLETS = {
    normal: {
        speed: 500,
        damage: 20,
        lifetime: 2.0
    },

    mg: {
        speed: 700,
        damage: 5,
        lifetime: 1.2
    }
};

// ======================================================
// PICKUP CONFIGURATION
// ======================================================

const PICKUP_DROP_CHANCE = 1.0;

const PICKUP_WEIGHTS = {
    ammo: 0.60,
    health: 0.25,
    shield: 0.15
};

const PICKUP_LIFETIME = 25.0;
const PICKUP_RADIUS = 52;

const MAX_AMMO = 15;
const AMMO_REWARD = 15;

const HEALTH_REWARD_PERCENT = 5;

const SHIELD_MAX_HP = 50;
const SHIELD_DURATION = 15.0;

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
// ROAD COLLISION
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
// CHECK TANK POSITION
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

        if (!blockedX && Math.abs(stepX) > 0.0001) {

            if (canTankOccupy(nextX, tank.y)) {
                tank.x = nextX;
            } else {
                blockedX = true;
                tank.vx = 0;
            }
        }

        if (!blockedY && Math.abs(stepY) > 0.0001) {

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

    if (distance >= TANK_DIAMETER) {
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

    const overlap = TANK_DIAMETER - distance;
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
// CREATE PLAYER TANK
// ======================================================

function makeTank(index, playerId) {

    const spawn = SPAWNS[index];

    return {
        playerId,
        ws: null,

        hp: MAX_HP,

        ammo: MAX_AMMO,
        maxAmmo: MAX_AMMO,

        shieldHp: 0,
        shieldTimeLeft: 0,

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
// INITIALIZE AI ENEMIES
// ======================================================

function initializeEnemies(room, updates) {

    if (!Array.isArray(updates)) {
        return;
    }

    for (const data of updates) {

        if (!data || !ENEMY_IDS.includes(data.id)) {
            continue;
        }

        if (room.enemies.has(data.id)) {
            continue;
        }

        const x = Number(data.x);
        const y = Number(data.y);
        const angle = Number(data.a);
        const turretAngle = Number(data.turretAngle);
        const progress = Number(data.progress);

        if (
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            !Number.isFinite(angle) ||
            !Number.isFinite(turretAngle) ||
            !Number.isFinite(progress)
        ) {
            continue;
        }

        room.enemies.set(data.id, {

            id: data.id,

            x,
            y,

            spawnX: x,
            spawnY: y,

            a: angle,
            turretAngle,

            spawnA: angle,
            spawnTurretAngle: turretAngle,

            progress,
            spawnProgress: progress,

            hp: ENEMY_MAX_HP,
            alive: true,

            respawnAt: 0,
            respawnDelay: ENEMY_RESPAWN_DELAY
        });
    }

    if (room.enemies.size === ENEMY_IDS.length) {
        console.log("All five AI enemies initialized.");
    }
}

// ======================================================
// HOST ENEMY POSITION UPDATES
// ======================================================

function updateEnemies(room, updates) {

    if (!Array.isArray(updates)) {
        return;
    }

    if (room.enemies.size < ENEMY_IDS.length) {
        initializeEnemies(room, updates);
    }

    for (const data of updates) {

        if (!data || !ENEMY_IDS.includes(data.id)) {
            continue;
        }

        const enemy = room.enemies.get(data.id);

        if (!enemy || !enemy.alive) {
            continue;
        }

        const x = Number(data.x);
        const y = Number(data.y);
        const angle = Number(data.a);
        const turretAngle = Number(data.turretAngle);
        const progress = Number(data.progress);

        if (
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            !Number.isFinite(angle) ||
            !Number.isFinite(turretAngle) ||
            !Number.isFinite(progress)
        ) {
            continue;
        }

        enemy.x = x;
        enemy.y = y;
        enemy.a = angle;
        enemy.turretAngle = turretAngle;
        enemy.progress = progress;
    }
}

// ======================================================
// AI ENEMY SHOOTING
// ======================================================

function createEnemyBullet(room, message) {

    const enemy = room.enemies.get(message.enemyId);

    if (!enemy || !enemy.alive) {
        return;
    }

    const bulletType = message.bulletType === "mg"
        ? "mg"
        : "normal";

    const settings = ENEMY_BULLETS[bulletType];

    const x = Number(message.x);
    const y = Number(message.y);
    const dx = Number(message.dx);
    const dy = Number(message.dy);

    if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(dx) ||
        !Number.isFinite(dy)
    ) {
        return;
    }

    const directionLength = Math.hypot(dx, dy);

    if (directionLength < 0.001) {
        return;
    }

    const directionX = dx / directionLength;
    const directionY = dy / directionLength;

    room.enemyBullets.push({

        id: crypto.randomUUID(),

        kind: "enemy",
        enemyId: enemy.id,
        bulletType,

        x,
        y,

        vx: directionX * settings.speed,
        vy: directionY * settings.speed,

        damage: settings.damage,
        life: settings.lifetime
    });
}

// ======================================================
// PICKUP SYSTEM
// ======================================================

function createPickup(room, x, y) {

    if (Math.random() > PICKUP_DROP_CHANCE) {
        return;
    }

    const random = Math.random();

    let type;

    if (random < PICKUP_WEIGHTS.ammo) {
        type = "ammo";
    } else if (
        random < PICKUP_WEIGHTS.ammo +
        PICKUP_WEIGHTS.health
    ) {
        type = "health";
    } else {
        type = "shield";
    }

    const pickup = {
        id: crypto.randomUUID(),
        type,
        x,
        y,
        expiresAt: Date.now() + PICKUP_LIFETIME * 1000
    };

    room.pickups.set(pickup.id, pickup);

    console.log(
        "PICKUP SPAWNED:",
        type,
        "at",
        Math.round(x),
        Math.round(y)
    );
}

// ======================================================
// REMOVE EXPIRED PICKUPS
// ======================================================

function updatePickups(room) {

    const now = Date.now();
    let changed = false;

    for (const [id, pickup] of room.pickups) {

        if (now >= pickup.expiresAt) {

            room.pickups.delete(id);
            changed = true;

            console.log(
                "PICKUP EXPIRED:",
                pickup.type
            );
        }
    }

    return changed;
}

// ======================================================
// COLLECT PICKUP
// ======================================================

function collectPickup(room, tank, pickupId) {

    if (!room || !tank || tank.hp <= 0) {
        return;
    }

    const pickup = room.pickups.get(pickupId);

    if (!pickup) {
        return;
    }

    const distance = Math.hypot(
        tank.x - pickup.x,
        tank.y - pickup.y
    );

    if (distance > PICKUP_RADIUS) {
        return;
    }

    let collected = false;

    // AMMO

    if (pickup.type === "ammo") {

        if (tank.ammo < tank.maxAmmo) {

            const gained = Math.min(
                AMMO_REWARD,
                tank.maxAmmo - tank.ammo
            );

            tank.ammo += gained;
            collected = true;

            console.log(
                tank.playerId,
                "collected",
                gained,
                "bullets."
            );
        }
    }

    // HEALTH

    else if (pickup.type === "health") {

        if (tank.hp < MAX_HP) {

            const gained = Math.max(
                1,
                Math.ceil(
                    MAX_HP * HEALTH_REWARD_PERCENT / 100
                )
            );

            tank.hp = Math.min(
                MAX_HP,
                tank.hp + gained
            );

            collected = true;

            console.log(
                tank.playerId,
                "collected health:",
                gained
            );
        }
    }

    // SHIELD

    else if (pickup.type === "shield") {

        if (tank.shieldHp < SHIELD_MAX_HP) {

            tank.shieldHp = SHIELD_MAX_HP;
            tank.shieldTimeLeft = SHIELD_DURATION;

            collected = true;

            console.log(
                tank.playerId,
                "collected shield."
            );
        }
    }

    // REMOVE ONLY AFTER SUCCESSFUL COLLECTION.

    if (collected) {

        room.pickups.delete(pickupId);

        broadcast(room, snapshot(room));
    }
}

// ======================================================
// SHIELD DAMAGE ABSORPTION
// Returns total damage absorbed by shield and health.
// ======================================================

function applyTankDamage(tank, damage) {

    let remainingDamage = damage;

    if (tank.shieldHp > 0) {

        const absorbed = Math.min(
            tank.shieldHp,
            remainingDamage
        );

        tank.shieldHp -= absorbed;
        remainingDamage -= absorbed;

        if (tank.shieldHp <= 0) {

            tank.shieldHp = 0;
            tank.shieldTimeLeft = 0;
        }
    }

    const healthDamage = Math.min(
        tank.hp,
        remainingDamage
    );

    tank.hp = Math.max(
        0,
        tank.hp - remainingDamage
    );

    return {
        shieldDamage: damage - remainingDamage,
        healthDamage,
        totalDamage: damage - Math.max(
            0,
            remainingDamage - healthDamage
        )
    };
}

// ======================================================
// ENEMY DAMAGE
// ======================================================

function damageEnemy(room, enemy, damage) {

    if (!enemy || !enemy.alive) {
        return false;
    }

    enemy.hp = Math.max(
        0,
        enemy.hp - damage
    );

    console.log(
        "ENEMY HIT:",
        enemy.id,
        "| Damage:",
        damage,
        "| HP:",
        enemy.hp
    );

    if (enemy.hp <= 0) {

        enemy.hp = 0;
        enemy.alive = false;

        // CREATE A PICKUP AT THE ENEMY'S DEATH POSITION.

        createPickup(
            room,
            enemy.x,
            enemy.y
        );

        enemy.respawnAt =
            Date.now() + enemy.respawnDelay * 1000;

        room.enemyBullets = room.enemyBullets.filter(
            bullet => bullet.enemyId !== enemy.id
        );

        console.log(
            enemy.id,
            "destroyed. Respawning in",
            enemy.respawnDelay,
            "seconds."
        );
    }

    return true;
}

// ======================================================
// ENEMY RESPAWNING
// ======================================================

function updateEnemyRespawns(room) {

    const now = Date.now();

    for (const enemy of room.enemies.values()) {

        if (enemy.alive || enemy.respawnAt === 0) {
            continue;
        }

        if (now >= enemy.respawnAt) {

            enemy.hp = ENEMY_MAX_HP;

            enemy.x = enemy.spawnX;
            enemy.y = enemy.spawnY;

            enemy.a = enemy.spawnA;
            enemy.turretAngle = enemy.spawnTurretAngle;

            enemy.progress = enemy.spawnProgress;

            enemy.alive = true;
            enemy.respawnAt = 0;

            console.log(
                enemy.id,
                "respawned with",
                enemy.hp,
                "HP."
            );
        }
    }
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

        enemies: new Map(),
        enemyBullets: [],

        pickups: new Map(),

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
// GAME SNAPSHOT
// ======================================================

function snapshot(room) {

    const playerBullets = room.bullets.map(bullet => ({

        id: bullet.id,
        kind: "player",

        x: bullet.x,
        y: bullet.y,

        angle: Math.atan2(
            bullet.vy,
            bullet.vx
        )
    }));

    const enemyBullets = room.enemyBullets.map(bullet => ({

        id: bullet.id,
        kind: "enemy",

        enemyId: bullet.enemyId,
        bulletType: bullet.bulletType,

        x: bullet.x,
        y: bullet.y,

        angle: Math.atan2(
            bullet.vy,
            bullet.vx
        )
    }));

    return {

        type: "state",

        tanks: room.tanks.map(tank => ({

            id: tank.playerId,

            x: tank.x,
            y: tank.y,

            a: tank.angle,
            turretAngle: tank.turretAngle,

            hp: tank.hp,

            ammo: tank.ammo,

            shieldHp: tank.shieldHp,
            shieldTimeLeft: tank.shieldTimeLeft
        })),

        enemies: Array.from(room.enemies.values()).map(enemy => ({

            id: enemy.id,

            x: enemy.x,
            y: enemy.y,

            a: enemy.a,
            turretAngle: enemy.turretAngle,

            progress: enemy.progress,

            hp: enemy.hp,
            alive: enemy.alive
        })),

        bullets: [
            ...playerBullets,
            ...enemyBullets
        ],

        pickups: Array.from(room.pickups.values()).map(pickup => ({

            id: pickup.id,
            type: pickup.type,

            x: pickup.x,
            y: pickup.y
        }))
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
// CHECK PLAYER DEFEAT
// ======================================================

function checkDefeatedPlayers(room) {

    if (room.over) {
        return;
    }

    const [a, b] = room.tanks;

    if (!a || !b) {
        return;
    }

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
// ENEMY BULLET SIMULATION
// ======================================================

function updateEnemyBullets(room) {

    let changed = false;

    room.enemyBullets = room.enemyBullets.filter(bullet => {

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

        for (const tank of room.tanks) {

            if (tank.hp <= 0) {
                continue;
            }

            const distance = distanceToSegment(
                tank.x,
                tank.y,
                previousX,
                previousY,
                bullet.x,
                bullet.y
            );

            if (distance <= TANK_R) {

                const result = applyTankDamage(
                    tank,
                    bullet.damage
                );

                changed = true;

                console.log(
                    "ENEMY BULLET HIT:",
                    bullet.enemyId,
                    "hit",
                    tank.playerId,
                    "| Shield damage:",
                    result.shieldDamage,
                    "| Health damage:",
                    result.healthDamage,
                    "| HP:",
                    tank.hp,
                    "| Shield:",
                    tank.shieldHp
                );

                return false;
            }
        }

        return true;
    });

    return changed;
}

// ======================================================
// GAME SIMULATION
// ======================================================

function step(room) {

    const [a, b] = room.tanks;

    if (!a || !b) return;

    // UPDATE ENEMY RESPAWNS

    updateEnemyRespawns(room);

    // UPDATE PICKUP LIFETIMES

    updatePickups(room);

    // UPDATE SHIELD TIMERS

    let shieldChanged = false;

    for (const tank of room.tanks) {

        if (tank.shieldHp <= 0) {
            continue;
        }

        tank.shieldTimeLeft -= TICK;

        if (tank.shieldTimeLeft <= 0) {

            tank.shieldTimeLeft = 0;
            tank.shieldHp = 0;

            shieldChanged = true;

            console.log(
                tank.playerId,
                "shield expired."
            );
        }
    }

    // MOVE PLAYER TANKS

    for (const tank of room.tanks) {

        if (tank.hp <= 0) {
            continue;
        }

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

        // SHOOTING COOLDOWN

        tank.cooldown = Math.max(
            0,
            tank.cooldown - TICK
        );

        // PLAYER SHOOTING

        if (
            input.fire &&
            tank.cooldown <= 0 &&
            tank.ammo > 0
        ) {

            tank.cooldown = FIRE_COOLDOWN;
            tank.shots++;

            tank.ammo--;

            const directionX = Math.cos(tank.turretAngle);
            const directionY = Math.sin(tank.turretAngle);

            room.bullets.push({

                id: crypto.randomUUID(),

                kind: "player",

                x: tank.x + directionX * 30,
                y: tank.y + directionY * 30,

                vx: directionX * BULLET_SPEED,
                vy: directionY * BULLET_SPEED,

                owner: tank,
                life: BULLET_LIFE
            });
        }
    }

    // TANK-TO-TANK COLLISION

    if (a.hp > 0 && b.hp > 0) {
        resolveTankCollision(a, b);
    }

    // PLAYER BULLET MOVEMENT AND COLLISION

    let healthChanged = shieldChanged;

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

        // CHECK AI ENEMIES FIRST

        for (const enemy of room.enemies.values()) {

            if (!enemy.alive) {
                continue;
            }

            const enemyDistance = distanceToSegment(
                enemy.x,
                enemy.y,
                previousX,
                previousY,
                bullet.x,
                bullet.y
            );

            if (enemyDistance <= ENEMY_RADIUS) {

                const oldHP = enemy.hp;

                damageEnemy(
                    room,
                    enemy,
                    BULLET_DMG
                );

                const actualDamage = oldHP - enemy.hp;

                bullet.owner.dmgDealt += actualDamage;

                healthChanged = true;

                return false;
            }
        }

        // CHECK OPPONENT

        const target = bullet.owner === a ? b : a;

        if (target.hp <= 0) {
            return true;
        }

        const distance = distanceToSegment(
            target.x,
            target.y,
            previousX,
            previousY,
            bullet.x,
            bullet.y
        );

        if (distance <= TANK_R) {

            const result = applyTankDamage(
                target,
                BULLET_DMG
            );

            bullet.owner.dmgDealt += result.totalDamage;

            healthChanged = true;

            console.log(
                "PLAYER BULLET HIT:",
                bullet.owner.playerId,
                "hit",
                target.playerId,
                "| Shield damage:",
                result.shieldDamage,
                "| Health damage:",
                result.healthDamage,
                "| HP:",
                target.hp,
                "| Shield:",
                target.shieldHp
            );

            return false;
        }

        return true;
    });

    // ENEMY BULLETS

    if (updateEnemyBullets(room)) {
        healthChanged = true;
    }

    // SYNCHRONIZE CHANGED STATE

    if (healthChanged) {
        broadcast(room, snapshot(room));
    }

    // CHECK PLAYER DEATHS

    checkDefeatedPlayers(room);
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

        // JOIN ROOM

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

        // COLLECT PICKUP

        if (
            message.type === "collect_pickup" &&
            tank &&
            room &&
            room.running &&
            !room.over
        ) {

            if (
                typeof message.pickupId !== "string" ||
                message.pickupId.length > 64
            ) {
                return;
            }

            collectPickup(
                room,
                tank,
                message.pickupId
            );

            return;
        }

        // HOST AI ENEMY UPDATES

        if (
            message.type === "enemy_update" &&
            tank &&
            room &&
            room.running &&
            !room.over
        ) {

            if (room.tanks[0] !== tank) {
                return;
            }

            updateEnemies(room, message.enemies);

            return;
        }

        // HOST AI ENEMY SHOOTING

        if (
            message.type === "enemy_shot" &&
            tank &&
            room &&
            room.running &&
            !room.over
        ) {

            if (room.tanks[0] !== tank) {
                return;
            }

            createEnemyBullet(room, message);

            return;
        }
    });

    // DISCONNECT

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

    // WEBSOCKET ERROR

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
