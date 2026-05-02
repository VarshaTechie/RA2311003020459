# Notification System Design Document

---

## Stage 1 — APIs + JSON Structure

### System Overview

A Node.js + Express backend that:
1. Fetches maintenance tasks (vehicles) and depot constraints from an external evaluation service
2. Applies 0/1 Knapsack scheduling to maximise impact per depot
3. Returns optimal task assignments as JSON

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/schedule` | Run knapsack scheduler for all depots |
| GET | `/` | Health check |

### JSON Contract

**Request**: `GET /api/schedule` (no body required)

**Response**:
```json
{
  "results": [
    {
      "depotId": "D1",
      "totalImpact": 42,
      "selectedTasks": ["T2", "T5", "T8"]
    }
  ]
}
```

**External APIs consumed**:

```
GET  http://20.207.122.201/evaluation-service/depots
     → { depots: [{ ID, MechanicHours }] }

GET  http://20.207.122.201/evaluation-service/vehicles
     → { vehicles: [{ TaskID, Duration, Impact }] }

GET  http://20.207.122.201/evaluation-service/notifications
     → { notifications: [{ Type, Timestamp, ... }] }

POST http://20.207.122.201/evaluation-service/logs
     → { stack, level, package, message }
```

### Architecture Flow (Stage 1)

```
Client
  │
  └─► GET /api/schedule
          │
          ├─► GET evaluation-service/depots
          ├─► GET evaluation-service/vehicles
          │
          └─► knapsack(vehicles, depot.MechanicHours)  ← per depot
                  │
                  └─► { depotId, totalImpact, selectedTasks }
```

---

## Stage 2 — Database + Schema Design

### Why a Database?

In-memory Maps are lost on restart and don't support concurrent workers. A relational database provides:
- **Persistence** across restarts
- **ACID transactions** for state changes
- **Concurrent access** from multiple API instances

### Proposed Schema (PostgreSQL)

```sql
-- Depots: mechanic hour capacity per location
CREATE TABLE depots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id     VARCHAR(50) UNIQUE NOT NULL,   -- matches eval API depot.ID
  name            VARCHAR(255),
  mechanic_hours  INTEGER NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Vehicles / Maintenance Tasks
CREATE TABLE maintenance_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         VARCHAR(50) UNIQUE NOT NULL,   -- matches eval API TaskID
  duration        INTEGER NOT NULL,              -- hours required
  impact          INTEGER NOT NULL,              -- priority value
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Schedule Results: which tasks were assigned to which depot
CREATE TABLE schedule_results (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  depot_id        UUID REFERENCES depots(id),
  task_id         UUID REFERENCES maintenance_tasks(id),
  total_impact    INTEGER,
  scheduled_at    TIMESTAMPTZ DEFAULT NOW(),
  status          VARCHAR(20) DEFAULT 'pending'  -- pending | completed
);

-- Notifications
CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            VARCHAR(50) NOT NULL,           -- Placement | Result | Event
  message         TEXT,
  timestamp       TIMESTAMPTZ NOT NULL,
  notified        BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Audit log (mirrors what we send to eval API)
CREATE TABLE logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stack           VARCHAR(20) NOT NULL,
  level           VARCHAR(10) NOT NULL,
  package         VARCHAR(20) NOT NULL,
  message         TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

### Entity Relationship

```
depots  1──N  schedule_results  N──1  maintenance_tasks
                    │
                    └── status: pending → completed
```

---

## Stage 3 — Indexing + Query Optimisation

### Problem

Without indexes, queries like "find all pending tasks for a depot" or "find due notifications" require full table scans — unacceptable at scale.

### Critical Indexes

```sql
-- Schedule results: filter by depot + status (most common query)
CREATE INDEX idx_schedule_depot_status
  ON schedule_results(depot_id, status);

-- Notifications: filter unnotified + sort by type + timestamp
CREATE INDEX idx_notifications_notified
  ON notifications(notified, type, timestamp DESC)
  WHERE notified = FALSE;

-- Maintenance tasks: lookup by external task_id
CREATE INDEX idx_tasks_task_id
  ON maintenance_tasks(task_id);

-- Logs: filter by level for monitoring
CREATE INDEX idx_logs_level_created
  ON logs(level, created_at DESC);
```

### Query Optimisation

**Before (full scan)**:
```sql
SELECT * FROM schedule_results WHERE status = 'pending';
-- Seq Scan, cost ~O(N)
```

**After (index scan)**:
```sql
SELECT * FROM schedule_results
WHERE depot_id = $1 AND status = 'pending'
ORDER BY scheduled_at DESC;
-- Index Scan using idx_schedule_depot_status, cost ~O(log N)
```

### Connection Pooling

Use `pg-pool` to manage DB connections:
```js
const { Pool } = require('pg');
const pool = new Pool({ max: 20, idleTimeoutMillis: 30000 });
```

---

## Stage 4 — Caching + Performance

### What to Cache

| Data | Cache Strategy | TTL |
|------|----------------|-----|
| Depot list | Redis key-value | 5 minutes |
| Vehicle/task list | Redis key-value | 5 minutes |
| Schedule results | Redis hash by depotId | 10 minutes |
| Top-10 notifications | Redis sorted set | 1 minute |

### Cache Architecture

```
Client
  │
  └─► GET /api/schedule
          │
          ├─► Redis GET "depots"
          │     ├── HIT  → use cached depots
          │     └── MISS → fetch from eval API → SET "depots" TTL 300s
          │
          ├─► Redis GET "vehicles"
          │     ├── HIT  → use cached vehicles
          │     └── MISS → fetch from eval API → SET "vehicles" TTL 300s
          │
          └─► Run knapsack → store result in Redis
```

### Implementation Pattern

```js
async function getDepots() {
  const cached = await redis.get("depots");
  if (cached) return JSON.parse(cached);

  const res  = await axios.get(DEPOT_API);
  await redis.set("depots", JSON.stringify(res.data.depots), "EX", 300);
  return res.data.depots;
}
```

### Cache Invalidation

- **TTL-based**: Auto-expires stale data (no manual invalidation needed for read-heavy data)
- **Write-through**: On any mutation, immediately update/delete cache key
- **Event-driven**: Use Redis Pub/Sub to broadcast invalidation to all nodes

---

## Stage 5 — Queue + Async Notification System

### Problem with Synchronous Notifications

Sending notifications inline (in the request cycle) causes:
- Slow API responses (user waits for email/SMS delivery)
- Lost notifications if server crashes mid-send
- No retry mechanism

### Solution: Message Queue + Worker Pool

```
┌────────────────────────┐
│   Scheduler (cron)     │  ← runs every 60s
│   setInterval / cron   │
└────────┬───────────────┘
         │ enqueue job
         ▼
┌────────────────────────┐
│   Redis / BullMQ Queue │  ← persistent, durable
│   "notification-jobs"  │
└────────┬───────────────┘
         │ consume job
         ▼
┌────────────────────────┐
│   Worker Pool          │  ← multiple parallel workers
│   worker-1             │
│   worker-2             │  → trigger: console | email | SMS | push
│   worker-N             │
└────────────────────────┘
```

### BullMQ Implementation Sketch

```js
// Producer (notifier.js)
const { Queue } = require('bullmq');
const notifQueue = new Queue('notifications', { connection: redisConn });

async function enqueueNotification(record) {
  await notifQueue.add('send-alert', { recordId: record.id }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });
}

// Consumer (worker.js)
const { Worker } = require('bullmq');
const worker = new Worker('notifications', async (job) => {
  const { recordId } = job.data;
  await sendAlert(recordId);     // email / SMS / push / console
  await markNotified(recordId);  // update DB
}, { connection: redisConn });
```

### Key Properties

- **Durability**: Jobs survive server restarts (stored in Redis)
- **Retry with backoff**: 3 attempts with exponential delay
- **Dead Letter Queue**: After max retries, job moves to failed queue for inspection
- **Idempotency**: Mark `notified = true` only after confirmed delivery

---

## Stage 6 — Priority Inbox + Heap Strategy

### Problem

With thousands of notifications, displaying all of them is overwhelming. Users need the **top 10 most important** notifications shown first.

### Priority Rules

```
Placement  → Priority 3  (highest — career critical)
Result     → Priority 2  (academic outcome)
Event      → Priority 1  (informational)
```

Tie-breaking: **newer timestamp wins** (most recent first within same priority).

### Current Implementation

`notification_app_be/priorityInbox.js` uses `Array.sort()` — O(N log N) — which is correct and sufficient for moderate N.

```js
const PRIORITY = { Placement: 3, Result: 2, Event: 1 };

function getTop10(notifications) {
  return [...notifications]
    .sort((a, b) => {
      const pa = PRIORITY[a.Type] ?? 0;
      const pb = PRIORITY[b.Type] ?? 0;
      if (pb !== pa) return pb - pa;                              // priority desc
      return new Date(b.Timestamp) - new Date(a.Timestamp);      // timestamp desc
    })
    .slice(0, 10);
}
```

### At Scale — Min-Heap Strategy

For 1M+ notifications, sorting the entire array is expensive. A **min-heap of size 10** is optimal:

**Algorithm**:
1. Maintain a min-heap of size 10 (min = lowest priority item)
2. For each notification:
   - If heap size < 10 → push
   - Else if current > heap.min → pop min, push current
3. Result: heap contains top 10, O(N log 10) ≈ O(N)

```
Complexity:
  Array.sort approach  → O(N log N)   — fine up to ~100K notifications
  Min-heap approach    → O(N log 10)  — optimal for 1M+ notifications
```

### Data Flow Diagram

```
GET evaluation-service/notifications
             │
             ▼
    notifications[] (N items)
             │
             ▼
    getTop10() — sort by priority, then timestamp
             │
             ▼
    top10[] (max 10 items)
             │
             ▼
    Display / Return to client
```

---

## Architecture Overview (All Stages Combined)

```
┌─────────────────────────────────────────────────────────────────────┐
│                          CLIENT / POSTMAN                            │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     server.js (Express + CORS)                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │           Request Logger Middleware (every request)           │   │
│  └───────────────────────────┬──────────────────────────────────┘   │
│                              │                                       │
│  ┌───────────────────────────▼──────────────────────────────────┐   │
│  │       vehicle_maintenance_scheduler/routes.js                 │   │
│  │       GET /api/schedule → fetch → knapsack → respond         │   │
│  └───────────────────────────┬──────────────────────────────────┘   │
│                              │                                       │
│  ┌───────────────────────────▼──────────────────────────────────┐   │
│  │       vehicle_maintenance_scheduler/service.js                │   │
│  │       knapsack(vehicles, capacity) → { maxImpact, tasks }    │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  notification_app_be/notifier.js  (Stage 5 - queue/async)    │   │
│  │  notification_app_be/priorityInbox.js  (Stage 6 - top 10)   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │       logging_middleware/logger.js (cross-cutting)            │   │
│  │       Validates → POSTs to evaluation-service/logs            │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
         │                          │
         ▼                          ▼
 Eval API (depots,           Eval API (logs)
 vehicles, notifications)
```
