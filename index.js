import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';

import Fastify from 'fastify';
import JSONBLite from 'jsonblite';
import { v4 as uuidv4 } from 'uuid';

const fastify = Fastify({ logger: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');
const CRUD_DB_FILE = path.join(DATA_DIR, 'crud.db');
const CHAOS_DB_FILE = path.join(DATA_DIR, 'chaos.db');
const CHAOS_PAGE_PATH = path.join(__dirname, 'public', 'chaos.html');

const GITHUB_URL = 'https://github.com/mkaski/jsonblite-example';

fs.mkdirSync(DATA_DIR, { recursive: true });

function migrateLegacyDb(sourcePath, destinationPath) {
    if (!fs.existsSync(destinationPath) && fs.existsSync(sourcePath)) {
        fs.renameSync(sourcePath, destinationPath);
    }
}

migrateLegacyDb(path.join(__dirname, 'db.jsonblite'), CRUD_DB_FILE);
migrateLegacyDb(path.join(DATA_DIR, 'crud.jsonblite'), CRUD_DB_FILE);

const crudDb = new JSONBLite(CRUD_DB_FILE);
const chaosDb = new JSONBLite(CHAOS_DB_FILE);

const CHAOS_KEYS = {
    CONFIG: 'chaos:config',
    STATS: 'chaos:stats',
};

const DEFAULT_CHAOS_CONFIG = {
    running: true,
    botCount: 180,
    tickRate: 20,
    writesPerTick: 60,
    readsPerTick: 30,
    arenaWidth: 2000,
    arenaHeight: 1200,
};

const chaos = {
    config: { ...DEFAULT_CHAOS_CONFIG },
    bots: [],
    tick: 0,
    timer: null,
    stats: {
        startedAt: Date.now(),
        ticks: 0,
        writes: 0,
        reads: 0,
        deletes: 0,
        collisions: 0,
        kills: 0,
        errors: 0,
        lastTickMs: 0,
        avgTickMs: 0,
        lastVacuumAt: 0,
        lastError: null,
    },
};

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function randomBetween(min, max) {
    return Math.random() * (max - min) + min;
}

function humanBytes(bytes) {
    const kib = bytes / 1024;
    const mib = kib / 1024;
    if (mib >= 1) {
        return `${mib.toFixed(2)} MiB`;
    }
    return `${kib.toFixed(2)} KiB`;
}

function dbFileStats(filename) {
    if (!fs.existsSync(filename)) {
        return { bytes: 0, label: '0 B' };
    }

    const bytes = fs.statSync(filename).size;
    return { bytes, label: humanBytes(bytes) };
}

function previewJson(value) {
    const raw = JSON.stringify(value);
    if (!raw) {
        return String(value);
    }
    if (raw.length <= 120) {
        return raw;
    }
    return `${raw.slice(0, 117)}...`;
}

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function validateGameState(value) {
    if (!isPlainObject(value)) {
        return { ok: false, error: 'value must be an object' };
    }

    const allowedKeys = new Set(['type', 'gameId', 'tick', 'updatedAt', 'players', 'world', 'events']);
    for (const key of Object.keys(value)) {
        if (!allowedKeys.has(key)) {
            return { ok: false, error: `unexpected field "${key}"` };
        }
    }

    if (value.type !== 'game_state') {
        return { ok: false, error: 'type must be "game_state"' };
    }
    if (typeof value.gameId !== 'string' || value.gameId.trim().length < 3 || value.gameId.trim().length > 64) {
        return { ok: false, error: 'gameId must be a string between 3 and 64 chars' };
    }
    if (!Number.isInteger(value.tick) || value.tick < 0) {
        return { ok: false, error: 'tick must be an integer >= 0' };
    }
    if (!Number.isInteger(value.updatedAt) || value.updatedAt <= 0) {
        return { ok: false, error: 'updatedAt must be a unix timestamp number' };
    }
    if (!Array.isArray(value.players) || value.players.length === 0 || value.players.length > 256) {
        return { ok: false, error: 'players must be an array of 1-256 player objects' };
    }

    for (let i = 0; i < value.players.length; i++) {
        const player = value.players[i];
        if (!isPlainObject(player)) {
            return { ok: false, error: `players[${i}] must be an object` };
        }
        if (typeof player.id !== 'string' || player.id.trim().length === 0) {
            return { ok: false, error: `players[${i}].id must be a non-empty string` };
        }
        if (typeof player.name !== 'string' || player.name.trim().length === 0) {
            return { ok: false, error: `players[${i}].name must be a non-empty string` };
        }
        if (!isFiniteNumber(player.x) || !isFiniteNumber(player.y)) {
            return { ok: false, error: `players[${i}] coordinates must be finite numbers` };
        }
        if (!Number.isInteger(player.hp) || player.hp < 0 || player.hp > 100) {
            return { ok: false, error: `players[${i}].hp must be an integer 0-100` };
        }
        if (!Number.isInteger(player.score) || player.score < 0) {
            return { ok: false, error: `players[${i}].score must be an integer >= 0` };
        }
    }

    if (Object.hasOwn(value, 'world')) {
        if (!isPlainObject(value.world)) {
            return { ok: false, error: 'world must be an object when provided' };
        }
        if (typeof value.world.phase !== 'string' || value.world.phase.trim().length === 0) {
            return { ok: false, error: 'world.phase must be a non-empty string' };
        }
        if (typeof value.world.map !== 'string' || value.world.map.trim().length === 0) {
            return { ok: false, error: 'world.map must be a non-empty string' };
        }
    }

    if (Object.hasOwn(value, 'events')) {
        if (!Array.isArray(value.events) || value.events.length > 500) {
            return { ok: false, error: 'events must be an array with max 500 items' };
        }
    }

    return { ok: true };
}

function createDemoGameState(gameId = `match-${uuidv4().slice(0, 8)}`) {
    const now = Date.now();
    const players = Array.from({ length: 4 }, (_, i) => ({
        id: `p${i + 1}`,
        name: `Player ${i + 1}`,
        x: Number(randomBetween(20, 980).toFixed(2)),
        y: Number(randomBetween(20, 980).toFixed(2)),
        hp: Math.floor(randomBetween(45, 100)),
        score: Math.floor(randomBetween(0, 2500)),
    }));

    return {
        type: 'game_state',
        gameId,
        tick: Math.floor(randomBetween(10, 9000)),
        updatedAt: now,
        players,
        world: {
            phase: ['lobby', 'midgame', 'sudden_death'][Math.floor(Math.random() * 3)],
            map: ['arena-alpha', 'factory-7', 'dust-ridge'][Math.floor(Math.random() * 3)],
        },
        events: [
            {
                kind: 'spawn',
                at: now - 1200,
            },
            {
                kind: 'loot',
                at: now - 250,
            },
        ],
    };
}

function isValidGameStateKey(key) {
    return /^game:[a-z0-9:_-]{3,80}$/i.test(key);
}

function createBot(index) {
    return {
        id: `bot-${index}-${uuidv4().slice(0, 8)}`,
        x: randomBetween(0, chaos.config.arenaWidth),
        y: randomBetween(0, chaos.config.arenaHeight),
        vx: randomBetween(-2.2, 2.2),
        vy: randomBetween(-2.2, 2.2),
        hp: randomBetween(60, 100),
        energy: randomBetween(20, 100),
        score: 0,
        action: 'spawn',
        actionTick: 0,
    };
}

function setBotCount(targetCount) {
    const nextCount = clamp(Number(targetCount) || 0, 10, 1500);
    if (nextCount === chaos.bots.length) {
        return;
    }

    if (nextCount > chaos.bots.length) {
        for (let i = chaos.bots.length; i < nextCount; i++) {
            chaos.bots.push(createBot(i));
        }
        return;
    }

    chaos.bots.length = nextCount;
}

function resetChaosState() {
    chaos.tick = 0;
    chaos.stats.startedAt = Date.now();
    chaos.stats.ticks = 0;
    chaos.stats.writes = 0;
    chaos.stats.reads = 0;
    chaos.stats.deletes = 0;
    chaos.stats.collisions = 0;
    chaos.stats.kills = 0;
    chaos.stats.errors = 0;
    chaos.stats.lastTickMs = 0;
    chaos.stats.avgTickMs = 0;
    chaos.stats.lastError = null;
    chaos.bots = [];
    setBotCount(chaos.config.botCount);
}

function nearestBot(originIndex) {
    const origin = chaos.bots[originIndex];
    let candidate = null;
    let bestDistance = Infinity;

    for (let i = 0; i < chaos.bots.length; i++) {
        if (i === originIndex) {
            continue;
        }
        const other = chaos.bots[i];
        const dx = other.x - origin.x;
        const dy = other.y - origin.y;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq < bestDistance) {
            bestDistance = distanceSq;
            candidate = other;
        }
    }

    return candidate;
}

function tickChaos() {
    if (!chaos.config.running || chaos.bots.length === 0) {
        return;
    }

    const tickStart = performance.now();

    try {
        chaos.tick += 1;
        chaos.stats.ticks += 1;

        for (let i = 0; i < chaos.bots.length; i++) {
            const bot = chaos.bots[i];

            if (Math.random() < 0.08) {
                bot.vx += randomBetween(-0.65, 0.65);
                bot.vy += randomBetween(-0.65, 0.65);
                bot.action = 'dash';
                bot.actionTick = chaos.tick;
            }

            bot.vx = clamp(bot.vx, -3.5, 3.5);
            bot.vy = clamp(bot.vy, -3.5, 3.5);
            bot.x += bot.vx;
            bot.y += bot.vy;
            bot.energy -= randomBetween(0.08, 0.35);

            if (bot.x <= 0 || bot.x >= chaos.config.arenaWidth) {
                bot.vx *= -1;
                bot.x = clamp(bot.x, 0, chaos.config.arenaWidth);
                chaos.stats.collisions += 1;
                bot.action = 'bounce';
                bot.actionTick = chaos.tick;
            }

            if (bot.y <= 0 || bot.y >= chaos.config.arenaHeight) {
                bot.vy *= -1;
                bot.y = clamp(bot.y, 0, chaos.config.arenaHeight);
                chaos.stats.collisions += 1;
                bot.action = 'bounce';
                bot.actionTick = chaos.tick;
            }

            if (bot.energy <= 0) {
                bot.energy = randomBetween(35, 90);
                bot.hp = clamp(bot.hp + randomBetween(8, 20), 1, 100);
                bot.action = 'recover';
                bot.actionTick = chaos.tick;
            }

            if (Math.random() < 0.13 && chaos.bots.length > 1) {
                const target = nearestBot(i);
                if (target) {
                    const damage = randomBetween(1.5, 7.5);
                    target.hp -= damage;
                    bot.score += Math.floor(damage);
                    bot.action = 'attack';
                    bot.actionTick = chaos.tick;

                    if (target.hp <= 0) {
                        chaos.stats.kills += 1;
                        target.hp = randomBetween(70, 100);
                        target.energy = randomBetween(40, 100);
                        target.x = randomBetween(0, chaos.config.arenaWidth);
                        target.y = randomBetween(0, chaos.config.arenaHeight);
                        target.vx = randomBetween(-2.2, 2.2);
                        target.vy = randomBetween(-2.2, 2.2);
                        target.action = 'respawn';
                        target.actionTick = chaos.tick;
                    }
                }
            }

            if (chaos.tick - bot.actionTick > 30) {
                bot.action = 'idle';
            }
        }

        const writes = clamp(chaos.config.writesPerTick, 0, 2500);
        for (let i = 0; i < writes; i++) {
            const index = (chaos.tick * 37 + i * 101) % chaos.bots.length;
            const bot = chaos.bots[index];
            chaosDb.write(`chaos:bot:${bot.id}`, {
                id: bot.id,
                x: Number(bot.x.toFixed(2)),
                y: Number(bot.y.toFixed(2)),
                vx: Number(bot.vx.toFixed(2)),
                vy: Number(bot.vy.toFixed(2)),
                hp: Number(bot.hp.toFixed(1)),
                energy: Number(bot.energy.toFixed(1)),
                score: bot.score,
                action: bot.action,
                tick: chaos.tick,
                ts: Date.now(),
            });
            chaos.stats.writes += 1;
        }

        const reads = clamp(chaos.config.readsPerTick, 0, 2500);
        for (let i = 0; i < reads; i++) {
            const index = (chaos.tick * 19 + i * 43) % chaos.bots.length;
            const bot = chaos.bots[index];
            chaosDb.read(`chaos:bot:${bot.id}`);
            chaos.stats.reads += 1;
        }

        if (chaos.tick % 5 === 0) {
            const eventKey = `chaos:event:${chaos.tick % 2000}`;
            chaosDb.write(eventKey, {
                tick: chaos.tick,
                collisions: chaos.stats.collisions,
                kills: chaos.stats.kills,
                botCount: chaos.bots.length,
            });
            chaos.stats.writes += 1;

            const oldEventKey = `chaos:event:${(chaos.tick + 1000) % 2000}`;
            chaosDb.delete(oldEventKey);
            chaos.stats.deletes += 1;
        }

        if (chaos.tick % Math.max(1, chaos.config.tickRate) === 0) {
            chaosDb.write(CHAOS_KEYS.CONFIG, chaos.config);
            chaosDb.write(CHAOS_KEYS.STATS, {
                ...chaos.stats,
                tick: chaos.tick,
                botCount: chaos.bots.length,
            });
            chaos.stats.writes += 2;
        }
    } catch (err) {
        chaos.stats.errors += 1;
        chaos.stats.lastError = err instanceof Error ? err.message : String(err);
        fastify.log.error({ err }, 'chaos tick failed');
    } finally {
        const tickMs = performance.now() - tickStart;
        chaos.stats.lastTickMs = Number(tickMs.toFixed(3));
        if (chaos.stats.ticks === 1) {
            chaos.stats.avgTickMs = chaos.stats.lastTickMs;
        } else {
            chaos.stats.avgTickMs = Number(((chaos.stats.avgTickMs * 0.95) + (chaos.stats.lastTickMs * 0.05)).toFixed(3));
        }
    }
}

function restartChaosLoop() {
    if (chaos.timer) {
        clearInterval(chaos.timer);
    }

    const hz = clamp(Number(chaos.config.tickRate) || 1, 1, 120);
    const intervalMs = Math.max(5, Math.floor(1000 / hz));
    chaos.timer = setInterval(tickChaos, intervalMs);
}

function loadChaosConfig() {
    const savedConfig = chaosDb.read(CHAOS_KEYS.CONFIG);
    if (!savedConfig || typeof savedConfig !== 'object') {
        return;
    }

    chaos.config = {
        ...chaos.config,
        running: savedConfig.running !== false,
        botCount: clamp(Number(savedConfig.botCount) || DEFAULT_CHAOS_CONFIG.botCount, 10, 1500),
        tickRate: clamp(Number(savedConfig.tickRate) || DEFAULT_CHAOS_CONFIG.tickRate, 1, 120),
        writesPerTick: clamp(Number(savedConfig.writesPerTick) || DEFAULT_CHAOS_CONFIG.writesPerTick, 0, 2500),
        readsPerTick: clamp(Number(savedConfig.readsPerTick) || DEFAULT_CHAOS_CONFIG.readsPerTick, 0, 2500),
        arenaWidth: clamp(Number(savedConfig.arenaWidth) || DEFAULT_CHAOS_CONFIG.arenaWidth, 320, 6000),
        arenaHeight: clamp(Number(savedConfig.arenaHeight) || DEFAULT_CHAOS_CONFIG.arenaHeight, 240, 4000),
    };
}

function collectCrudInsights(keys) {
    let validCount = 0;
    let invalidCount = 0;
    let totalPayloadBytes = 0;
    let totalPlayers = 0;
    let newestTimestamp = 0;
    let largestRecord = { key: '-', bytes: 0 };
    const phaseCounts = {};
    const rows = [];

    for (const key of keys) {
        const value = crudDb.read(key);
        const validation = validateGameState(value);
        const payload = JSON.stringify(value) || 'null';
        const payloadBytes = Buffer.byteLength(payload);
        totalPayloadBytes += payloadBytes;

        if (payloadBytes > largestRecord.bytes) {
            largestRecord = { key, bytes: payloadBytes };
        }

        let gameId = '-';
        let tick = '-';
        let players = '-';
        let updatedAt = '-';
        let phase = '-';

        if (validation.ok) {
            validCount += 1;
            gameId = value.gameId;
            tick = value.tick.toLocaleString('en-US');
            players = value.players.length.toLocaleString('en-US');
            totalPlayers += value.players.length;
            newestTimestamp = Math.max(newestTimestamp, value.updatedAt);
            updatedAt = new Date(value.updatedAt).toLocaleString();
            phase = value.world?.phase || '-';
            phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;
        } else {
            invalidCount += 1;
        }

        rows.push({
            key,
            status: validation.ok ? 'valid' : 'invalid',
            statusReason: validation.ok ? '' : validation.error,
            gameId,
            tick,
            players,
            updatedAt,
            phase,
            payloadBytes,
        });
    }

    const avgPayloadBytes = keys.length > 0 ? Math.round(totalPayloadBytes / keys.length) : 0;
    const topPhase = Object.entries(phaseCounts).sort((a, b) => b[1] - a[1])[0] || ['-', 0];

    return {
        rows,
        metrics: {
            totalKeys: keys.length,
            validCount,
            invalidCount,
            totalPayloadBytes,
            avgPayloadBytes,
            totalPlayers,
            newestTimestamp,
            largestRecord,
            topPhase: { phase: topPhase[0], count: topPhase[1] },
        },
    };
}

function renderCrudPage(view = 'home') {
    const keys = crudDb.keys().sort();
    const crudStats = dbFileStats(CRUD_DB_FILE);
    const chaosStats = dbFileStats(CHAOS_DB_FILE);
    const chaosSnapshot = chaosDb.read(CHAOS_KEYS.STATS);
    const { rows, metrics } = collectCrudInsights(keys);
    const showCrudView = view === 'crud';
    const chaosUptimeMs = Math.max(1, chaosSnapshot?.uptimeMs || (chaosSnapshot?.startedAt ? Date.now() - chaosSnapshot.startedAt : 0));
    const chaosWriteRate = (chaosSnapshot?.writes || 0) / (chaosUptimeMs / 1000);
    const chaosReadRate = (chaosSnapshot?.reads || 0) / (chaosUptimeMs / 1000);

    const rowsHtml = rows.map((row) => `
      <tr>
        <td><code>${escapeHtml(row.key)}</code></td>
        <td>${escapeHtml(row.gameId)}</td>
        <td>${row.tick}</td>
        <td>${row.players}</td>
        <td>${escapeHtml(row.phase)}</td>
        <td>${row.updatedAt}</td>
        <td>${row.payloadBytes.toLocaleString('en-US')} B</td>
        <td><span title="${escapeHtml(row.statusReason || row.status)}">${row.status}</span></td>
        <td>
          <button class="action" data-action="read" data-key="${escapeHtml(row.key)}">Read</button>
          <button class="action" data-action="delete" data-key="${escapeHtml(row.key)}">Delete</button>
        </td>
      </tr>
    `).join('');

    return `
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>JSONBLite testbed</title>
<style>
body { margin: 1rem; font-family: sans-serif; line-height: 1.4; }
header, section, aside, footer { margin-bottom: 1rem; }
main.layout { display: grid; gap: 1rem; }
@media (min-width: 980px) {
  main.layout.crud { grid-template-columns: 1fr 1.5fr; }
}
textarea, input[type="text"] { width: 100%; font-family: monospace; }
textarea { min-height: 10rem; }
.actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 0.5rem 0; }
.table-wrap { overflow: auto; max-height: 26rem; }
table { width: 100%; border-collapse: collapse; }
th, td { border: 1px solid #ccc; padding: 0.35rem; text-align: left; vertical-align: top; }
pre { background: #f7f7f7; border: 1px solid #ddd; padding: 0.5rem; overflow: auto; }
#message { min-height: 1.2rem; }
nav a { margin-right: 0.75rem; }
footer ul { margin: 0.25rem 0 0; padding-left: 1.2rem; }
</style>
</head>
<body>
<header>
  <h1>JSONBLite Testbed</h1>
  <p>Public writes are restricted to validated <code>game_state</code> objects.</p>
  <nav aria-label="Primary">
    <a href="/">Home</a>
    <a href="/?view=crud">Basic CRUD</a>
    <a href="/chaos">Chaos</a>
  </nav>
</header>

${showCrudView ? '' : `
<main class="layout">
  <section aria-labelledby="choose-view">
    <h2 id="choose-view">Choose View</h2>
    <div class="actions">
      <form action="/chaos" method="get">
        <button type="submit">Display chaos.db</button>
      </form>
      <form action="/" method="get">
        <input type="hidden" name="view" value="crud" />
        <button type="submit">Display basic CRUD</button>
      </form>
    </div>
  </section>

  <aside aria-labelledby="quick-stats">
    <h2 id="quick-stats">Quick Stats</h2>
    <ul>
      <li>crud records: ${metrics.totalKeys.toLocaleString('en-US')}</li>
      <li>valid game states: ${metrics.validCount.toLocaleString('en-US')}</li>
      <li>invalid/legacy rows: ${metrics.invalidCount.toLocaleString('en-US')}</li>
      <li>avg payload: ${metrics.avgPayloadBytes.toLocaleString('en-US')} B</li>
      <li>crud.db size: ${crudStats.label}</li>
      <li>chaos.db size: ${chaosStats.label}</li>
    </ul>
  </aside>
</main>
`}

${showCrudView ? `
<main class="layout crud">
  <section aria-labelledby="crud-actions">
    <h2 id="crud-actions">CRUD Actions</h2>

    <label for="keyInput">Key</label>
    <input id="keyInput" type="text" placeholder="game:match-001" />

    <label for="valueInput">Game State JSON</label>
    <textarea id="valueInput" spellcheck="false">${escapeHtml(JSON.stringify(createDemoGameState('match-template'), null, 2))}</textarea>

    <p><small>Schema: type, gameId, tick, updatedAt, players[] (+ optional world/events). Unknown fields are rejected.</small></p>

    <div class="actions" role="group" aria-label="CRUD Buttons">
      <button id="writeBtn" type="button">Write game state</button>
      <button id="randomBtn" type="button">Write demo game state</button>
      <button id="vacuumBtn" type="button">Vacuum crud.db</button>
      <button id="refreshBtn" type="button">Refresh</button>
    </div>

    <p id="message" aria-live="polite"></p>

    <h3>Record Preview</h3>
    <pre id="preview">Select a key and click Read.</pre>

    <h3>Stats</h3>
    <ul>
      <li>total payload: ${humanBytes(metrics.totalPayloadBytes)}</li>
      <li>largest record: ${escapeHtml(metrics.largestRecord.key)} (${metrics.largestRecord.bytes.toLocaleString('en-US')} B)</li>
      <li>active players tracked: ${metrics.totalPlayers.toLocaleString('en-US')}</li>
      <li>latest update: ${metrics.newestTimestamp ? new Date(metrics.newestTimestamp).toLocaleString() : '-'}</li>
      <li>top phase: ${escapeHtml(metrics.topPhase.phase)} (${metrics.topPhase.count})</li>
      <li>chaos write rate: ${chaosWriteRate.toFixed(1)} ops/s</li>
      <li>chaos read rate: ${chaosReadRate.toFixed(1)} ops/s</li>
    </ul>
  </section>

  <section aria-labelledby="crud-table">
    <h2 id="crud-table">Stored Keys</h2>
    ${rows.length === 0 ? '<p>No keys in crud.db yet. Write one game_state to get started.</p>' : `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Game</th>
              <th>Tick</th>
              <th>Players</th>
              <th>Phase</th>
              <th>Updated</th>
              <th>Size</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    `}
  </section>
</main>

<script>
const keyInput = document.getElementById('keyInput');
const valueInput = document.getElementById('valueInput');
const writeBtn = document.getElementById('writeBtn');
const randomBtn = document.getElementById('randomBtn');
const vacuumBtn = document.getElementById('vacuumBtn');
const refreshBtn = document.getElementById('refreshBtn');
const preview = document.getElementById('preview');
const message = document.getElementById('message');

function setMessage(type, text) {
  message.textContent = (type === 'error' ? 'Error: ' : 'OK: ') + text;
}

async function postJson(url, payload = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || response.statusText);
  }
  return body;
}

writeBtn.addEventListener('click', async () => {
  try {
    const key = keyInput.value.trim();
    if (!key) throw new Error('Key is required');
    const value = JSON.parse(valueInput.value);
    await postJson('/api/crud/write', { key, value });
    setMessage('ok', 'Wrote key: ' + key);
    setTimeout(() => location.reload(), 250);
  } catch (err) {
    setMessage('error', err.message);
  }
});

randomBtn.addEventListener('click', async () => {
  try {
    const result = await postJson('/api/crud/random');
    setMessage('ok', 'Wrote random key: ' + result.key);
    setTimeout(() => location.reload(), 250);
  } catch (err) {
    setMessage('error', err.message);
  }
});

vacuumBtn.addEventListener('click', async () => {
  try {
    await postJson('/api/crud/vacuum');
    setMessage('ok', 'Vacuum completed for crud.db');
    setTimeout(() => location.reload(), 250);
  } catch (err) {
    setMessage('error', err.message);
  }
});

refreshBtn.addEventListener('click', () => location.reload());

document.querySelectorAll('button.action').forEach((button) => {
  button.addEventListener('click', async () => {
    const action = button.dataset.action;
    const key = button.dataset.key;

    if (action === 'read') {
      try {
        const result = await fetch('/api/crud/read/' + encodeURIComponent(key));
        if (!result.ok) throw new Error('Key not found');
        const value = await result.json();
        preview.textContent = JSON.stringify({ key, value }, null, 2);
        setMessage('ok', 'Read key: ' + key);
      } catch (err) {
        setMessage('error', err.message);
      }
      return;
    }

    if (action === 'delete') {
      try {
        await postJson('/api/crud/delete', { key });
        setMessage('ok', 'Deleted key: ' + key);
        setTimeout(() => location.reload(), 250);
      } catch (err) {
        setMessage('error', err.message);
      }
    }
  });
});
</script>
` : ''}

<footer>
  <h2>Links</h2>
  <ul>
    <li><a href="/dump/crud" target="_blank" rel="noreferrer">Dump crud.db</a></li>
    <li><a href="/dump/chaos" target="_blank" rel="noreferrer">Dump chaos.db</a></li>
    <li><a href="${GITHUB_URL}" target="_blank" rel="noreferrer">GitHub repository</a></li>
  </ul>
</footer>
</body>
</html>`;
}


loadChaosConfig();
resetChaosState();
restartChaosLoop();

fastify.get('/', async (request, reply) => {
    const view = request.query?.view === 'crud' ? 'crud' : 'home';
    reply.type('text/html').send(renderCrudPage(view));
});

fastify.get('/chaos', async (request, reply) => {
    reply.type('text/html').send(fs.readFileSync(CHAOS_PAGE_PATH, 'utf8'));
});

fastify.get('/api/chaos/state', async (request, reply) => {
    reply.send({
        tick: chaos.tick,
        now: Date.now(),
        config: chaos.config,
        stats: {
            ...chaos.stats,
            uptimeMs: Date.now() - chaos.stats.startedAt,
            botCount: chaos.bots.length,
        },
        bots: chaos.bots,
    });
});

fastify.post('/api/chaos/config', async (request, reply) => {
    const input = request.body || {};
    const previousTickRate = chaos.config.tickRate;

    if (Object.hasOwn(input, 'running')) {
        chaos.config.running = Boolean(input.running);
    }

    if (Object.hasOwn(input, 'botCount')) {
        chaos.config.botCount = clamp(Number(input.botCount) || chaos.config.botCount, 10, 1500);
        setBotCount(chaos.config.botCount);
    }

    if (Object.hasOwn(input, 'tickRate')) {
        chaos.config.tickRate = clamp(Number(input.tickRate) || chaos.config.tickRate, 1, 120);
    }

    if (Object.hasOwn(input, 'writesPerTick')) {
        chaos.config.writesPerTick = clamp(Number(input.writesPerTick) || chaos.config.writesPerTick, 0, 2500);
    }

    if (Object.hasOwn(input, 'readsPerTick')) {
        chaos.config.readsPerTick = clamp(Number(input.readsPerTick) || chaos.config.readsPerTick, 0, 2500);
    }

    if (Object.hasOwn(input, 'arenaWidth')) {
        chaos.config.arenaWidth = clamp(Number(input.arenaWidth) || chaos.config.arenaWidth, 320, 6000);
    }

    if (Object.hasOwn(input, 'arenaHeight')) {
        chaos.config.arenaHeight = clamp(Number(input.arenaHeight) || chaos.config.arenaHeight, 240, 4000);
    }

    if (previousTickRate !== chaos.config.tickRate) {
        restartChaosLoop();
    }

    chaosDb.write(CHAOS_KEYS.CONFIG, chaos.config);

    reply.send({ ok: true, config: chaos.config });
});

fastify.post('/api/chaos/reset', async (request, reply) => {
    resetChaosState();
    chaosDb.write(CHAOS_KEYS.CONFIG, chaos.config);
    reply.send({ ok: true });
});

fastify.post('/api/chaos/vacuum', async (request, reply) => {
    chaosDb.vacuum();
    chaos.stats.lastVacuumAt = Date.now();
    reply.send({ ok: true, lastVacuumAt: chaos.stats.lastVacuumAt });
});

fastify.post('/api/crud/write', async (request, reply) => {
    const body = request.body || {};
    const key = String(body.key || '').trim();
    if (!key) {
        reply.status(400).send({ error: 'key is required' });
        return;
    }
    if (!isValidGameStateKey(key)) {
        reply.status(400).send({ error: 'key must match pattern game:<id>' });
        return;
    }

    const validation = validateGameState(body.value);
    if (!validation.ok) {
        reply.status(400).send({ error: `invalid game_state payload: ${validation.error}` });
        return;
    }

    try {
        crudDb.write(key, body.value);
        reply.send({ ok: true, key });
    } catch (err) {
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
});

fastify.post('/api/crud/random', async (request, reply) => {
    const gameId = `match-${uuidv4().slice(0, 8)}`;
    const key = `game:${gameId}`;
    const value = createDemoGameState(gameId);
    crudDb.write(key, value);
    reply.send({ ok: true, key, value });
});

fastify.post('/api/crud/delete', async (request, reply) => {
    const body = request.body || {};
    const key = String(body.key || '').trim();
    if (!key) {
        reply.status(400).send({ error: 'key is required' });
        return;
    }

    crudDb.delete(key);
    reply.send({ ok: true, key });
});

fastify.post('/api/crud/vacuum', async (request, reply) => {
    crudDb.vacuum();
    reply.send({ ok: true });
});

fastify.get('/api/crud/read/:key', async (request, reply) => {
    const { key } = request.params;
    const value = crudDb.read(key);
    if (value === null) {
        reply.status(404).send({ error: 'Key not found' });
        return;
    }
    reply.send(value);
});

fastify.get('/new', async (request, reply) => {
    const gameId = `match-${uuidv4().slice(0, 8)}`;
    const key = `game:${gameId}`;
    const value = createDemoGameState(gameId);
    crudDb.write(key, value);
    reply.redirect('/?view=crud');
});

fastify.get('/delete/:key', async (request, reply) => {
    const { key } = request.params;
    crudDb.delete(key);
    reply.redirect('/?view=crud');
});

fastify.get('/dump/crud', async (request, reply) => {
    const stream = crudDb.dump();
    reply.type('application/json').send(stream);
});

fastify.get('/dump/chaos', async (request, reply) => {
    const stream = chaosDb.dump();
    reply.type('application/json').send(stream);
});

fastify.get('/dump', async (request, reply) => {
    reply.redirect('/dump/crud');
});

fastify.get('/vacuum', async (request, reply) => {
    crudDb.vacuum();
    reply.redirect('/?view=crud');
});

const start = async () => {
    try {
        await fastify.listen({ port: 3000 });
        fastify.log.info('Server listening on http://localhost:3000');
        fastify.log.info(`crud db: ${CRUD_DB_FILE}`);
        fastify.log.info(`chaos db: ${CHAOS_DB_FILE}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
