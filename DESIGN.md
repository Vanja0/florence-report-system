# Automated Report Feature — Design

My design for the weekly automated reporting feature. A scheduled job aggregates
tabular data (Mongo `Documents`) and files/images (S3), does heavy image
processing, renders a PDF, and emails it to subscribed users — at scale.

## How I looked at it

The important realization is that this isn't a request/response feature. It's a
scheduled, fan-out, compute-heavy batch pipeline with a delivery tail that
touches PHI. Everything in the design follows from that:

- The schedule, the compute, and the delivery are separate stages connected by
  queues, so they scale and fail independently.
- Every step is idempotent and resumable — at-least-once queues plus an
  idempotency key plus durable execution — so nothing gets silently stuck or
  sent twice.
- Fan-out is controlled: work is spread over time, aggregation is shared across
  users, and workers autoscale on queue depth so a weekly run doesn't stampede
  the database or the email quota.

## Architecture

![C4 system context](diagrams/C4%20system%20context%20diagram.png)

Users manage subscriptions through the API. An hourly scheduler enqueues a job
for every subscription that's due. Durable workers pick up jobs, read a
pre-computed aggregate, fetch and process images, render the PDF, store it in S3
(encrypted with KMS), and emit a `report.ready` event. A separate notification
worker emails a secure, time-limited link — never the PDF itself — and the user
downloads it after logging in.

Generation and storage are per-region (data residency); only subscription
metadata lives in the global control plane.

## The core flow — weekly generation

![Weekly generation sequence](diagrams/Sequence%20diagram%20Weekly%20generation.png)

The scheduler is just an hourly cron. Each subscription carries a `nextRunAt`
timestamp; the cron finds everything where `nextRunAt <= now`, enqueues one job
per report, and pushes `nextRunAt` forward by one interval. Because users span
days and timezones, each run only picks up its slice, so load spreads itself
without any explicit sharding.

Report generation itself is a durable workflow — one invocation per report,
keyed by `subscriptionId + period`. That key is also the idempotency key, so a
report for a given week can never be produced twice, even if a job is delivered
twice. Each step (aggregate ? fetch ? process images ? render ? store ? emit) is
checkpointed, so a crash or deploy resumes from the last completed step instead
of redoing minutes of image work.

The heavy image processing runs in its own autoscaled CPU/GPU pool, separate
from the orchestration workers — different resource profile, different scaling
signal, and it's the one place with real parallelism (images fan out and fan
back in before the render).

State per report is persisted, which matters because a silently stuck report is
a real problem, not just an annoyance — you can see exactly where it is and
resume or replay it:

![Report job state machine](diagrams/Report%20job%20state%20machine.png)

A report starts at `Queued` and only truly finishes at `Delivered`. Failures
retry with backoff up to N attempts; after that they go to a dead-letter state
that deliberately isn't terminal, so nothing dies quietly — it waits for replay.

## Sharing work across users (the main cost lever)

The naive version recomputes each user's aggregation from raw data every week —
that's O(users × history) and it's what melts the database and the budget at a
large user base.

Instead I keep shared study/site aggregates as a CQRS read model, updated
incrementally as source data lands (via change streams / domain events). The
weekly report becomes cheap assembly + personalization + render rather than a
full recompute, and processed images are cached by content hash so the same
image isn't reprocessed per subscriber. The tradeoff is eventual consistency
between the source and the read model, which is fine here since a report covers
a closed past week.

## Compute runtime — the decision I'd defend

The long job is minutes-long and image-heavy, so the runtime choice is the one
that matters most.

| Option | Why / why not |
|--------|----------------|
| All-Lambda + Step Functions | Scales to zero, fully managed, but the 15-min cap bites if every step is Lambda, and heavy image work is awkward in Lambda. Fine only for light, fast reports. |
| Step Functions orchestrating Lambda + ECS/Fargate | Managed orchestration (state, retries, fan-out) with no time cap — light glue steps in Lambda, the long CPU/GPU step as an ECS task. State stays in-region. |
| Container workers (ECS/Fargate or EKS) + durable engine (Restate/Temporal) | No time limit, right fit for image compute, autoscale on queue depth; per-step persistence gives resume-after-crash and good visibility of stuck reports. You operate more yourself. |
| Spark/EMR/Glue | Overkill — this is per-user PDF assembly, not massive analytics. |

What I'd propose: **container workers for the heavy compute, orchestrated by a
durable workflow engine.** Two reasonable shapes depending on how much you want
to operate:

- Managed: Step Functions orchestrating Lambda (glue) + ECS/Fargate (the heavy
  step). State lives in your AWS region, so residency is fine.
- Self-hosted: Restate or Temporal on EKS — pick this when you want one
  programming model and richer workflow state, or you already run the cluster.

The 15-min limit people associate with "serverless" only applies if every step
is a Lambda; Step Functions can mix Lambda and a long-running ECS task, which is
effectively the managed equivalent of a durable engine. The real residency
concern is a third-party SaaS engine holding state outside your boundary — not
Step Functions, which is in-region.

Other choices in brief: secure download link over PDF attachment (PHI never
leaves the boundary in email); SQS for the work queue (native DLQ + retry), with
Kafka as the event stream if these events feed other systems; build the PDF
renderer in-region rather than sending PHI to a reporting SaaS.

## API

Full contract is in [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1). I add two
resources — subscriptions and reports — and reuse the existing `/{id}/file`
download idiom.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/report-subscriptions` | Create a subscription |
| `GET` | `/api/report-subscriptions` | List subscriptions visible to the caller |
| `GET` | `/api/report-subscriptions/{id}` | Fetch one |
| `PATCH` | `/api/report-subscriptions/{id}` | Update mutable fields |
| `DELETE` | `/api/report-subscriptions/{id}` | Soft-delete (deactivate) |
| `GET` | `/api/reports` | List reports (filtered + paginated) |
| `GET` | `/api/reports/{id}` | Report metadata + status |
| `GET` | `/api/reports/{id}/file` | Download (302 ? pre-signed URL) |

A few things worth calling out:

- Generation is async — no endpoint blocks on building a PDF.
- Downloads are indirect: `/{id}/file` returns a 302 to a short-TTL pre-signed
  S3 URL after an authz check. The PDF is never served through the app tier and
  never emailed.
- `GET /api/reports` uses **keyset (cursor) pagination**, not offset. The
  collection is append-heavy (one report per subscriber per week); offset paging
  degrades on large skips and shifts rows when a new weekly run inserts mid-
  pagination. The cursor is anchored to `period.start` plus an `_id` tiebreaker,
  and the sort field matches the range field so one compound index serves filter,
  range, sort, and paging with no in-memory sort (Mongo's ESR rule).
- Idempotency keys on write endpoints so retries are safe.

## Data model

Full types (storage collections + async event payloads) are in
[`models/data-model.ts`](models/data-model.ts). Two main collections:

`report_subscriptions` — who wants what, on what schedule, and where it's
delivered. Carries `nextRunAt` (drives the scheduler) and `region`. Indexed
`{ active, nextRunAt }` for the due query.

`reports` — one generated instance: `subscriptionId`, `period {start,end}`,
`status`, `idempotencyKey` (unique — the dedup backbone), `fileLocation` (S3,
internal), integrity checksum, timings, and lifecycle timestamps. Indexed
`{ subscriptionId, status, "period.start": -1, _id: -1 }` to serve the list
endpoint without an in-memory sort.

There's also a shared aggregate read model keyed by scope + period (not by
subscription), so N subscribers to the same study share one rollup instead of
recomputing it N times.

## Assumptions

Large scale (~500k subscriptions, weekly); reports are personalized but share
common study/site aggregates; image-heavy jobs run minutes; PHI is present, so
delivery is a secure link; region is a hard boundary; AWS-native but the
transport is abstracted so Kafka can stand in for SQS.

Things I'd confirm before building: exact report volume and cadence, how big a
single report gets, the retention policy for generated PDFs, and who owns bounce
/ complaint handling for email.
