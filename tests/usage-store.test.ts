import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  claimRefresh,
  failureBackoffMs,
  isRefreshDue,
  LEADER_INTERVAL_MS,
  nextRefreshAt,
  ownsRefreshClaim,
  publishRefresh,
  readState,
  TAKEOVER_AFTER_MS,
  tryAcquireLock,
  writeState,
} from "../lib/usage-store.ts";

const minuteMs = 60_000;
const withDir = (run: (dir: string) => void | Promise<void>) => async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "codex-usage-")), "nested");
  try {
    await run(dir);
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
};

test("round-trips state atomically and tolerates missing or corrupt files", withDir((dir) => {
  assert.equal(readState(dir), undefined);
  const state = {
    report: { primary: { usedPercent: 10 } },
    updatedAt: 5,
    owner: "a",
  };
  assert.equal(writeState(dir, state), true);
  assert.deepEqual(readState(dir), state);
  writeFileSync(join(dir, "usage.json"), "{not json");
  assert.equal(readState(dir), undefined);
}));

test("the leader refreshes after 1 minute and others only after 90 seconds", () => {
  const state = { report: {}, updatedAt: 1_000_000, owner: "leader" };
  assert.equal(LEADER_INTERVAL_MS, minuteMs);
  assert.equal(TAKEOVER_AFTER_MS, 1.5 * minuteMs);

  const at = (ms: number) => state.updatedAt + ms;
  assert.equal(isRefreshDue(state, "leader", at(minuteMs - 1)), false);
  assert.equal(isRefreshDue(state, "leader", at(minuteMs)), true);
  assert.equal(isRefreshDue(state, "other", at(minuteMs)), false);
  assert.equal(isRefreshDue(state, "other", at(1.5 * minuteMs - 1)), false);
  assert.equal(isRefreshDue(state, "other", at(1.5 * minuteMs)), true);
  assert.equal(nextRefreshAt(state, "other", at(0)), at(1.5 * minuteMs));
});

test("a leadership claim makes everyone else not due before the fetch finishes", () => {
  const stale = { report: {}, updatedAt: 0, owner: "old" };
  const now = 10 * minuteMs;
  assert.equal(isRefreshDue(stale, "follower", now), true);

  const claimed = { ...stale, owner: "follower", claimedAt: now };
  assert.equal(isRefreshDue(claimed, "other", now + 1), false);
  assert.equal(isRefreshDue(claimed, "follower", now + 1), false);
  // The claimer is leader now: due again one minute after the claim.
  assert.equal(isRefreshDue(claimed, "follower", now + minuteMs), true);
  assert.equal(isRefreshDue(claimed, "other", now + minuteMs), false);
  // A crashed claimer is replaced after the takeover window.
  assert.equal(isRefreshDue(claimed, "other", now + 1.5 * minuteMs), true);
});

test("an empty state is due for everyone immediately", () => {
  assert.equal(isRefreshDue(undefined, "a", 100), true);
  assert.equal(isRefreshDue({}, "a", 100), true);
});

test("retryNotBefore holds every instance, including the leader", () => {
  const state = {
    report: {},
    updatedAt: 0,
    owner: "leader",
    retryNotBefore: 10 * minuteMs,
  };
  assert.equal(isRefreshDue(state, "leader", 9 * minuteMs), false);
  assert.equal(isRefreshDue(state, "other", 9 * minuteMs), false);
  assert.equal(isRefreshDue(state, "other", 10 * minuteMs), true);
  assert.equal(isRefreshDue({ retryNotBefore: 50 }, "a", 10), false);
});

test("failure backoff grows exponentially and respects Retry-After", () => {
  const limited = { rateLimited: true };
  assert.equal(failureBackoffMs(1, limited), 5 * minuteMs);
  assert.equal(failureBackoffMs(2, limited), 10 * minuteMs);
  assert.equal(failureBackoffMs(9, limited), 30 * minuteMs);
  assert.equal(failureBackoffMs(1, { rateLimited: false }), minuteMs);
  assert.equal(failureBackoffMs(9, { rateLimited: false }), 5 * minuteMs);
  assert.equal(
    failureBackoffMs(1, { rateLimited: true, retryAfterMs: 45 * minuteMs }),
    45 * minuteMs,
  );
});

test("a lock has no expiry and release is idempotent", withDir((dir) => {
  const first = tryAcquireLock(dir);
  assert.ok(first);
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 24 * 60 * minuteMs;
    assert.equal(tryAcquireLock(dir), undefined);
    assert.equal(tryAcquireLock(dir), undefined);
  } finally {
    Date.now = originalNow;
    first();
  }

  const second = tryAcquireLock(dir);
  assert.ok(second);
  try {
    // An old release must not unlock a new connection's transaction.
    first();
    assert.equal(tryAcquireLock(dir), undefined);
  } finally {
    second();
  }
}));

test("provider directories have independent mutexes", withDir((dir) => {
  const claude = tryAcquireLock(join(dir, "pi-claude-usage"));
  assert.ok(claude);
  let codex: (() => void) | undefined;
  try {
    codex = tryAcquireLock(join(dir, "pi-codex-usage"));
    assert.ok(codex);
  } finally {
    codex?.();
    claude();
  }
}));

test("a corrupt mutex fails closed without changing the JSON", withDir((dir) => {
  writeState(dir, { owner: "old", claimedAt: 0, report: {} });
  const bytes = readFileSync(join(dir, "usage.json"), "utf8");
  writeFileSync(join(dir, "mutex.sqlite"), "not sqlite");
  assert.equal(tryAcquireLock(dir), undefined);
  assert.equal(claimRefresh(dir, "new", TAKEOVER_AFTER_MS), undefined);
  assert.equal(readFileSync(join(dir, "usage.json"), "utf8"), bytes);
  // Failed acquisition must close its connection, not strand another lock.
  rmSync(join(dir, "mutex.sqlite"));
  const release = tryAcquireLock(dir);
  assert.ok(release);
  release();
}));

test("claims are written before authorization and checked from disk every time", withDir((dir) => {
  const now = 1_000_000;
  const claim = claimRefresh(dir, "a", now);
  assert.ok(claim);
  assert.equal(readState(dir)?.claimId, claim.claimId);
  assert.equal(ownsRefreshClaim(dir, claim, now), true);
  assert.equal(claimRefresh(dir, "b", now + 1), undefined);
  assert.equal(ownsRefreshClaim(dir, claim, now + TAKEOVER_AFTER_MS), false);
  assert.equal(publishRefresh(dir, claim, { ok: true, report: {} }, now + TAKEOVER_AFTER_MS), false);

  const successor = claimRefresh(dir, "b", now + TAKEOVER_AFTER_MS);
  assert.ok(successor);
  assert.equal(ownsRefreshClaim(dir, claim, now + TAKEOVER_AFTER_MS), false);
  assert.equal(ownsRefreshClaim(dir, successor, now + TAKEOVER_AFTER_MS), true);
}));

test("late outcomes cannot overwrite another owner or a newer claim by the same owner", withDir((dir) => {
  const now = 1_000_000;
  for (const nextOwner of ["b", "a"]) {
    writeState(dir, {});
    const old = claimRefresh(dir, "a", now);
    assert.ok(old);
    const successor = claimRefresh(dir, nextOwner, now + TAKEOVER_AFTER_MS);
    assert.ok(successor);
    assert.notEqual(successor.claimId, old.claimId);
    assert.equal(publishRefresh(dir, successor, {
      ok: true, report: { primary: { usedPercent: 40 } },
    }, now + TAKEOVER_AFTER_MS + 1), true);
    const bytes = readFileSync(join(dir, "usage.json"), "utf8");
    assert.equal(publishRefresh(dir, old, {
      ok: true, report: { primary: { usedPercent: 1 } },
    }, now + TAKEOVER_AFTER_MS + 2), false);
    assert.equal(publishRefresh(dir, old, {
      ok: false, error: "old failure", rateLimited: true,
    }, now + TAKEOVER_AFTER_MS + 2), false);
    assert.equal(readFileSync(join(dir, "usage.json"), "utf8"), bytes);
  }
}));

test("unavailable locks or failed claim writes grant no permission", withDir((dir) => {
  writeFileSync(dir, "not a directory");
  assert.equal(tryAcquireLock(dir), undefined);
  assert.equal(claimRefresh(dir, "a", 1), undefined);
  rmSync(dir);
  mkdirSync(join(dir, "usage.json"), { recursive: true });
  assert.equal(claimRefresh(dir, "a", 1), undefined);
}));

test("publishing a failure shares backoff and a later success clears it", withDir((dir) => {
  const now = 1_000_000;
  const claim = claimRefresh(dir, "a", now);
  assert.ok(claim);
  assert.equal(publishRefresh(dir, claim, {
    ok: false, error: "429", rateLimited: true,
  }, now + 1), true);
  const retryAt = now + 1 + 5 * minuteMs;
  assert.equal(readState(dir)?.retryNotBefore, retryAt);
  assert.equal(claimRefresh(dir, "b", retryAt - 1), undefined);
  const next = claimRefresh(dir, "b", retryAt);
  assert.ok(next);
  assert.equal(publishRefresh(dir, next, { ok: true, report: {} }, retryAt + 1), true);
  const state = readState(dir);
  assert.equal(state?.error, undefined);
  assert.equal(state?.retryNotBefore, undefined);
  assert.equal(state?.failures, undefined);
}));
