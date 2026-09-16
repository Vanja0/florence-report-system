# APIs & Data Model

The brief asks to **"define or amend the APIs involved."** The existing document
APIs are unchanged; I add two new resources ù **subscriptions** and **reports** ù
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

## New API ù Subscriptions

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

## New API ù Reports (generated instances)

### `GET /api/reports`
List generated reports. **Filters** select *which* reports; **pagination**
controls *how many* are returned per call. The two are orthogonal.

**Filters (the `WHERE`)**

| Param | Meaning | Result |
|-------|---------|--------|
| `subscriptionId` | Reports for one subscription | narrows |
| `status` | `queued` \| `processing` \| `rendering` \| `ready` \| `failed` | narrows |
| `periodFrom` / `periodTo` | Date range (ISO dates). Match semantics: return reports whose `period.start` falls within `[periodFrom, periodTo]`. | many -> paginate |

> There is **one** way to filter by date: the `periodFrom`/`periodTo` range.
> A single week is just both bounds set to that week
> (`periodFrom=2026-09-07&periodTo=2026-09-13`). To fetch a report you already
> know, use `GET /api/reports/{id}` -- no date filtering needed. We deliberately
> avoid a bare `period=2026-09-07`, because the stored period is a `{start,end}`
> window and a single loose date would be ambiguous.

**Pagination (cursor / keyset ù not offset)**

| Param | Meaning |
|-------|---------|
| `limit` | Page size (default 20, server-capped e.g. 100) |
| `cursor` | Opaque token = sort key of the last item seen; omit on first page |

```jsonc
// GET /api/reports?subscriptionId=sub_abc&status=ready&limit=20
{
  "data": [ /* up to 20 reports, ordered by period covered (newest week first) */ ],
  "pagination": {
    "limit": 20,
    "hasMore": true,
    // opaque; decodes to { "period.start": "2026-08-31", "id": "rep_882" }
    "nextCursor": "eyJwZXJpb2Quc3RhcnQiOiIyMDI2LTA4LTMxIiwiaWQiOiJyZXBfODgyIn0="
  }
}
```

The `nextCursor` decodes to the last row's sort key **plus an `_id` tiebreaker**
(e.g. `{ "period.start": "2026-08-31", "id": "rep_882" }`). Results are ordered
by `period.start` (which week the report covers), backed by a compound index:

```js
db.reports.createIndex({ subscriptionId: 1, status: 1, "period.start": -1, _id: -1 })
```

so every page is a constant-time index seek.

**Sort on the same field you range on (ESR).** The date filter is a *range* on
`period.start`, so we also *sort and cursor* on `period.start` ù not on a
different field like `readyAt`. Mongo's ESR rule (Equality ? Sort ? Range) means
that if the range field and sort field differ, the index can't serve both and
Mongo does an in-memory `SORT` stage that degrades on large result sets (and
hits the 32 MB sort limit). Because the index is physically ordered by
`period.start`, a range scan on it comes out already sorted ù filter, range,
sort, and pagination are all served by the one index, no `SORT` stage.
`readyAt` and `period.start` are near-perfectly correlated for weekly reports,
so ordering by `period.start` is also what the user expects. Verify with
`explain()`: expect an `IXSCAN` and **no** `SORT`.

**Why keyset, not `?page=N&offset=`:** the reports collection is append-heavy
(one report per subscriber per week). Offset paging (a) degrades with large
`skip()` scans and (b) shifts rows when a weekly run inserts new reports
mid-pagination, causing duplicates/skips. Keyset is anchored to a stable key, so
neither happens.

**Examples:**
```
GET /api/reports/{id}                                              # one known report, no filters
GET /api/reports?subscriptionId=sub_abc&periodFrom=2026-09-07&periodTo=2026-09-13   # one week
GET /api/reports?subscriptionId=sub_abc&periodFrom=2026-07-01&periodTo=2026-09-30&limit=20  # a quarter, paginated
```

### `GET /api/reports/{id}`
Report metadata + lifecycle status.
```jsonc
{
  "id": "rep_789",
  "subscriptionId": "sub_abc",
  "period": { "start": "2026-09-07", "end": "2026-09-13" },
  "status": "ready",          // queued | processing | rendering | ready | failed
  "sizeBytes": 254118,
  "md5": "ù",
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
  "idempotencyKey": String,    // = hash(subscriptionId, period)  ù UNIQUE
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
Indexes:
- Unique index on `idempotencyKey` ó the dedup backbone (safe retries, no double report).
- `{ subscriptionId: 1, status: 1, "period.start": -1, _id: -1 }` ó serves the
  `GET /api/reports` list: equality on `subscriptionId`/`status`, range on
  `period.start`, and sort/keyset-pagination on `period.start` from the one
  index (ESR-aligned, no in-memory `SORT`).

### `audit_events` (Postgres ù append-only)
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
