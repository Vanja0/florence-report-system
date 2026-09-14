# Architecture — Automated Weekly Report Feature

## The one-sentence framing

This is **not** a request/response feature. It is a **scheduled, fan-out,
long-running, compute-heavy batch pipeline** with a compliance/delivery tail.
So the whole design is about *decoupling* the schedule from the compute from the
delivery, making every step **idempotent and resumable**, and controlling the
**fan-out** so a weekly tick doesn't stampede the datastores and the email quota.

## Design principles (the "why" I'll defend in the room)

1. **Decouple via a queue.** The API never generates a report inline. A tick
   enqueues work; workers drain it. This is what lets reads/writes, compute, and
   delivery scale and fail independently.
2. **Split into planes** with different scaling and failure profiles:
   - **Control plane** — subscriptions + scheduling (small, transactional).
   - **Compute plane** — report generation (bursty, CPU-heavy, long-running).
   - **Delivery plane** — email + secure download (throughput-limited by SES + auth).
   - **Audit/storage plane** — immutable trail + PDF store (regulated).
3. **Idempotency everywhere.** At-least-once transport means every step can
   re-run. Keyed side effects (`hash(subscriptionId, period)`) ? effectively-once.
4. **Durable, multi-step generation.** A report is a small workflow (aggregate ?
   fetch ? process ? render ? store ? notify). Model it so it *resumes* after a
   crash/deploy instead of restarting or getting stuck.
5. **Compute the expensive thing once.** Maintain shared study aggregates
   incrementally (CQRS read model); the per-report step is cheap assembly, not a
   full weekly recompute.
6. **Spread the load.** Shard the weekly schedule across the interval so peak ? average.
7. **Compliance is a design input, not a wrapper.** Audit, residency, and
   "no PHI in email" shape the boxes, not a checkbox at the end.

---

## C4 — Level 1: System context

```mermaid
flowchart TB
  user([Clinical user / site staff])
  admin([Ops / Support])
  subgraph Florence["Florence Platform"]
    existing["Existing Documents product<br/>(API + Mongo + S3)"]
    report["Automated Report System<br/>(new)"]
  end
  ses[[Amazon SES]]
  auth[[Auth0]]

  user -->|subscribe, view, download| report
  user -->|upload/manage docs| existing
  admin -->|regenerate, monitor| report
  report -->|reads source data & files| existing
  report -->|sends notification email| ses
  ses -->|report ready + secure link| user
  user -->|authenticated download| report
  report -->|validate JWT| auth
```

---

## C4 — Level 2: Component / container view

```mermaid
flowchart LR
  U([User / Browser])

  subgraph CP["Control plane (global)"]
    API["Report API<br/>NestJS"]
    SUBDB[("Subscriptions<br/>MongoDB")]
    SCH["EventBridge Scheduler<br/>(cron, sharded)"]
    PLN["Planner / Enumerator<br/>(finds due subs, batches)"]
  end

  subgraph Q1[" "]
    Q[["Report job queue<br/>SQS / Kafka topic"]]
    DLQ[["Dead-letter queue"]]
  end

  subgraph COMP["Compute plane (per-region)"]
    W["Report Workers<br/>ECS/EKS + durable execution"]
    IMG["Image-processing pool<br/>(CPU/GPU, autoscaled)"]
    AGG[("Shared aggregates /<br/>read model")]
  end

  subgraph DATA["Data & storage (per-region)"]
    SRC[("Source data:<br/>Documents (Mongo) + S3 files")]
    PDF[("Report PDFs<br/>S3 + KMS")]
    RDB[("Reports + Audit<br/>Mongo / Postgres")]
  end

  subgraph DEL["Delivery plane"]
    NQ[["Notify queue"]]
    N["Notification worker"]
    SES[[Amazon SES]]
    SNS["SES events via SNS<br/>(bounce/complaint)"]
  end

  U -->|CRUD subscription| API --> SUBDB
  U -->|list/status/download| API
  SCH --> PLN
  PLN -->|reads due| SUBDB
  PLN -->|enqueue jobs (idempotent)| Q
  Q --> W
  Q -. poison .-> DLQ
  W --> AGG
  W --> SRC
  W --> IMG
  W -->|upload PDF| PDF
  W -->|status + audit| RDB
  W -->|report.ready| NQ
  NQ --> N --> SES --> U
  SES --> SNS --> N
  API -->|pre-signed URL| PDF
  API -->|audit access| RDB
```

**Component responsibilities**

| Component | Responsibility | Notes |
|-----------|----------------|-------|
| **Report API (NestJS)** | Subscription CRUD; report listing/status; authenticated download; on-demand generate. | Thin, transactional. No heavy work inline. |
| **EventBridge Scheduler** | Fires cron ticks, **sharded** by day/hour/timezone. | Managed cron; avoids a single global stampede. |
| **Planner** | On a tick, enumerates *due* subscriptions and enqueues one job per report, **in batches**, with an idempotency key. | Separates "who is due" from "do the work". |
| **Report job queue** | Buffers work; provides backpressure; enables autoscaling on depth/lag. | SQS (AWS-native) or Kafka (Florence uses it). |
| **Report workers** | Durable multi-step workflow per report: aggregate ? fetch ? process ? render ? store ? notify. | ECS/EKS (no 15-min cap). Durable execution for resumability. |
| **Image-processing pool** | CPU/GPU-heavy image work, separate autoscaled pool. | Isolated so it doesn't starve the orchestration workers. |
| **Shared aggregates / read model** | Pre-computed study/site aggregates maintained incrementally. | CQRS; fed by change streams / events, not recomputed weekly. |
| **Report + Audit store** | Report lifecycle records + append-only audit. | Mongo for report docs; Postgres for relational/audit (Part 11). |
| **Notification worker** | Sends email via SES (secure link, **no PHI attachment**); records delivery; handles bounce/complaint. | Delivery plane, throttled to SES quota. |

---

## Sequence 1 — Subscribe

```mermaid
sequenceDiagram
  actor U as User
  participant API as Report API
  participant Auth as Auth0
  participant DB as Subscriptions (Mongo)
  U->>API: POST /report-subscriptions {schedule, scope, delivery}
  API->>Auth: validate JWT
  API->>API: authz — may user subscribe to this scope?
  API->>DB: upsert subscription (active=true)
  API-->>U: 201 {subscriptionId}
```

## Sequence 2 — Weekly generation (the core)

```mermaid
sequenceDiagram
  participant S as Scheduler (sharded tick)
  participant P as Planner
  participant Q as Report queue
  participant W as Report worker (durable)
  participant AGG as Aggregates/DB
  participant S3s as S3 source
  participant IMG as Image pool
  participant PDF as S3 (PDF+KMS)
  participant DB as Reports/Audit
  participant NQ as Notify queue

  S->>P: tick (shard = timezone/day/hour)
  P->>AGG: find subscriptions due in this shard
  loop batched enqueue
    P->>Q: report job {subId, period, idempotencyKey}
  end
  Q->>W: deliver job (at-least-once)
  W->>DB: create/lookup report by idempotencyKey
  alt already Ready
    W-->>Q: ack (skip — idempotent)
  else generate
    W->>AGG: read shared aggregate for scope+period
    W->>S3s: fetch source images/files
    W->>IMG: process images
    W->>W: render PDF
    W->>PDF: put object (KMS, immutable)
    W->>DB: status=Ready + audit(generated)
    W->>NQ: report.ready {reportId}
    W-->>Q: ack
  end
```

## Sequence 3 — Notify + secure download (no PHI in email)

```mermaid
sequenceDiagram
  participant NQ as Notify queue
  participant N as Notifier
  participant SES as Amazon SES
  actor U as User
  participant API as Report API
  participant PDF as S3 (PDF)
  participant DB as Reports/Audit

  NQ->>N: report.ready {reportId}
  N->>N: dedupe by reportId (effectively-once)
  N->>SES: email — "Your report is ready" + deep link (NO attachment)
  N->>DB: audit(delivered)
  U->>API: GET /reports/{id}/file (JWT)
  API->>API: authz — user owns report?
  API->>PDF: create pre-signed URL (TTL ~5 min)
  API->>DB: audit(accessed)
  API-->>U: 302 -> pre-signed URL
  U->>PDF: GET file
```

## Report job state machine

```mermaid
stateDiagram-v2
  [*] --> Queued
  Queued --> Processing
  Processing --> Rendering
  Rendering --> Ready
  Processing --> Failed
  Rendering --> Failed
  Failed --> Queued: retry (exp backoff, <= N)
  Failed --> DeadLetter: attempts exhausted
  Ready --> Delivered
  Delivered --> [*]
  DeadLetter --> Queued: manual/automated replay
```

**Why a state machine matters here:** in a regulated setting a silently stuck
report is a compliance problem, not just an ops annoyance. Persisting state per
step means we can *see* exactly where a report is stuck and *resume* it — the
same durable-execution argument I've made for long-running clinical journeys.

---

## Deployment / residency view (Florence angle)

```mermaid
flowchart TB
  subgraph Global["Global control plane"]
    G_API[Report API edge/auth]
    G_SUB[(Subscriptions)]
    G_SCH[Scheduler]
  end
  subgraph US["Region: US"]
    US_W[Workers + queues]
    US_PDF[(PDFs + reports + audit)]
    US_SRC[(Source data)]
  end
  subgraph EU["Region: EU / NHS"]
    EU_W[Workers + queues]
    EU_PDF[(PDFs + reports + audit)]
    EU_SRC[(Source data)]
  end
  G_SCH -->|route job to subscriber region| US_W
  G_SCH -->|route job to subscriber region| EU_W
  US_W --> US_SRC --> US_PDF
  EU_W --> EU_SRC --> EU_PDF
```

- **Global (small, non-PHI):** identity, subscription metadata, schedule.
- **Per-region (PHI):** source data, generation, PDFs, audit — data never
  crosses the boundary. This mirrors the region-split I owned previously:
  shared tooling/pipelines, isolated data planes.
