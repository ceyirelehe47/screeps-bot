# Screeps Local Dev Setup (Tutorial 1-4)

This repository follows HoPGoldy's Screeps environment series up to section 4:

1. VSCode autocomplete
2. Rollup build and upload
3. TypeScript static checks
4. Jest unit tests

Section 5 (`screeps-server-mockup`) is intentionally skipped.

## Prerequisites

- Node.js >= 16
- npm >= 8

## Setup

1. Install dependencies:

```bash
npm install
```

2. Edit `.secret.json`:

- `main.token`: your Screeps auth token
- `local.copyPath`: your Screeps local scripts directory

Token page: `https://screeps.com/a/#!/account/auth-tokens`

## Project Structure

- `src/main.ts`: game entry, scheduler, spawn/creep work dispatch
- `src/runtime/creepApi.ts`: global `creepApi` config management
- `src/runtime/bootstrap.ts`: room-based default config bootstrap
- `src/runtime/spawnPlanner.ts`: config-driven spawn task scheduling
- `src/mount/`: prototype mounting (`Creep.work`, `Spawn.work/addTask/mainSpawn`)
- `src/roles/`: role lifecycle factories (`source/target/prepare`)
- `src/config/spawnProfiles.ts`: role body templates by room energy capacity
- `src/types/system.ts`: architecture core types
- `src/modules/errorMapper.ts`: source-map based stack trace mapper
- `test/setup.ts`: Jest test environment setup
- `test/mock/index.ts`: basic Screeps global mocks (`Game`, `Memory`, `_`, constants)

## Commands

- `npm run build`: compile only (no upload)
- `npm run local`: compile and copy bundle to local scripts folder
- `npm run push`: compile and upload to Screeps server
- `npm run watch`: compile in watch mode
- `npm run monitor:serve`: run external monitor service (HTTP + polling)
- `npm run monitor:once`: fetch one snapshot and exit
- `npm run test`: run Jest tests
- `npm run test:verify`：在服务器执行不带筛选条件的完整 Jest，核对 tracked、磁盘、Jest discovery 和原始结果集合，拒绝跳过、聚焦、反向通过和运行期失败；保存日志与源码身份，不限制固定用例数量。
- `npm run test:budget`：兼容入口，与 `test:verify` 相同，旧固定数量预算和保护文件哈希清单已退役。
- `npm run test:verify -- --results /绝对路径/results.json`（或 `npm run test:budget -- --results /绝对路径/results.json`）：只复核同次完整运行保存的结果及 `execution.json`、`discovered-tests.json`，要求当前源码身份匹配；不会重跑 Jest，也不接受任意单独结果文件。
- `npm run test-c`: run Jest coverage report

## Notes

- `.secret.json` is ignored by git. Do not commit tokens.
- If `npm run push` returns `Not Authorized`, check `main.token` in `.secret.json`.
- Rollup output is a single `dist/main.js`, matching Screeps runtime requirements.

## External Monitor

External monitor service: `scripts/monitor-service.mjs`. Requires Node.js 18+ (Node 24 recommended).

Sources:
- Primary: `Memory.analytics.production` (via `runProductionMonitor`)
- CPU Monitor v2: `Memory.analytics.cpuMonitor` and `RawMemory` segment payload `cpuMonitor`
- Optional debug: `RawMemory.segments[segmentId]` (via `runExternalTelemetryExport`)

### CPU Monitor v2

CPU Monitor v2 is a diagnostics-only subsystem. It reports and exports CPU data. It does not throttle gameplay, trigger emergency brakes, or alter behavior in any way.

**Runtime storage:**
- `Memory.analytics.cpuMonitor` — persisted snapshots, summary, config metadata (schema `version: 2`)
- `RawMemory` segment `cpuMonitor` — compact telemetry payload exported every sample tick
- Config lives under `Memory.cfg.cpuProfiler` (same namespace as the original profiler)

**v2 data highlights:** total CPU used, bucket, tickLimit, exponential moving average (EMA), top phases, top rooms/roles, heap statistics, fixed-action CPU estimate, bounded history ring buffer.

**Console commands** (run in Screeps console):

```js
// Enable with defaults (sampleInterval=10, historyLimit=120)
startCpuProfiler()
startCpuProfiler(5, 200)     // custom interval and history limit
stopCpuProfiler()            // disable
statusCpuProfiler()          // show current config and state

cpuMonitor()                 // formatted v2 summary (version, EMA, top phases, rooms, heap)

// Raw JSON variants
startCpuProfilerRaw()
stopCpuProfilerRaw()
statusCpuProfilerRaw()
cpuMonitorRaw()
```

**Config fields** (set via `Memory.cfg.cpuProfiler`):

| Field | Default | Notes |
|---|---|---|
| `enabled` | `false` | Master switch |
| `sampleInterval` | `10` | Ticks between samples (min 1, max 60) |
| `historyLimit` | `120` | Ring buffer depth (min 10, max 500) |
| `emaAlpha` | `0.1` | EMA smoothing factor (> 0, ≤ 1) |
| `roomRoleAggregation` | `true` | Track CPU per room/role |
| `heapStats` | `true` | Capture `Game.cpu.getHeapStatistics()` |
| `fixedActionCpuCost` | `0.2` | Estimated CPU cost per fixed action |

### Enable segment debug telemetry

Run in Screeps console:

```js
Memory.cfg = Memory.cfg || {}
Memory.cfg.telemetry = {
  enabled: true,
  sampleInterval: 10,
  segmentId: 90
}

startTelemetry()      // defaults: sampleInterval=10, segmentId=90
startTelemetry(5, 91) // custom
stopTelemetry()
statusTelemetry()
```

### Run the monitor

Token is loaded from `.secret.json` when present.

```bash
npm run monitor:serve
```

Explicit token and segment polling:

```bash
SCREEPS_TOKEN=your-token SCREEPS_MONITOR_SEGMENT_ID=90 npm run monitor:serve
```

Non-default shard:

```bash
SCREEPS_MONITOR_SHARD=shard2 SCREEPS_MONITOR_SEGMENT_ID=90 npm run monitor:serve
```

One-shot mode:

```bash
npm run monitor:once
```

Fixture mode (no token, no API call):

```bash
node scripts/monitor-service.mjs --once \
  --memory-fixture .sisyphus/fixtures/task-8-cpu-monitor-v2-memory.json \
  --segment-id off --output off --no-http
```

### Monitor HTTP endpoints

- Summary: `http://127.0.0.1:3131/`
- Health: `http://127.0.0.1:3131/health`
- Full state: `http://127.0.0.1:3131/state`
- Rooms: `http://127.0.0.1:3131/rooms`
- Poll history: `http://127.0.0.1:3131/history`
- CPU data: `http://127.0.0.1:3131/cpu`
- Hub analytics: `http://127.0.0.1:3131/hub`

Snapshots append to `monitor-data/snapshots.jsonl`.

### `/cpu` endpoint keys

The `/cpu` endpoint returns v2 data first, with read-only legacy fallback:

| Key | Source | Description |
|---|---|---|
| `memoryCpuMonitor` | `Memory.analytics.cpuMonitor` | v2 snapshot, summary, config |
| `segmentCpuMonitor` | `RawMemory` segment | v2 segment payload (when available) |
| `segmentCpuMonitorHistory` | `RawMemory` segment | v2 history array from segment |
| `segmentSchemaVersion` | `RawMemory` segment | Schema version (expected: `2`) |
| `memoryModuleCpu` | `Memory.analytics.moduleCpu` | Legacy, read-only fallback |
| `segmentModuleCpu` | `RawMemory` segment | Legacy, read-only fallback |

`cpuMonitor` is the canonical v2 namespace. The older `moduleCpu` is kept as a secondary read-only fallback for old fixtures and API responses.

When hub is enabled, `npm run monitor:once` includes hub progress under `memory.hub`.

- `SCREEPS_MONITOR_SHARD=<shard>` explicitly selects a shard; if omitted, the service falls back automatically.
- Screeps console: `hubProgressRaw()` returns raw hub progress; `hubProgress()` returns pretty-printed JSON.

## RoomPlanner Auto Construction

After you save layout to `Memory.data.roomPlanner[roomName]`, construction sites are queued automatically.

- Trigger planner output to Memory: place `SP` flag, or call `savePlanToMemory('W1N1')`
- Auto builder runs every 5 ticks
- Per room limit: up to 8 new sites per run (default)
- Global soft cap: stops when global construction sites reach 95

Optional runtime config in console:

```js
Memory.cfg = Memory.cfg || {}
Memory.cfg.roomPlannerBuild = {
  enabled: true,
  maxNewSitesPerRoom: 6
}
```

- Set `enabled: false` to pause auto site creation
- Priority order is spawn/extension/tower first, roads/ramparts later

## Energy Pickup Tuning

Carrier/worker energy pickup prefers targets with at least `min(creepCapacity, preferredMin)` energy.

```js
Memory.cfg = Memory.cfg || {}
Memory.cfg.energyPickup = {
  preferredMin: 800
}
```

If no target reaches the threshold, they will fallback to the nearest available energy source.
