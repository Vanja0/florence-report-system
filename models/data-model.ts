/**
 * Florence Automated Report feature ù data model (storage) + event payloads.
 *
 * This complements openapi.yaml (which is the HTTP contract). Types here describe what is stored
 * (MongoDB collections) and what flows on the async bus (SQS/Kafka) ù neither of
 * which OpenAPI is meant to express.
 *
 * Notes:
 * - `ObjectId`/`ISODate` are modelled as strings for readability; in code they'd
 *   be `mongoose.Types.ObjectId` / `Date`.
 * - Identity fields (`userId`, `orgId`, `region`) are derived from the JWT and
 *   are immutable once set.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type ObjectId = string;
export type ISODate = string; // e.g. "2026-09-14T05:12:03Z"
export type DateOnly = string; // e.g. "2026-09-07"

export type ReportStatus =
  | 'queued'
  | 'processing'
  | 'rendering'
  | 'ready'
  | 'failed';

export type Frequency = 'daily' | 'weekly' | 'monthly';

export type DayOfWeek = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';

/** The window a report covers. */
export interface Period {
  start: DateOnly;
  end: DateOnly;
}

/** When a subscription fires. Drives `nextRunAt` on the subscription. */
export interface Schedule {
  frequency: Frequency;
  dayOfWeek?: DayOfWeek; // for weekly
  hour?: number; // 0ù23, local to `timezone`
  timezone: string; // IANA, e.g. "Europe/Belgrade"
}

/** What data the report is scoped to (authorized against caller entitlements). */
export interface Scope {
  studyId?: string;
  siteId?: string;
  filters?: Record<string, unknown>;
}

export interface Delivery {
  channel: 'email';
  email: string; // must be a verified/allowlisted address
}

// ---------------------------------------------------------------------------
// Storage: MongoDB collections
// ---------------------------------------------------------------------------

/** Collection: report_subscriptions */
export interface ReportSubscription {
  _id: ObjectId;
  userId: string; // from JWT, immutable
  orgId: string; // from JWT, immutable
  reportType: string; // e.g. "weekly-site-summary"
  scope: Scope;
  schedule: Schedule;
  /** Next due time, computed from `schedule`. The hourly scheduler enqueues
   *  subscriptions where nextRunAt <= now, then advances it by one interval.
   *  Index { active, nextRunAt } makes the "due" query cheap. */
  nextRunAt: ISODate;
  delivery: Delivery;
  region: string; // residency boundary, immutable
  active: boolean; // soft-delete => false
  createdAt: ISODate;
  updatedAt: ISODate;
}

/**
 * Collection: reports (one generated instance).
 * Unique index on `idempotencyKey`; list index
 * { subscriptionId, status, "period.start": -1, _id: -1 }.
 */
export interface Report {
  _id: ObjectId;
  subscriptionId: ObjectId;
  userId: string;
  region: string;
  period: Period;
  idempotencyKey: string; // = hash(subscriptionId, period) ù UNIQUE, internal
  status: ReportStatus;
  attempts: number;
  fileLocation: string; // s3 bucket + key ù INTERNAL, never exposed via the API
  sizeBytes?: number;
  md5?: string; // integrity checksum of the PDF (prefer SHA-256)
  timings?: {
    aggregateMs?: number;
    imageMs?: number;
    renderMs?: number;
  };
  error?: string;
  createdAt: ISODate;
  readyAt?: ISODate;
  deliveredAt?: ISODate;
}

/** A reference to a source image (stored, not the bytes). */
export interface ImageRef {
  s3Key: string; // location in the SOURCE bucket
  kind?: string; // e.g. "scan", "chart-source"
  checksum?: string;
}

/**
 * Collection: report_aggregates (CQRS read model).
 *
 * A pre-computed, per-(scope, period) rollup that report workers read at render
 * time instead of re-scanning raw source data. SHARED across every subscription
 * with the same scope+period, so N subscribers to a study don't trigger N recomputes.
 *
 * Kept current by a projection off the write side (change stream / domain events).
 * Unique index on `aggregateKey`; secondary { "scope.studyId", "scope.siteId", "period.start": -1 }.
 */
export interface ReportAggregate {
  _id: ObjectId;
  aggregateKey: string; // = hash(scope, period) ù UNIQUE, the shared key
  scope: Scope; // studyId / siteId this rollup covers
  period: Period; // the window it summarizes
  region: string; // residency boundary

  /** Structured, render-ready data (tables, metrics). Shape is report-type specific. */
  metrics: Record<string, unknown>;

  /** References to source images to fetch + process at render time (NOT the bytes). */
  imageRefs: ImageRef[];

  // Projection bookkeeping ù incremental updates + freshness
  sourceCount: number; // how many source records folded in
  version: number; // bumped per incremental update (optimistic concurrency)
  lastSourceAt?: ISODate; // newest source record timestamp included
  status: 'building' | 'ready';
  computedAt: ISODate;
  updatedAt: ISODate;
}

// ---------------------------------------------------------------------------
// Async event payloads (SQS/Kafka) ù not part of the HTTP contract
// ---------------------------------------------------------------------------

/** report.requested ù Scheduler -> report workers */
export interface ReportRequested {
  subscriptionId: ObjectId;
  period: Period;
  idempotencyKey: string;
  region: string;
}

/** report.ready ù report worker -> notification worker */
export interface ReportReady {
  reportId: ObjectId;
  userId: string;
  fileLocation: string; // internal; consumers fetch via authorized API
}

/** report.failed ù report worker -> ops/alerting */
export interface ReportFailed {
  reportId: ObjectId;
  attempt: number;
  error: string;
}

/** report.delivered ù notification worker -> delivery status store */
export interface ReportDelivered {
  reportId: ObjectId;
  messageId: string; // SES message id
  deliveredAt: ISODate;
}

export type ReportEvent =
  | { type: 'report.requested'; payload: ReportRequested }
  | { type: 'report.ready'; payload: ReportReady }
  | { type: 'report.failed'; payload: ReportFailed }
  | { type: 'report.delivered'; payload: ReportDelivered };
