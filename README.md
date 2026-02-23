# jsonblite example

An example Fastify playground for [JSONBLite](https://github.com/mkaski/jsonblite).

## Databases

- `./data/crud.db`: user-facing CRUD playground records.
- `./data/chaos.db`: bot swarm stress-test data used by the chaos canvas.

Both databases are intentionally separated so CRUD demos stay readable while chaos traffic can run aggressively.

## Routes

- `/` testbed launcher with 2 clear CTAs: display `chaos.db` canvas or display basic CRUD mode.
- `/chaos` full-page canvas "Chaos Arena" with public controls for load tuning.
- `/api/chaos/state` live simulation snapshot for canvas rendering.
- `/api/chaos/config` (`POST`) update chaos controls (`running`, `botCount`, `tickRate`, `writesPerTick`, `readsPerTick`, `arenaWidth`, `arenaHeight`).
- `/api/chaos/reset` (`POST`) reset the swarm.
- `/api/chaos/vacuum` (`POST`) vacuum `chaos.db`.
- `/?view=crud` basic CRUD table and operations UI with DB/game-state stats.
- `/api/crud/write` (`POST`) write/update record in `crud.db` (restricted to validated `game_state` payloads and keys matching `game:<id>`).
- `/api/crud/read/:key` (`GET`) read record from `crud.db`.
- `/api/crud/delete` (`POST`) delete record from `crud.db`.
- `/api/crud/random` (`POST`) write a random valid `game_state` record to `crud.db`.
- `/api/crud/vacuum` (`POST`) vacuum `crud.db`.
- `/dump/crud` and `/dump/chaos` JSON dump snapshots.

The chaos page is intentionally public and interactive so anyone can tune load in real time and observe DB behavior.
