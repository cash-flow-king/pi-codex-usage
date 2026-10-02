/** Domain: shared refresh. Owns: quota file, leadership claims and SQLite mutex. Excludes: request transport and UI. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// --- Shared Refresh ---

/**
 * Cross-instance coordination for quota polling. Every Pi instance reads one
 * JSON file; a single "leader"
 * refreshes it every `LEADER_INTERVAL_MS`. Any other instance may take over once
 * the file is `TAKEOVER_AFTER_MS` old: it first claims leadership (owner and
 * timestamp) so nobody else is due, then fetches, then stamps the result. The
 * file is the only authority for requests and fenced publication. Writes are
 * atomic renames; short critical sections use an OS-backed SQLite mutex.
 */

export const LEADER_INTERVAL_MS = 60_000;
/** The leader is considered gone after missing its slot by 30 seconds. */
export const TAKEOVER_AFTER_MS = LEADER_INTERVAL_MS + 30_000;
/** Minimum pause between two fetch attempts of the same instance. */
export const MIN_ATTEMPT_GAP_MS = 60_000;

const STATE_FILE = "usage.json";
const LOCK_FILE = "mutex.sqlite";

export type SharedState<Report = unknown> = {
  report?: Report;
  /** When `report` was last fetched successfully. */
  updatedAt?: number;
  /**
   * When the leader last touched the file: written when it claims a refresh,
   * before fetching, and again when the fetch finishes.
   */
  claimedAt?: number;
  /** Instance id of the current leader (the last instance to claim). */
  owner?: string;
  /** Unique generation for this refresh, including renewals by the same owner. */
  claimId?: string;
  /** Last failure message; cleared by the next success. */
  error?: string;
  /** The failure means "no quota available" (n/a), not a runtime error. */
  unavailable?: boolean;
  failures?: number;
  /** No instance should fetch before this time. */
  retryNotBefore?: number;
};

export function readState<Report>(
  dir: string,
): SharedState<Report> | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(join(dir, STATE_FILE), "utf8"),
    ) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as SharedState<Report>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function writeState<Report>(
  dir: string,
  state: SharedState<Report>,
): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const temp = join(dir, `${STATE_FILE}.${process.pid}.tmp`);
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    renameSync(temp, join(dir, STATE_FILE));
    return true;
  } catch {
    return false;
  }
}

export type RefreshClaim = { owner: string; claimId: string };

export type RefreshOutcome<Report> =
  | { ok: true; report: Report }
  | {
      ok: false;
      error: string;
      unavailable?: boolean;
      rateLimited: boolean;
      retryAfterMs?: number;
    };

/** Read, decide and claim under the lock; never authorize an unwritten claim. */
export function claimRefresh(
  dir: string,
  owner: string,
  now?: number,
): RefreshClaim | undefined {
  const release = tryAcquireLock(dir);
  if (!release) return undefined;
  try {
    const current = readState(dir);
    const at = now ?? Date.now();
    if (!isRefreshDue(current, owner, at)) return undefined;
    const claim = { owner, claimId: randomUUID() };
    return writeState(dir, { ...current, ...claim, claimedAt: at })
      ? claim
      : undefined;
  } finally {
    release();
  }
}

function matchesClaim(
  state: SharedState | undefined,
  claim: RefreshClaim,
  now: number,
): boolean {
  return (
    state?.owner === claim.owner &&
    state.claimId === claim.claimId &&
    typeof state.claimedAt === "number" &&
    now - state.claimedAt < TAKEOVER_AFTER_MS
  );
}

/** Each admission check reads the file, not a remembered leadership flag. */
export function ownsRefreshClaim(
  dir: string,
  claim: RefreshClaim,
  now?: number,
): boolean {
  const current = readState(dir);
  return matchesClaim(current, claim, now ?? Date.now());
}

/** A late success OR failure must not overwrite a successor's state. */
export function publishRefresh<Report>(
  dir: string,
  claim: RefreshClaim,
  outcome: RefreshOutcome<Report>,
  now?: number,
): boolean {
  const release = tryAcquireLock(dir);
  if (!release) return false;
  try {
    const current = readState<Report>(dir);
    const at = now ?? Date.now();
    if (!matchesClaim(current, claim, at)) return false;
    if (outcome.ok) {
      return writeState(dir, {
        ...claim,
        claimedAt: at,
        updatedAt: at,
        report: outcome.report,
      });
    }
    const failures = (current?.failures ?? 0) + 1;
    return writeState(dir, {
      ...current,
      ...claim,
      claimedAt: at,
      error: outcome.error,
      unavailable: outcome.unavailable,
      failures,
      retryNotBefore: at + failureBackoffMs(failures, outcome),
    });
  } finally {
    release();
  }
}

/** Earliest time at which `owner` should try to refresh the state. */
export function nextRefreshAt(
  state: SharedState<unknown> | undefined,
  owner: string,
  now: number,
): number {
  const hold = state?.retryNotBefore ?? 0;
  const touchedAt = Math.max(
    state?.updatedAt ?? -Infinity,
    state?.claimedAt ?? -Infinity,
  );
  if (touchedAt === -Infinity) return Math.max(now, hold);
  const interval =
    state?.owner === owner ? LEADER_INTERVAL_MS : TAKEOVER_AFTER_MS;
  return Math.max(touchedAt + interval, hold);
}

export function isRefreshDue(
  state: SharedState<unknown> | undefined,
  owner: string,
  now: number,
): boolean {
  return nextRefreshAt(state, owner, now) <= now;
}

/** Exponential failure backoff; HTTP 429 gets a longer base and cap. */
export function failureBackoffMs(
  failures: number,
  options: { rateLimited: boolean; retryAfterMs?: number },
): number {
  const base = options.rateLimited ? 5 * 60_000 : 60_000;
  const cap = options.rateLimited ? 30 * 60_000 : 5 * 60_000;
  const exponential = Math.min(cap, base * 2 ** Math.max(0, failures - 1));
  return Math.max(options.retryAfterMs ?? 0, exponential);
}

/**
 * An empty SQLite transaction is a non-waiting, OS-backed mutex, not storage
 * for quota or leadership. Close or process death releases it; a paused live
 * holder cannot be evicted. Never unlink/replace mutex.sqlite while in use.
 */
export function tryAcquireLock(dir: string): (() => void) | undefined {
  let database: DatabaseSync | undefined;
  try {
    mkdirSync(dir, { recursive: true });
    database = new DatabaseSync(join(dir, LOCK_FILE));
    // Contention must not wait on Pi's TUI thread; PRAGMA also works on Node 22.
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
  } catch {
    database?.close();
    return undefined;
  }
  return () => {
    const held = database;
    database = undefined;
    held?.close();
  };
}
