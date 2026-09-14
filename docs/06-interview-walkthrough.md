# Walkthrough Script & Q&A Prep

The brief says: *"Be prepared to walk us through and explain the approach."*
This is your spoken script + the follow-ups they'll throw. Structure every answer
**problem ? decision ? tradeoff ? outcome**.

---

## The 2-minute opening (say this first)

> "Before designing I'd want to confirm a few things — scale (how many
> subscribers), what's actually in the report, whether PHI is involved, and the
> residency/audit requirements — because those change the architecture. I've
> written those down as assumptions so I could produce something concrete.
>
> The key insight is that this isn't a request/response feature. It's a
> **scheduled, fan-out, long-running, compute-heavy batch pipeline** with a
> compliance-sensitive delivery tail. So the whole design is about three things:
> **decoupling** the schedule from the compute from the delivery; making every
> step **idempotent and resumable** so nothing gets silently stuck or
> double-sent; and controlling the **fan-out** so a weekly tick doesn't stampede
> the database and the email quota.
>
> I split it into four planes — control, compute, delivery, and audit — each with
> its own scaling and failure profile."

Then walk the **component diagram** (docs/02) left to right, then the **weekly
generation sequence**.

## The 5-line summary of the flow

1. Users subscribe via the API ? subscription store.
2. A **sharded scheduler** ticks; a **planner** enumerates due subscriptions and
   enqueues one idempotent job per report.
3. **Durable workers** aggregate (from a pre-computed read model) ? fetch/process
   images ? render PDF ? store in S3 (KMS) ? write status + audit ? emit `report.ready`.
4. A **notification worker** emails a **secure link** (never the PHI PDF) via SES.
5. The user authenticates and downloads via a **short-TTL pre-signed URL**, and
   the access is audited.

---

## The 5 decisions to lead with (your strongest signals)

1. **Decouple with a queue + fan-out** — schedule ? compute ? delivery.
2. **Durable execution for the long job** — resumable, no stuck reports, no
   double-sends. *(Tie to your self-hosted Restate/EKS work.)*
3. **CQRS / shared incremental aggregates** — compute the expensive thing once,
   assemble per report. *(Tie to your Mongo change-streams ? read store work.)*
4. **Secure link, not PHI attachment** — compliance-first delivery.
5. **Region as a first-class boundary** — per-region generation/storage/audit.
   *(Tie to your NHS data-residency region split.)*

---

## Anticipated follow-ups (with crisp answers)

**"How do you guarantee a report isn't sent twice?"**
At-least-once transport + an idempotency key `hash(subscriptionId, period)` with a
unique index on the reports collection, plus email dedup on reportId. That gives
effectively-once outcomes — I won't claim exactly-once on the wire, I make the
side effects idempotent instead.

**"A worker dies halfway through image processing — what happens?"**
Durable execution persists each completed step, so it resumes from the last one,
not from scratch. The idempotency key means no duplicate report or email even if
the whole job is retried.

**"'Very large user base' — how does this not fall over on the weekly run?"**
Three levers: shard the schedule across the week so peak ? average; maintain
shared study aggregates incrementally so the run is assembly not recompute; and
autoscale workers on queue depth with the queue as backpressure. Plus a
content-hash cache so a shared image is processed once, not per subscriber.

**"Why not just do it in Lambda?"**
Fine for light reports, but I assumed minutes-long, image-heavy jobs that blow the
15-minute cap. Container workers have no time limit and suit CPU/GPU work; I
orchestrate them with durable execution for resumability. Step Functions is the
managed alternative — though a managed engine can hold state outside the region
boundary, which matters for residency here.

**"Can we email the PDF directly?"**
Not with PHI. I email a notification with an authenticated, time-limited link.
That keeps PHI inside the boundary, gives me per-access audit, and lets me revoke
access — all of which a regulator will ask about.

**"How do you handle SES throttling / bounces?"**
Delivery is a separate throttled plane sized to the SES quota; the queue absorbs
bursts. Bounces/complaints come back via SNS, feed a suppression list, and are
audited — so even a non-delivery is on the record.

**"Mongo or Postgres for this?"**
Report/subscription records in Mongo (matches the existing Documents collection
and flexible shapes); the audit trail in Postgres because it's relational,
append-only, and needs the guarantees a Part 11 review expects.

**"How would you migrate/roll this out safely?"**
Feature-flagged, dark-launched to internal users first, expand-contract for any
schema change so a blue/green cutover stays backward-compatible — the same
approach I've used for live migrations without blocking other teams.

**"Where would Kafka fit vs SQS?"**
SQS for the work queue (native DLQ + visibility-timeout retries). Kafka for the
`report.*` event log if other consumers (e.g. operational intelligence) want to
replay it. I've run RabbitMQ/SQS in anger; Kafka's the same model, I'd ramp fast.

---

## Things to say that signal "Staff"

- "I scoped before I designed" (the questions page).
- "Here's the tradeoff, and here's when I'd choose differently" (every decision).
- "This must not block other teams shipping" (rollout).
- "In a regulated setting a stuck report is a compliance problem, not an ops
  annoyance" (why durable + audit).
- "I'd compute the expensive thing once" (cost awareness at scale).

## Domain vocabulary to weave in (learn the nouns)
site, sponsor/CRO, study/trial, ISF/eISF (eBinders), TMF/eTMF, 21 CFR Part 11,
GCP, inspection-readiness. Map to your diagnostics experience: same constraints
(auditability, residency, retries that must not double-process), different nouns.

## Time tracking (they asked for this)
Keep a note like: *"~Xh: ~30m scoping/assumptions, ~2h architecture + diagrams,
~1h APIs/data model + alternatives, ~30m write-up."* Put the real number in the
submission message — they explicitly ask how long it took.
