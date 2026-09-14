# APIs & Data Model

The brief asks to **"define or amend the APIs involved."** The existing document
APIs are unchanged; I add two new resources — **subscriptions** and **reports** —
and deliberately reuse the existing `GET /{id}/file` download idiom for
consistency.

## Design choices
- **Report generation is async.** No endpoint blocks on generating a PDF.
  On-demand generation returns `202 Accepted` + a report id to poll or subscribe to.
- **Downloads are indirect + audited.** `GET /reports/{id}/file` returns a
  `302` to a short-TTL pre-signed S3 URL after authz; the PDF is never served
  through the app tier and never emailed.
- **Soft-delete for compliance.** Subscriptions are deactivated, not hard-deleted,
  so the audit trail survives.
- **Idempotency keys** on write/generate endpoints to make retries safe.

---

## New API — Subscriptions

### `POST /api/report-subscriptions`
Create a subscription.
```jsonc
// request
{
  "reportType": "weekly-site-summary",
  "scope": { "studyId": "S-123", "siteId": "SITE-9", "filters": {} },
  "schedule": { "frequency": "weekly", "dayOfWeek": "MON", "hour": 7, "timezone": "Europe/Belgrade" },
  "delivery": { "channel": "email", "email": "user@site.org" }
}
// 201
{ "id": "sub_abc", "status": "active" }
```

### `GET /api/report-subscriptions?userId=&studyId=`
List subscriptions the caller may see.

### `GET /api/report-subscriptions/{id}`
Fetch one subscription.

### `PATCH /api/report-subscriptions/{id}`
Update schedule/scope/delivery/active. (Same "any property except immutable ids"
rule as the existing `PATCH /documents/{id}`.)

### `DELETE /api/report-subscriptions/{id}`
Soft-delete ? `active=false`, retained for audit.

---

## New API — Reports (generated instances)

### `GET /api/reports?subscriptionId=&status=&period=`
List generated reports (paginated).

### `GET /api/reports/{id}`
Report metadata + lifecycle status.
```jsonc
{
  "id": "rep_789",
  "subscriptionId": "sub_abc",
  "period": { "start": "2026-09-07", "end": "2026-09-13" },
  "status": "ready",          // queued | processing | rendering | ready | failed
  "sizeBytes": 254118,
  "md5": "…",
  "readyAt": "2026-09-14T05:12:03Z",
  "deliveredAt": "2026-09-14T05:12:20Z"
}
```

### `GET /api/reports/{id}/file`
Authenticated download. Authorizes, writes an audit event, returns `302` to a
short-lived pre-signed S3 URL. **This is the link emailed to users** (behind auth).

### `POST /api/reports:generate` (on-demand / admin regenerate)
```jsonc
// request
{ "subscriptionId": "sub_abc", "period": { "start": "2026-09-07", "end": "2026-09-13" } }
// 202
{ "reportId": "rep_790", "status": "queued" }
```
Header `Idempotency-Key: <uuid>` ? duplicate submits return the same `reportId`.

---

## Internal / event contracts

Async events (SQS/Kafka). Names are stable contracts; payloads are versioned.

| Event | Emitted by | Consumed by | Key fields |
|-------|-----------|-------------|-----------|
| `report.requested` | Planner / on-demand API | Report workers | `subscriptionId`, `period`, `idempotencyKey`, `region` |
| `report.ready` | Report worker | Notification worker | `reportId`, `userId`, `fileLocation` |
| `report.failed` | Report worker | Ops/alerting | `reportId`, `attempt`, `error` |
| `report.delivered` | Notification worker | Audit | `reportId`, `messageId`, `deliveredAt` |

### `POST /internal/ses-events` (SNS webhook)
Receives SES bounce/complaint/delivery notifications ? updates delivery status,
maintains a suppression list, and audits. Not public.

---

## Data model

### `report_subscriptions` (MongoDB)
```jsonc
{
  "_id": ObjectId,
  "userId": String,
  "orgId": String,
  "reportType": String,
  "scope": { "studyId": String, "siteId": String, "filters": Object },
  "schedule": { "frequency": String, "dayOfWeek": String, "hour": Number, "timezone": String },
  "delivery": { "channel": "email", "email": String },
  "region": String,            // residency boundary
  "active": Boolean,
  "createdAt": Date, "updatedAt": Date
}
```
Indexes: `{ active, "schedule.dayOfWeek", "schedule.hour" }` (planner enumeration),
`{ userId }`, `{ orgId, "scope.studyId" }`.

### `reports` (MongoDB)
```jsonc
{
  "_id": ObjectId,
  "subscriptionId": ObjectId,
  "userId": String,
  "region": String,
  "period": { "start": Date, "end": Date },
  "idempotencyKey": String,    // = hash(subscriptionId, period)  — UNIQUE
  "status": String,            // queued|processing|rendering|ready|failed
  "attempts": Number,
  "fileLocation": String,      // s3 bucket + key (reuses Documents convention)
  "sizeBytes": Number,
  "md5": String,               // reuses Documents' integrity field
  "timings": { "aggregateMs": Number, "imageMs": Number, "renderMs": Number },
  "error": String,
  "createdAt": Date, "readyAt": Date, "deliveredAt": Date
}
```
Unique index on `idempotencyKey` ? the dedup backbone (safe retries, no double report).

### `audit_events` (Postgres — append-only)
```sql
CREATE TABLE audit_events (
  id           BIGSERIAL PRIMARY KEY,
  actor        TEXT NOT NULL,          -- user id / system component
  action       TEXT NOT NULL,          -- generated | delivered | accessed | failed
  resource     TEXT NOT NULL,          -- 'report'
  resource_id  TEXT NOT NULL,
  region       TEXT NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata     JSONB
);
-- append-only: no UPDATE/DELETE grants; partitioned by month for retention.
```

**Mongo vs Postgres split (a question they may probe):** documents/report
records live in Mongo (flexible, matches the existing `Documents` collection);
the **audit trail lives in Postgres** because it is relational, append-only, and
needs the transactional/reporting guarantees that 21 CFR Part 11 review expects.
