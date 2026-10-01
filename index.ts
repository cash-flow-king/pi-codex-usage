import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_USAGE_EXTENSION_ID = "@llblab/pi-codex-usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_TIMEOUT_MS = 15_000;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const HOUR_TENTH_MS = 6 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DAY_TENTH_MS = 144 * MINUTE_MS;
/** How often an instance re-reads the shared file to redraw fresh data. */
const MAX_TICK_MS = 30 * SECOND_MS;
const MIN_TICK_MS = SECOND_MS;
const TAKEOVER_JITTER_MS = 2 * SECOND_MS;
/** A report older than this is no longer shown as current. */
const STALE_REPORT_MAX_AGE_MS = HOUR_MS;
const PROVISIONAL_RETRY_MS = SECOND_MS;
const FULL_AVAILABILITY_CONFIRMATION_MS = 15 * SECOND_MS;
const LOADING_FRAME_MS = 30;
const REDRAW_BLINK_MS = 150;
const STATUS_KEY = "aa-codex-usage";
const MAX_ERROR_BODY_CHARS = 600;
const DEFAULT_STATUS_LABEL_TEXT = "codex";
const CODEX_USAGE_LIMIT_ID = "codex";
const DUAL_BAR_WIDTH = 10;
const TELEGRAM_STATUS_IMPORT_SPECIFIERS = [
  "@llblab/pi-telegram/status",
  new URL("../pi-telegram/api/status.ts", import.meta.url).href,
];
const DUAL_BAR_CHARS = [
  "⠀",
  "▘",
  "▝",
  "▀",
  "▖",
  "▌",
  "▞",
  "▛",
  "▗",
  "▚",
  "▐",
  "▜",
  "▄",
  "▙",
  "▟",
  "█",
];

type UsageSource = "pi-auth" | "codex-app-server";
type TimeoutHandle = ReturnType<typeof setTimeout> & { unref?: () => void };
type PiModel = NonNullable<ExtensionContext["model"]>;
export type CodexUsageModel = Pick<PiModel, "id" | "name" | "provider">;
type CodexUsageTelegramStatusModel = Pick<PiModel, "id" | "name" | "provider">;
type TelegramStatusLineProviderResult =
  { label: string; value: string } | undefined;
type TelegramStatusLineProvider = (ctx: {
  activeModel?: CodexUsageTelegramStatusModel;
}) => TelegramStatusLineProviderResult;
type TelegramStatusLineModule = {
  registerTelegramStatusLineProvider?: (
    provider: TelegramStatusLineProvider,
    options: { id: string },
  ) => () => void;
};

type QueryUsageOptions = {
  timeoutMs: number;
};

type QueryUsageResult =
  | { ok: true; report: CodexUsageReport }
  | { ok: false; errors: UsageQueryError[] };

type CodexSharedState = SharedState<CodexUsageReport>;

export type UsageQueryError = {
  source: UsageSource;
  message: string;
  cause?: unknown;
};

export type CodexUsageReport = {
  snapshots: NormalizedRateLimitSnapshot[];
  credits?: NormalizedCreditUsage;
};

export type NormalizedCreditUsage = {
  remainingPercent: number;
  resetAt?: number;
};

export type NormalizedRateLimitSnapshot = {
  limitId: string;
  primary?: NormalizedRateLimitWindow;
  secondary?: NormalizedRateLimitWindow;
};

export type NormalizedRateLimitWindow = {
  usedPercent: number;
  resetAt?: number;
};

type RateLimitStatusPayload = {
  rate_limit?: unknown;
  additional_rate_limits?: unknown;
  credits?: unknown;
  spend_control?: unknown;
};

type BackendRateLimitDetails = {
  primary_window?: unknown;
  secondary_window?: unknown;
};

type BackendWindowSnapshot = {
  used_percent?: unknown;
  reset_at?: unknown;
  resets_at?: unknown;
  reset_time?: unknown;
  end_time?: unknown;
  ends_at?: unknown;
  expires_at?: unknown;
  reset_after_seconds?: unknown;
};

type AppServerRateLimitResponse = {
  rateLimits?: unknown;
};

type AppServerRateLimitSnapshot = {
  limitId?: unknown;
  primary?: unknown;
  secondary?: unknown;
};

type AppServerWindowSnapshot = {
  usedPercent?: unknown;
  resetAt?: unknown;
  resetsAt?: unknown;
  resetTime?: unknown;
  endTime?: unknown;
  endsAt?: unknown;
  expiresAt?: unknown;
  resetAfterSeconds?: unknown;
};

type RpcResponse = {
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown; code?: unknown };
};

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

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

export default function codexUsage(pi: ExtensionAPI) {
  const instanceId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const stateDir = join(getAgentDir(), "tmp", "pi-codex-usage");
  let lastAttemptAt = 0;
  let inFlightRefresh: Promise<void> | undefined;
  let shown: { key?: string; report?: CodexUsageReport; updatedAt?: number } = {};
  let statuslineBlinkTimer: TimeoutHandle | undefined;
  let statuslineCountdownTimer: TimeoutHandle | undefined;
  let statuslineLoadingTimer: TimeoutHandle | undefined;
  let statuslineRefreshTimer: TimeoutHandle | undefined;
  let statuslineLoadingFrame = 0;
  let statuslineRequestId = 0;
  let unregisterTelegramStatusLine: (() => void) | undefined;
  let telegramStatusLineRegistration: Promise<void> | undefined;

  const loadState = () => readState<CodexUsageReport>(stateDir);

  const ensureTelegramStatusLineRegistered = () => {
    if (unregisterTelegramStatusLine || telegramStatusLineRegistration) return;
    telegramStatusLineRegistration = registerCodexUsageTelegramStatusLine(
      ({ activeModel }) => {
        if (!isOpenAICodexModel(activeModel)) return undefined;
        if (!shown.report) return undefined;
        const value = formatCodexUsageStatusValue(shown.report, activeModel);
        return value
          ? { label: DEFAULT_STATUS_LABEL_TEXT, value }
          : undefined;
      },
    )
      .then((unregister) => {
        unregisterTelegramStatusLine = unregister;
      })
      .finally(() => {
        telegramStatusLineRegistration = undefined;
      });
  };

  const clearStatuslineTimers = () => {
    if (statuslineBlinkTimer) clearTimeout(statuslineBlinkTimer);
    if (statuslineCountdownTimer) clearTimeout(statuslineCountdownTimer);
    if (statuslineLoadingTimer) clearTimeout(statuslineLoadingTimer);
    if (statuslineRefreshTimer) clearTimeout(statuslineRefreshTimer);
    statuslineBlinkTimer = undefined;
    statuslineCountdownTimer = undefined;
    statuslineLoadingTimer = undefined;
    statuslineRefreshTimer = undefined;
  };

  const stopStatuslineLoading = () => {
    if (statuslineLoadingTimer) clearTimeout(statuslineLoadingTimer);
    statuslineLoadingTimer = undefined;
  };

  const startStatuslineLoading = (
    ctx: ExtensionContext,
    model: CodexUsageModel | undefined,
  ) => {
    if (statuslineLoadingTimer) return;
    statuslineLoadingFrame = Math.random() < 0.5 ? 0 : DUAL_BAR_WIDTH * 2 - 1;
    const drawNextFrame = () => {
      try {
        ctx.ui.setStatus(
          STATUS_KEY,
          formatStatuslineLoading(ctx, statuslineLoadingFrame, model),
        );
        statuslineLoadingFrame += 1;
        statuslineLoadingTimer = setTimeout(
          drawNextFrame,
          LOADING_FRAME_MS,
        ) as TimeoutHandle;
        statuslineLoadingTimer.unref?.();
      } catch (error) {
        statuslineLoadingTimer = undefined;
        handleTimerError(error);
      }
    };
    drawNextFrame();
  };

  const clearUsageStatusline = (ctx: ExtensionContext) => {
    statuslineRequestId += 1;
    clearStatuslineTimers();
    shown = {};
    ctx.ui.setStatus(STATUS_KEY, undefined);
  };

  const scheduleStatuslineRefresh = (ctx: ExtensionContext, delayMs: number) => {
    if (statuslineRefreshTimer) clearTimeout(statuslineRefreshTimer);
    statuslineRefreshTimer = setTimeout(() => {
      void refreshCurrentCodexUsageStatusline(ctx, false).catch(
        handleAsyncTimerError,
      );
    }, delayMs) as TimeoutHandle;
    statuslineRefreshTimer.unref?.();
  };

  const scheduleStatuslineCountdown = (
    ctx: ExtensionContext,
    report: CodexUsageReport,
    model: CodexUsageModel | undefined,
  ) => {
    if (statuslineCountdownTimer) clearTimeout(statuslineCountdownTimer);
    const delayMs = nextResetCountdownDelayMs(report, Date.now(), model);
    if (delayMs === undefined) {
      statuslineCountdownTimer = undefined;
      return;
    }
    statuslineCountdownTimer = setTimeout(() => {
      try {
        if (isOpenAICodexModel(ctx.model)) {
          ctx.ui.setStatus(
            STATUS_KEY,
            formatCodexUsageStatusline(report, ctx, model),
          );
          scheduleStatuslineCountdown(ctx, report, model);
        }
      } catch (error) {
        handleTimerError(error);
      }
    }, delayMs) as TimeoutHandle;
    statuslineCountdownTimer.unref?.();
  };

  const setUsageStatusline = (
    ctx: ExtensionContext,
    report: CodexUsageReport,
    options: { blink: boolean; model: CodexUsageModel | undefined },
  ) => {
    if (statuslineBlinkTimer) clearTimeout(statuslineBlinkTimer);
    if (statuslineCountdownTimer) clearTimeout(statuslineCountdownTimer);
    stopStatuslineLoading();
    statuslineBlinkTimer = undefined;
    statuslineCountdownTimer = undefined;
    const text = formatCodexUsageStatusline(report, ctx, options.model);
    if (options.blink) {
      ctx.ui.setStatus(
        STATUS_KEY,
        formatStatuslineLoading(ctx, statuslineLoadingFrame, options.model),
      );
      statuslineBlinkTimer = setTimeout(() => {
        try {
          ctx.ui.setStatus(STATUS_KEY, text);
          scheduleStatuslineCountdown(ctx, report, options.model);
          statuslineBlinkTimer = undefined;
        } catch (error) {
          handleTimerError(error);
        }
      }, REDRAW_BLINK_MS) as TimeoutHandle;
      statuslineBlinkTimer.unref?.();
    } else {
      ctx.ui.setStatus(STATUS_KEY, text);
      scheduleStatuslineCountdown(ctx, report, options.model);
    }
  };

  /** Draws the shared state; skips redraws when nothing changed. */
  const renderState = (
    ctx: ExtensionContext,
    state: CodexSharedState | undefined,
    model: CodexUsageModel | undefined,
    force: boolean,
  ) => {
    // Cached display data is not permission to query when the file is unreadable.
    if (!state && shown.report && Date.now() - (shown.updatedAt ?? 0) < STALE_REPORT_MAX_AGE_MS) {
      if (force) setUsageStatusline(ctx, shown.report, { blink: false, model });
      return;
    }
    const usable =
      state?.report &&
      state.updatedAt !== undefined &&
      Date.now() - state.updatedAt < STALE_REPORT_MAX_AGE_MS &&
      canReuseCachedReport(state.report, model)
        ? state.report
        : undefined;
    if (usable) {
      const key = `report:${state?.updatedAt}`;
      if (!force && shown.key === key) return;
      const blink = shown.report
        ? formatReportBar(shown.report, model) !== formatReportBar(usable, model)
        : false;
      shown = { key, report: usable, updatedAt: state?.updatedAt };
      setUsageStatusline(ctx, usable, { blink, model });
    } else if (state?.error) {
      const key = `error:${state.error}`;
      if (!force && shown.key === key) return;
      shown = { key };
      clearStatuslineTimers();
      ctx.ui.setStatus(
        STATUS_KEY,
        formatStatuslineProblem(ctx, state.unavailable === true, model),
      );
    } else {
      shown = { key: "loading" };
      startStatuslineLoading(ctx, model);
    }
  };

  /**
   * When this instance is due (leader after 1 minute, anyone after 90 seconds) it
   * claims leadership under the lock (owner and timestamp, so no other
   * instance is due), then fetches, then stamps the outcome. Failures are
   * published with a backoff so other instances do not pile on.
   */
  const refreshSharedState = (
    ctx: ExtensionContext,
    model: CodexUsageModel | undefined,
  ) => {
    if (inFlightRefresh) return inFlightRefresh;
    const promise = (async () => {
      const claim = claimRefresh(stateDir, instanceId);
      if (!claim) return;
      lastAttemptAt = Date.now();
      const result = await queryConfirmedUsage(
        ctx,
        model,
        loadState()?.report,
        () => ownsRefreshClaim(stateDir, claim),
      );
      if (!result) return;
      if (result.ok) {
        publishRefresh(stateDir, claim, result);
        return;
      }
      if (result.errors.some((error) => isStaleExtensionContextError(error.cause)))
        return;
      publishRefresh(stateDir, claim, {
        ok: false,
        error: result.errors.map((error) => error.message).join("; "),
        unavailable: isUsageUnavailable(result.errors),
        rateLimited: result.errors.some((error) =>
          error.message.includes("returned 429"),
        ),
      });
    })().finally(() => {
      if (inFlightRefresh === promise) inFlightRefresh = undefined;
    });
    inFlightRefresh = promise;
    return promise;
  };

  /**
   * Queries the usage. A first report claiming every window is completely
   * unused is provisional (providers can briefly emit zeroed windows while
   * initializing), so the claiming leader re-queries it every second for up to
   * 15 seconds before publishing.
   */
  const queryConfirmedUsage = async (
    ctx: ExtensionContext,
    model: CodexUsageModel | undefined,
    previous: CodexUsageReport | undefined,
    mayQuery: () => boolean,
  ): Promise<QueryUsageResult | undefined> => {
    const startedAt = Date.now();
    let result = await queryUsage(
      ctx,
      { timeoutMs: DEFAULT_TIMEOUT_MS },
      model,
      mayQuery,
    );
    if (previous && isFullyAvailableReport(previous, model)) return result;
    while (
      result?.ok &&
      isFullyAvailableReport(result.report, model) &&
      Date.now() - startedAt < FULL_AVAILABILITY_CONFIRMATION_MS
    ) {
      await new Promise((resolve) => setTimeout(resolve, PROVISIONAL_RETRY_MS));
      const retry = await queryUsage(
        ctx,
        { timeoutMs: DEFAULT_TIMEOUT_MS },
        model,
        mayQuery,
      );
      if (!retry) return undefined;
      if (!retry.ok) break;
      result = retry;
    }
    return result;
  };

  const nextTickDelayMs = (state: CodexSharedState | undefined) => {
    // Nothing to show yet (e.g. a claimed fetch is in flight): poll quickly.
    if (shown.key === "loading") return MIN_TICK_MS;
    const now = Date.now();
    const dueAt = Math.max(
      nextRefreshAt(state, instanceId, now),
      lastAttemptAt + MIN_ATTEMPT_GAP_MS,
    );
    const jitter =
      state?.owner === instanceId ? 0 : Math.random() * TAKEOVER_JITTER_MS;
    return Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, dueAt - now + jitter));
  };

  const refreshCurrentCodexUsageStatusline = async (
    ctx: ExtensionContext,
    forceRender: boolean,
    model?: CodexUsageModel,
  ) => {
    try {
      const activeModel = model ?? ctx.model;
      if (!isOpenAICodexModel(activeModel)) {
        clearUsageStatusline(ctx);
        return;
      }

      const requestId = statuslineRequestId + 1;
      statuslineRequestId = requestId;
      let state = loadState();
      renderState(ctx, state, activeModel, forceRender);

      const now = Date.now();
      if (
        isRefreshDue(state, instanceId, now) &&
        now - lastAttemptAt >= MIN_ATTEMPT_GAP_MS
      ) {
        await refreshSharedState(ctx, activeModel);
        if (requestId !== statuslineRequestId) return;
        if (!isOpenAICodexModel(ctx.model)) {
          clearUsageStatusline(ctx);
          return;
        }
        state = loadState();
        renderState(ctx, state, activeModel, false);
      }
      scheduleStatuslineRefresh(ctx, nextTickDelayMs(state));
    } catch (error) {
      if (isStaleExtensionContextError(error)) {
        clearStatuslineTimers();
        return;
      }
      throw error;
    }
  };

  ensureTelegramStatusLineRegistered();

  pi.on("session_start", (_event, ctx) => {
    ensureTelegramStatusLineRegistered();
    if (isOpenAICodexModel(ctx.model))
      void refreshCurrentCodexUsageStatusline(ctx, true).catch(
        handleAsyncTimerError,
      );
    else clearUsageStatusline(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    if (isOpenAICodexModel(ctx.model))
      void refreshCurrentCodexUsageStatusline(ctx, true).catch(
        handleAsyncTimerError,
      );
    else clearUsageStatusline(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    if (isOpenAICodexModel(event.model)) {
      void refreshCurrentCodexUsageStatusline(ctx, true, event.model).catch(
        handleAsyncTimerError,
      );
    } else {
      clearUsageStatusline(ctx);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearUsageStatusline(ctx);
    unregisterTelegramStatusLine?.();
    unregisterTelegramStatusLine = undefined;
  });
}

function handleAsyncTimerError(error: unknown): void {
  handleTimerError(error);
}

function handleTimerError(error: unknown): void {
  if (isStaleExtensionContextError(error)) return;
  throw error;
}

export function isStaleExtensionContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("ctx is stale");
}

function isOpenAICodexModel(
  model: Pick<PiModel, "provider"> | undefined,
): boolean {
  return model?.provider === CODEX_PROVIDER_ID;
}

async function importTelegramStatusLineModule(): Promise<
  TelegramStatusLineModule | undefined
> {
  for (const specifier of TELEGRAM_STATUS_IMPORT_SPECIFIERS) {
    try {
      const imported = (await import(specifier)) as TelegramStatusLineModule;
      if (typeof imported.registerTelegramStatusLineProvider === "function") {
        return imported;
      }
    } catch {
      // pi-telegram is optional; absence just disables the Telegram status line.
    }
  }
  return undefined;
}

async function registerCodexUsageTelegramStatusLine(
  provider: TelegramStatusLineProvider,
): Promise<(() => void) | undefined> {
  const telegramStatus = await importTelegramStatusLineModule();
  return telegramStatus?.registerTelegramStatusLineProvider?.(provider, {
    id: CODEX_USAGE_EXTENSION_ID,
  });
}

async function queryUsage(
  ctx: ExtensionContext,
  options: Pick<QueryUsageOptions, "timeoutMs">,
  model: CodexUsageModel | undefined,
  mayQuery: () => boolean,
): Promise<QueryUsageResult | undefined> {
  const errors: UsageQueryError[] = [];
  const sources = ["pi-auth", "codex-app-server"] as const;

  for (const source of sources) {
    if (!mayQuery()) return undefined;
    try {
      const report =
        source === "pi-auth"
          ? await queryViaPiAuth(ctx, options.timeoutMs, mayQuery)
          : await queryViaCodexAppServer(options.timeoutMs, mayQuery);
      if (!report) return undefined;
      if (
        selectUsageSnapshot(report, CODEX_USAGE_LIMIT_ID) ||
        report.credits
      ) {
        return { ok: true, report };
      }
      errors.push({
        source,
        message: `${source} returned no displayable codex rate-limit windows`,
      });
    } catch (cause) {
      errors.push({ source, message: errorMessage(cause), cause });
    }
  }

  return { ok: false, errors };
}

async function queryViaPiAuth(
  ctx: ExtensionContext,
  timeoutMs: number,
  mayQuery: () => boolean,
): Promise<CodexUsageReport | undefined> {
  const auth = await resolvePiCodexAuth(ctx);
  if (!auth) {
    throw new Error(
      "No Pi OpenAI Codex subscription auth was available. Use a Pi OpenAI Codex model or run /login for OpenAI ChatGPT Plus/Pro (Codex).",
    );
  }

  if (!mayQuery()) return undefined;
  const response = await fetchWithTimeout(
    CODEX_USAGE_URL,
    { headers: auth.headers },
    timeoutMs,
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Codex usage endpoint returned ${response.status} ${response.statusText}: ${redactErrorBody(text)}`,
    );
  }

  const payload = parseJsonObject(text, "Codex usage endpoint response");
  return normalizeBackendPayload(
    payload as RateLimitStatusPayload,
    Date.now(),
    "pi-auth",
  );
}

async function resolvePiCodexAuth(
  ctx: ExtensionContext,
): Promise<{ headers: Record<string, string> } | undefined> {
  const models = codexAuthCandidateModels(ctx);
  const errors: string[] = [];

  for (const model of models) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      errors.push(auth.error);
      continue;
    }

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(auth.headers ?? {})) {
      if (value !== null) headers[name] = value;
    }
    if (!hasHeader(headers, "Authorization") && auth.apiKey) {
      headers.Authorization = `Bearer ${auth.apiKey}`;
    }
    if (!hasHeader(headers, "User-Agent")) {
      headers["User-Agent"] = "pi-codex-usage";
    }
    if (hasHeader(headers, "Authorization")) {
      return { headers };
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
  return undefined;
}

function codexAuthCandidateModels(ctx: ExtensionContext): PiModel[] {
  const candidates: PiModel[] = [];
  const seen = new Set<string>();
  const add = (model: PiModel | undefined) => {
    if (!model || model.provider !== CODEX_PROVIDER_ID) return;
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(model);
  };

  add(ctx.model);
  for (const model of ctx.modelRegistry.getAvailable()) add(model);
  for (const model of ctx.modelRegistry.getAll()) add(model);
  return candidates;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s while fetching Codex usage.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function queryViaCodexAppServer(
  timeoutMs: number,
  mayQuery: () => boolean,
): Promise<CodexUsageReport | undefined> {
  const client = new CodexAppServerClient(timeoutMs);
  try {
    await client.start();
    if (!mayQuery()) return undefined;
    await client.request("initialize", {
      clientInfo: {
        name: "pi_codex_usage",
        title: "Pi Codex Usage",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    client.notify("initialized");
    if (!mayQuery()) return undefined;
    const result = await client.request("account/rateLimits/read", undefined);
    return normalizeAppServerResponse(
      assertObject(
        result,
        "account/rateLimits/read result",
      ) as AppServerRateLimitResponse,
      Date.now(),
    );
  } finally {
    client.dispose();
  }
}

class CodexAppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stderr = "";
  private readonly pending = new Map<number, PendingRpc>();
  private startPromise?: Promise<void>;
  private exitError?: Error;
  private readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise((resolve, reject) => {
      const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;

      const startupTimeout = setTimeout(() => {
        reject(
          new Error(
            `Timed out after ${Math.round(this.timeoutMs / 1000)}s starting codex app-server.`,
          ),
        );
      }, this.timeoutMs);

      child.once("spawn", () => {
        clearTimeout(startupTimeout);
        resolve();
      });

      child.once("error", (error) => {
        clearTimeout(startupTimeout);
        reject(new Error(`Failed to start codex app-server: ${error.message}`));
        this.rejectAll(error);
      });

      child.once("exit", (code, signal) => {
        const suffix = this.stderr
          ? ` stderr: ${redactErrorBody(this.stderr)}`
          : "";
        this.exitError = new Error(
          `codex app-server exited before completing the request (code ${code ?? "unknown"}, signal ${signal ?? "none"}).${suffix}`,
        );
        this.rejectAll(this.exitError);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.stderr = truncateEnd(this.stderr + chunk, MAX_ERROR_BODY_CHARS);
      });

      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => this.handleLine(line));
    });

    return this.startPromise;
  }

  request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable) {
      throw new Error("codex app-server is not running.");
    }
    if (this.exitError) throw this.exitError;

    const id = this.nextId++;
    const payload =
      params === undefined ? { method, id } : { method, id, params };
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Timed out after ${Math.round(this.timeoutMs / 1000)}s waiting for ${method}.`,
          ),
        );
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });

    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return response;
  }

  notify(method: string): void {
    const child = this.child;
    if (!child?.stdin.writable) return;
    child.stdin.write(`${JSON.stringify({ method })}\n`);
  }

  dispose(): void {
    for (const [id, pending] of this.pending) {
      pending.reject(new Error(`codex app-server request ${id} cancelled.`));
    }
    this.pending.clear();

    const child = this.child;
    if (!child) return;
    child.stdin.end();
    if (!child.killed) child.kill();
    this.child = undefined;
  }

  private handleLine(line: string): void {
    let parsed: RpcResponse;
    try {
      parsed = JSON.parse(line) as RpcResponse;
    } catch {
      return;
    }

    if (typeof parsed.id !== "number") return;
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);

    if (parsed.error) {
      const message =
        typeof parsed.error.message === "string"
          ? parsed.error.message
          : "unknown error";
      pending.reject(new Error(`codex app-server request failed: ${message}`));
      return;
    }

    pending.resolve(parsed.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function normalizeBackendPayload(
  payload: RateLimitStatusPayload,
  _capturedAt: number,
  _source: UsageSource,
): CodexUsageReport {
  const snapshots: NormalizedRateLimitSnapshot[] = [];
  const primarySnapshot = normalizeBackendSnapshot(
    CODEX_USAGE_LIMIT_ID,
    payload.rate_limit,
    _capturedAt,
  );
  if (primarySnapshot) snapshots.push(primarySnapshot);

  const credits = normalizeBackendCredits(payload, _capturedAt);
  if (snapshots.length === 0 && !credits) {
    throw new Error(
      "Codex usage endpoint returned no displayable rate-limit windows or credits.",
    );
  }
  return credits ? { snapshots, credits } : { snapshots };
}

function normalizeBackendCredits(
  payload: RateLimitStatusPayload,
  capturedAt: number,
): NormalizedCreditUsage | undefined {
  const spendControl = payload.spend_control as
    | Record<string, unknown>
    | undefined;
  const individualLimit = spendControl?.individual_limit as
    | Record<string, unknown>
    | undefined;
  const credits = payload.credits as Record<string, unknown> | undefined;
  const limit = asNumber(individualLimit?.limit);
  const used = asNumber(individualLimit?.used);
  const remaining = asNumber(individualLimit?.remaining);
  const resetAt = asResetTime(
    [
      individualLimit?.reset_at,
      individualLimit?.resets_at,
      individualLimit?.reset_time,
      spendControl?.reset_at,
      spendControl?.resets_at,
      credits?.reset_at,
      credits?.resets_at,
    ],
    individualLimit?.reset_after_seconds ?? spendControl?.reset_after_seconds,
    capturedAt,
  );
  if (
    limit === undefined ||
    used === undefined ||
    remaining === undefined ||
    limit <= 0
  )
    return undefined;
  const remainingPercent = Math.min(
    100,
    Math.max(0, (remaining / limit) * 100),
  );
  return resetAt === undefined
    ? { remainingPercent }
    : { remainingPercent, resetAt };
}

function normalizeBackendSnapshot(
  limitId: string,
  rateLimit: unknown,
  capturedAt: number,
): NormalizedRateLimitSnapshot | undefined {
  if (rateLimit === null || rateLimit === undefined) return undefined;
  const details = assertObject(
    rateLimit,
    "rate limit",
  ) as BackendRateLimitDetails;
  const primary = normalizeBackendWindow(details.primary_window, capturedAt);
  const secondary = normalizeBackendWindow(
    details.secondary_window,
    capturedAt,
  );
  if (!primary && !secondary) return undefined;
  return { limitId, primary, secondary };
}

function normalizeBackendWindow(
  value: unknown,
  capturedAt: number,
): NormalizedRateLimitWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const window = assertObject(
    value,
    "rate-limit window",
  ) as BackendWindowSnapshot;
  const usedPercent = asNumber(window.used_percent);
  if (usedPercent === undefined) return undefined;
  const resetAt = asResetTime(
    [
      window.reset_at,
      window.resets_at,
      window.reset_time,
      window.end_time,
      window.ends_at,
      window.expires_at,
    ],
    window.reset_after_seconds,
    capturedAt,
  );
  return resetAt === undefined ? { usedPercent } : { usedPercent, resetAt };
}

export function normalizeAppServerResponse(
  response: AppServerRateLimitResponse,
  _capturedAt: number,
): CodexUsageReport {
  const snapshots: NormalizedRateLimitSnapshot[] = [];
  const addSnapshot = (raw: unknown, fallbackId: string) => {
    const snapshot = normalizeAppServerSnapshot(raw, fallbackId, _capturedAt);
    if (!snapshot) return;
    const existingIndex = snapshots.findIndex(
      (item) => item.limitId === snapshot.limitId,
    );
    if (existingIndex >= 0)
      snapshots[existingIndex] = mergeSnapshot(
        snapshots[existingIndex],
        snapshot,
      );
    else snapshots.push(snapshot);
  };

  if (Array.isArray(response.rateLimits)) {
    for (const item of response.rateLimits) addSnapshot(item, "codex");
  } else {
    addSnapshot(response.rateLimits, "codex");
  }
  if (snapshots.length === 0) {
    throw new Error(
      "codex app-server returned no displayable rate-limit windows.",
    );
  }

  return { snapshots };
}

function normalizeAppServerSnapshot(
  raw: unknown,
  fallbackId: string,
  capturedAt: number,
): NormalizedRateLimitSnapshot | undefined {
  if (raw === null || raw === undefined) return undefined;
  const snapshot = assertObject(
    raw,
    "app-server rate-limit snapshot",
  ) as AppServerRateLimitSnapshot;
  const limitId = asString(snapshot.limitId) ?? fallbackId;
  if (normalizedUsageKey(limitId) !== CODEX_USAGE_LIMIT_ID) return undefined;
  const primary = normalizeAppServerWindow(snapshot.primary, capturedAt);
  const secondary = normalizeAppServerWindow(snapshot.secondary, capturedAt);
  if (!primary && !secondary) return undefined;
  return { limitId, primary, secondary };
}

function normalizeAppServerWindow(
  value: unknown,
  capturedAt: number,
): NormalizedRateLimitWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const window = assertObject(
    value,
    "app-server rate-limit window",
  ) as AppServerWindowSnapshot;
  const usedPercent = asNumber(window.usedPercent);
  if (usedPercent === undefined) return undefined;
  const resetAt = asResetTime(
    [
      window.resetAt,
      window.resetsAt,
      window.resetTime,
      window.endTime,
      window.endsAt,
      window.expiresAt,
    ],
    window.resetAfterSeconds,
    capturedAt,
  );
  return resetAt === undefined ? { usedPercent } : { usedPercent, resetAt };
}

function mergeSnapshot(
  left: NormalizedRateLimitSnapshot,
  right: NormalizedRateLimitSnapshot,
): NormalizedRateLimitSnapshot {
  return {
    limitId: right.limitId || left.limitId,
    primary: right.primary ?? left.primary,
    secondary: right.secondary ?? left.secondary,
  };
}

export function formatCodexUsageStatusline(
  report: CodexUsageReport,
  ctx: ExtensionContext,
  model?: CodexUsageModel,
): string {
  const value = formatCodexUsageStatusValue(report, model);
  if (!value) return formatStatuslineText(ctx, "n/a", model);
  const snapshot = selectActiveUsageSnapshot(report, model);
  if (!snapshot?.primary || !snapshot.secondary)
    return formatStatuslineText(ctx, value, model);
  const [bar, countdown] = value.split(" ", 2);
  const barText = formatStatuslineBarText(
    ctx,
    bar ?? "",
    hasExhaustedQuotaWindow(report, model) ? "toolErrorBg" : "userMessageBg",
    model,
  );
  return countdown
    ? `${barText} ${ctx.ui.theme.fg("dim", countdown)}`
    : barText;
}

export function formatCodexUsageBar(
  report: CodexUsageReport,
): string | undefined {
  return formatReportBar(report);
}

export function formatCodexUsageStatusValue(
  report: CodexUsageReport,
  modelOrNow?: CodexUsageModel | number,
  now = Date.now(),
): string | undefined {
  const model = typeof modelOrNow === "number" ? undefined : modelOrNow;
  const capturedNow = typeof modelOrNow === "number" ? modelOrNow : now;
  const snapshot = selectActiveUsageSnapshot(report, model);
  if (!snapshot || (!snapshot.primary && !snapshot.secondary)) {
    return formatCreditUsage(report.credits, capturedNow);
  }
  if (!snapshot.primary || !snapshot.secondary) {
    const window = snapshot.primary ?? snapshot.secondary;
    if (!window) return undefined;
    const percentage = `${Math.round(remainingPercent(window))}%`;
    const countdown = window.resetAt
      ? formatResetCountdown(window.resetAt, capturedNow)
      : undefined;
    return countdown ? `${percentage} ${countdown}` : percentage;
  }
  const bar = formatDualLimitBar(snapshot.primary, snapshot.secondary);
  if (isQuotaWindowExhausted(snapshot.primary) && snapshot.primary?.resetAt) {
    const primaryCountdown = formatResetCountdown(
      snapshot.primary.resetAt,
      capturedNow,
    );
    const weeklyCountdown = snapshot.secondary?.resetAt
      ? formatResetCountdown(snapshot.secondary.resetAt, capturedNow)
      : undefined;
    return weeklyCountdown
      ? `${bar} ${primaryCountdown}/${weeklyCountdown}`
      : `${bar} ${primaryCountdown}`;
  }
  const countdown = formatWeeklyResetCountdown(report, model, capturedNow);
  return countdown ? `${bar} ${countdown}` : bar;
}

function formatCreditUsage(
  credits: NormalizedCreditUsage | undefined,
  now: number,
): string | undefined {
  if (!credits) return undefined;
  const percentage = `${Math.round(credits.remainingPercent)}%`;
  return credits.resetAt
    ? `${percentage} ${formatResetCountdown(credits.resetAt, now)}`
    : percentage;
}

export function formatWeeklyResetCountdown(
  report: CodexUsageReport,
  modelOrNow?: CodexUsageModel | number,
  now = Date.now(),
): string | undefined {
  const model = typeof modelOrNow === "number" ? undefined : modelOrNow;
  const capturedNow = typeof modelOrNow === "number" ? modelOrNow : now;
  const snapshot = selectActiveUsageSnapshot(report, model);
  const resetAt = weeklyWindow(snapshot)?.resetAt;
  if (resetAt === undefined) return undefined;
  return formatResetCountdown(resetAt, capturedNow);
}

export function formatResetCountdown(
  resetAt: number,
  now = Date.now(),
): string {
  const remainingMs = Math.max(0, resetAt - now);
  if (remainingMs > DAY_MS) {
    const dayTenths = Math.max(10, Math.ceil(remainingMs / DAY_TENTH_MS));
    return `${formatTenths(dayTenths)}d`;
  }
  if (remainingMs >= HOUR_MS) {
    const hourTenths = Math.max(10, Math.ceil(remainingMs / HOUR_TENTH_MS));
    return `${formatTenths(hourTenths)}h`;
  }
  if (remainingMs >= MINUTE_MS)
    return `${Math.floor(remainingMs / MINUTE_MS)}m`;
  return `${Math.floor(remainingMs / SECOND_MS)}s`;
}

export function nextResetCountdownDelayMs(
  report: CodexUsageReport,
  now = Date.now(),
  model?: CodexUsageModel,
): number | undefined {
  const snapshot = selectActiveUsageSnapshot(report, model);
  const hasRateLimitWindow = Boolean(snapshot?.primary || snapshot?.secondary);
  const resetTimes = [
    hasRateLimitWindow ? weeklyWindow(snapshot)?.resetAt : report.credits?.resetAt,
  ];
  if (snapshot?.secondary && isQuotaWindowExhausted(snapshot.primary)) {
    resetTimes.push(snapshot.primary?.resetAt);
  }
  const delays = resetTimes
    .filter((resetAt): resetAt is number => resetAt !== undefined)
    .map((resetAt) => nextResetCountdownDelayForRemainingMs(resetAt - now))
    .filter((delay): delay is number => delay !== undefined);
  return delays.length > 0 ? Math.min(...delays) : undefined;
}

export function nextResetCountdownDelayForRemainingMs(
  remainingMs: number,
): number | undefined {
  if (remainingMs <= 0) return undefined;
  if (remainingMs > DAY_MS) {
    const dayTenths = Math.max(10, Math.ceil(remainingMs / DAY_TENTH_MS));
    return Math.max(1, remainingMs - (dayTenths - 1) * DAY_TENTH_MS);
  }
  if (remainingMs >= HOUR_MS) {
    const hourTenths = Math.max(10, Math.ceil(remainingMs / HOUR_TENTH_MS));
    if (hourTenths === 10) return Math.max(1, remainingMs - HOUR_MS + 1);
    return Math.max(1, remainingMs - (hourTenths - 1) * HOUR_TENTH_MS);
  }
  if (remainingMs >= MINUTE_MS) {
    return Math.max(
      1,
      remainingMs - Math.floor(remainingMs / MINUTE_MS) * MINUTE_MS + 1,
    );
  }
  return Math.max(
    1,
    remainingMs - Math.floor(remainingMs / SECOND_MS) * SECOND_MS + 1,
  );
}

function formatTenths(value: number): string {
  return value % 10 === 0 ? String(value / 10) : (value / 10).toFixed(1);
}

function formatReportBar(
  report: CodexUsageReport,
  model?: CodexUsageModel,
): string | undefined {
  const snapshot = selectActiveUsageSnapshot(report, model);
  if (!snapshot || (!snapshot.primary && !snapshot.secondary)) return undefined;
  return formatAdaptiveLimitBar(snapshot.primary, snapshot.secondary);
}

function formatStatuslineText(
  ctx: ExtensionContext,
  value: string,
  _model?: CodexUsageModel,
): string {
  const label = ctx.ui.theme.fg("accent", DEFAULT_STATUS_LABEL_TEXT);
  return `${label} ${ctx.ui.theme.fg("dim", value)}`;
}

function formatStatuslineBarText(
  ctx: ExtensionContext,
  bar: string,
  background: "userMessageBg" | "toolErrorBg",
  _model?: CodexUsageModel,
): string {
  const label = ctx.ui.theme.fg("accent", DEFAULT_STATUS_LABEL_TEXT);
  const value = ctx.ui.theme.bg(background, ctx.ui.theme.fg("dim", bar));
  return `${label} ${value}`;
}

export function formatCodexUsageLoadingBar(frame: number): string {
  const totalParts = DUAL_BAR_WIDTH * 2;
  const cycleFrames = (totalParts - 1) * 2;
  const finiteFrame = Number.isFinite(frame) ? frame : 0;
  const cycleFrame = Math.abs(Math.trunc(finiteFrame)) % cycleFrames;
  const primaryPart =
    cycleFrame < totalParts ? cycleFrame : cycleFrames - cycleFrame;
  const secondaryPart = totalParts - primaryPart - 1;
  const masks = Array<number>(DUAL_BAR_WIDTH).fill(0);
  const primaryCell = Math.floor(primaryPart / 2);
  const secondaryCell = Math.floor(secondaryPart / 2);
  masks[primaryCell] |= primaryPart % 2 === 0 ? 1 : 2;
  masks[secondaryCell] |= secondaryPart % 2 === 0 ? 4 : 8;
  return masks.map((mask) => DUAL_BAR_CHARS[mask]).join("");
}

function formatStatuslineLoading(
  ctx: ExtensionContext,
  frame: number,
  model?: CodexUsageModel,
): string {
  return formatStatuslineBarText(
    ctx,
    formatCodexUsageLoadingBar(frame),
    "userMessageBg",
    model,
  );
}

function formatStatuslineProblem(
  ctx: ExtensionContext,
  unavailable: boolean,
  _model?: CodexUsageModel,
): string {
  const label = ctx.ui.theme.fg("accent", DEFAULT_STATUS_LABEL_TEXT);
  const value = unavailable
    ? ctx.ui.theme.fg("muted", "n/a")
    : ctx.ui.theme.fg("error", "error");
  return `${label} ${value}`;
}

export function isUsageUnavailable(errors: UsageQueryError[]): boolean {
  return errors.length > 0 && errors.every(isUnavailableError);
}

function isUnavailableError(error: UsageQueryError): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("no pi openai codex subscription auth") ||
    message.includes("no displayable rate-limit windows") ||
    message.includes("returned no displayable rate-limit windows") ||
    message.includes("returned 401") ||
    message.includes("returned 403") ||
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("subscription") ||
    message.includes("no active plan") ||
    message.includes("plan unavailable") ||
    message.includes("quota unavailable") ||
    message.includes("rate limits unavailable")
  );
}

function normalizedUsageKey(value: string | undefined): string | undefined {
  const key = value
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key || undefined;
}

function formatAdaptiveLimitBar(
  primary: NormalizedRateLimitWindow | undefined,
  secondary: NormalizedRateLimitWindow | undefined,
): string {
  if (!primary || !secondary) return formatSingleLimitBar(primary ?? secondary);
  return formatDualLimitBar(primary, secondary);
}

function formatSingleLimitBar(
  window: NormalizedRateLimitWindow | undefined,
): string {
  const filled = filledParts(window, DUAL_BAR_WIDTH * 4);
  const partMasks = [1, 4, 2, 8];
  let value = "";
  for (let index = 0; index < DUAL_BAR_WIDTH; index++) {
    const cellParts = Math.min(4, Math.max(0, filled - index * 4));
    let mask = 0;
    for (let part = 0; part < cellParts; part++) mask |= partMasks[part] ?? 0;
    value += DUAL_BAR_CHARS[mask];
  }
  return value;
}

function formatDualLimitBar(
  primary: NormalizedRateLimitWindow,
  secondary: NormalizedRateLimitWindow,
): string {
  const primaryParts = filledTwentieths(primary);
  const secondaryParts = filledTwentieths(secondary);
  let value = "";
  for (let index = 0; index < DUAL_BAR_WIDTH; index++) {
    const leftPart = index * 2 + 1;
    const rightPart = leftPart + 1;
    let mask = 0;
    if (primaryParts >= leftPart) mask |= 1;
    if (primaryParts >= rightPart) mask |= 2;
    if (secondaryParts >= leftPart) mask |= 4;
    if (secondaryParts >= rightPart) mask |= 8;
    value += DUAL_BAR_CHARS[mask];
  }
  return value;
}

function filledTwentieths(
  window: NormalizedRateLimitWindow | undefined,
): number {
  return filledParts(window, 20);
}

function filledParts(
  window: NormalizedRateLimitWindow | undefined,
  totalParts: number,
): number {
  if (!window) return 0;
  const remaining = remainingPercent(window);
  if (remaining <= 0) return 0;
  return Math.max(1, Math.round(remaining / (100 / totalParts)));
}

function remainingPercent(window: NormalizedRateLimitWindow): number {
  return 100 - clampPercent(window.usedPercent);
}

function isQuotaWindowExhausted(
  window: NormalizedRateLimitWindow | undefined,
): boolean {
  return window !== undefined && remainingPercent(window) <= 0;
}

function hasExhaustedQuotaWindow(
  report: CodexUsageReport,
  model?: CodexUsageModel,
): boolean {
  const snapshot = selectActiveUsageSnapshot(report, model);
  return (
    isQuotaWindowExhausted(snapshot?.primary) ||
    isQuotaWindowExhausted(snapshot?.secondary)
  );
}

export function canReuseCachedReport(
  report: CodexUsageReport,
  model: CodexUsageModel | undefined,
): boolean {
  return (
    selectActiveUsageSnapshot(report, model) !== undefined ||
    report.credits !== undefined
  );
}

export function isFullyAvailableReport(
  report: CodexUsageReport,
  model?: CodexUsageModel,
): boolean {
  const snapshot = selectActiveUsageSnapshot(report, model);
  const windows = [snapshot?.primary, snapshot?.secondary].filter(
    (window): window is NormalizedRateLimitWindow => window !== undefined,
  );
  return (
    windows.length > 0 &&
    windows.every((window) => clampPercent(window.usedPercent) === 0)
  );
}

function weeklyWindow(
  snapshot: NormalizedRateLimitSnapshot | undefined,
): NormalizedRateLimitWindow | undefined {
  return snapshot?.secondary ?? snapshot?.primary;
}

function selectActiveUsageSnapshot(
  report: CodexUsageReport,
  _model: CodexUsageModel | undefined,
): NormalizedRateLimitSnapshot | undefined {
  return selectUsageSnapshot(report, CODEX_USAGE_LIMIT_ID);
}

function selectUsageSnapshot(
  report: CodexUsageReport,
  limitId: string,
): NormalizedRateLimitSnapshot | undefined {
  const normalizedLimitId = normalizedUsageKey(limitId);
  return report.snapshots.find(
    (snapshot) => normalizedUsageKey(snapshot.limitId) === normalizedLimitId,
  );
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function parseJsonObject(
  text: string,
  description: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `${description} was not valid JSON: ${errorMessage(error)}`,
    );
  }
  return assertObject(parsed, description);
}

function assertObject(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} was not an object.`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asResetTime(
  absoluteValues: unknown[],
  relativeSeconds: unknown,
  capturedAt: number,
): number | undefined {
  for (const value of absoluteValues) {
    const timestamp = asTimestampMs(value);
    if (timestamp !== undefined) return timestamp;
  }
  const seconds = asNumber(relativeSeconds);
  if (seconds === undefined || seconds < 0) return undefined;
  return capturedAt + seconds * SECOND_MS;
}

function asTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) return undefined;
    return value < 10_000_000_000 ? value * SECOND_MS : value;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return asTimestampMs(numeric);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
}

function redactErrorBody(body: string): string {
  return truncateEnd(
    body
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
      .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"<redacted>"')
      .trim(),
    MAX_ERROR_BODY_CHARS,
  );
}

function truncateEnd(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
