# Clarifying Questions & Documented Assumptions

> Staff-level scoping first. Jumping straight to boxes-and-arrows is a junior tell.
> This page is what I would send to Rastko before/while designing, and the
> assumptions I made so I could still produce a concrete design without blocking.

---

## 1. Clarifying questions I would ask

Grouped by what actually changes the design. The ones marked **?** are the
answers that most change the architecture.

### Product / scope of the report
- **? What is *in* the report?** Which tabular fields, which images, how much
  history? Is it per-user, per-study/trial, per-site, or per-sponsor scope?
- What does "subscribed user" mean — a user subscribes to a report *about a
  specific trial/site*, or one report covering everything they can access?
- Is the content the same for every subscriber, or personalised/filtered per
  user? (This is the single biggest cost driver — see "shared aggregation".)
- Can users configure the report (filters, sections, date range, language)?
- **? "Regular interval"** — weekly only, or arbitrary (daily/monthly)? What
  **timezone** anchors "weekly"? A fixed day/hour, or user-chosen?
- Do we need to **store** generated PDFs, and for how long? (Florence
  advertises archiving up to 25 years — retention is a product + compliance
  decision, not an afterthought.)

### Scale (the brief says "very large user base", "used heavily")
- **? Order of magnitude:** 10k, 100k, or millions of subscribers? How many
  reports per weekly run?
- Typical **data volume per report**: rows aggregated, number/size of images.
- **? How long does one report take**, dominated by which step (DB aggregation
  vs image processing vs PDF render)? This decides Lambda-vs-container-vs-durable.
- Delivery window: must all weekly reports go out within X hours of the tick?

### Compliance (this is Florence — regulated clinical trials)
- **? Can we email PHI/PII as a PDF attachment**, or must email be a
  notification + secure authenticated download link? (HIPAA/GxP strongly
  implies the latter — I assume link-based below.)
- **21 CFR Part 11 / GCP**: what audit trail is required for *generation* and
  *delivery* of a report (who, what, when, what data version)?
- **? Data residency**: must a US/EU/NHS subscriber's report be generated and
  stored *in-region*? (Florence sells into 90+ countries — I treat region as a
  first-class boundary.)
- Do reports need e-signature / immutability / versioning once issued?

### Existing system & platform
- Confirm stack: NestJS/Node, MongoDB (Documents) + Postgres, AWS, Auth0.
- Existing async backbone: **Kafka, RabbitMQ, or SQS/EventBridge**? (I'll design
  transport-agnostic and note the AWS-native mapping.)
- Existing email provider — **Amazon SES**, or SendGrid/other?
- Is there any existing aggregation/analytics/read-model infra, or is this net-new?
- Runtime we can deploy long-running workers on — **EKS/ECS** available, or is
  the org Lambda-first?

### Delivery guarantees & operations
- Hard requirement: **a report must never be emailed twice** — confirm, so I can
  justify the idempotency work.
- Should users be able to **regenerate / download past** reports on demand?
- Who owns bounce/complaint handling and unsubscribe (compliance + deliverability)?

---

## 2. Documented assumptions (so the design is concrete)

Where I didn't have an answer, I assumed the option that is both realistic for
Florence and forces good engineering. All are cheap to revisit.

| # | Assumption | Why / impact |
|---|------------|--------------|
| A1 | **Large scale**: ~500k active subscriptions, weekly cadence ? a peak of hundreds of thousands of reports per run. | Forces fan-out, backpressure, and schedule-spreading rather than a single cron job. |
| A2 | **Reports are personalised** (scoped to a user's studies/sites/filters), but many subscribers share the *same underlying* study aggregations. | Justifies a shared, incrementally-maintained aggregate (CQRS read model) + a cheap per-report assembly step. |
| A3 | **One report can take minutes** (image processing is the heavy part). | Rules out plain Lambda (15-min cap) for the heavy path; favours container workers and/or durable execution. |
| A4 | **PHI/PII is present.** Email is a *notification with a secure, authenticated, time-limited download link* — PDFs are **never** attached. | Compliance-driven; also removes email-size limits from the picture. |
| A5 | **21 CFR Part 11 applies**: every generate/deliver/access is audited to an append-only store. | Adds an audit plane; influences DB choice (Postgres for relational/audit). |
| A6 | **Region is a boundary**: report data is generated and stored in the subscriber's region; the control plane (subscriptions, schedule) can be global. | Matches Florence's residency reality and my prior region-split work. |
| A7 | **AWS-native building blocks** (EventBridge Scheduler, SQS, S3, SES, KMS, ECS/EKS), with the transport abstracted so Kafka can substitute for SQS. | Matches Florence's stack; keeps the design portable. |
| A8 | **At-least-once** transport + **idempotency keys** = effectively-once outcome. Exactly-once across email is not assumed to be free. | Sets realistic delivery semantics and the dedup design. |
| A9 | The existing `Documents` collection and document APIs **remain unchanged**; the report feature is additive and reuses the `GET /{id}/file` download pattern. | Minimises blast radius on the live product. |
| A10 | Weekly reports are **spread across the interval** (sharded by day/hour/timezone), not all fired at one instant. | Flattens the load peak on DB, workers, and SES sending quota. |
