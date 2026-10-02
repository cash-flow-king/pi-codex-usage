import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  claimRefresh,
  publishRefresh,
  readState,
  TAKEOVER_AFTER_MS,
  tryAcquireLock,
  writeState,
} from "../lib/usage-store.ts";

type Worker = {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  send: (command: string) => Promise<string>;
};

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "usage-mutex-"));
  const workers: Worker[] = [];
  // Register cleanup before starting anything; SIGKILL also stops paused workers.
  t.after(async () => {
    for (const { child } of workers) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.all(workers.map((worker) => worker.closed));
    rmSync(dir, { recursive: true, force: true });
  });
  const start = async (): Promise<Worker> => {
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      fileURLToPath(new URL("fixtures/usage-store-worker.ts", import.meta.url)),
      dir,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { stderr += error.message; });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const readLine = async () => {
      const next = await lines.next();
      if (next.done) throw new Error(`Mutex worker closed unexpectedly: ${stderr}`);
      return next.value;
    };
    const worker: Worker = {
      child,
      closed,
      send: async (command) => {
        child.stdin.write(`${command}\n`);
        return readLine();
      },
    };
    workers.push(worker);
    assert.equal(await readLine(), "ready");
    return worker;
  };
  return { dir, start };
}

async function burst(workers: Worker[], command: "acquire" | "claim") {
  const winner = command === "acquire" ? "won" : "claimed";
  const replies = await Promise.all(workers.map((worker) => worker.send(command)));
  assert.ok(replies.every((reply) => reply === winner || reply === "lost"));
  assert.ok(replies.filter((reply) => reply === winner).length <= 1);
  // A try-lock may deny everyone during contention. Once all attempts finish,
  // a sequential retry must succeed; do not mistake that for broken exclusion.
  if (!replies.includes(winner)) {
    replies[0] = await workers[0].send(command);
    assert.equal(replies[0], winner);
  }
  return replies;
}

test("simultaneous processes have one holder, including immediately after a crash", { timeout: 15_000 }, async (t) => {
  const { dir, start } = setup(t);
  // Every worker is ready before the burst. The winner holds the mutex until
  // ALL replies arrive, avoiding the old sleep-based test's startup race.
  const contenders = await Promise.all(Array.from({ length: 12 }, () => start()));
  const initial = await burst(contenders, "acquire");
  assert.equal(initial.filter((reply) => reply === "won").length, 1);
  assert.equal(initial.filter((reply) => reply === "lost").length, 11);
  const dead = contenders[initial.indexOf("won")];
  writeState(dir, { owner: "dead", claimedAt: 0, report: {} });
  assert.equal(dead.child.kill("SIGKILL"), true);
  await dead.closed;

  const survivors = contenders.filter((worker) => worker !== dead);
  const restarted = await start();
  const next = [...survivors, restarted];
  // The OS has released the dead connection. No expiry check or file unlink
  // runs, so there is no stale-lock reclamation race for these contenders.
  const claims = await burst(next, "claim");
  assert.equal(claims.filter((reply) => reply === "claimed").length, 1);
  assert.equal(claims.filter((reply) => reply === "lost").length, 11);
  assert.equal(readState(dir)?.owner, String(next[claims.indexOf("claimed")].child.pid));

  const locks = await burst(next, "acquire");
  assert.equal(locks.filter((reply) => reply === "won").length, 1);
  assert.equal(locks.filter((reply) => reply === "lost").length, 11);
  assert.equal(await next[locks.indexOf("won")].send("release"), "released");
  const release = tryAcquireLock(dir);
  assert.ok(release);
  release();
});

test("a paused holder cannot be evicted and resuming cannot overwrite a successor", {
  timeout: 15_000,
  skip: process.platform === "win32",
}, async (t) => {
  const { dir, start } = setup(t);
  const now = 1_000_000;
  const old = claimRefresh(dir, "old", now);
  assert.ok(old);
  const holder = await start();
  assert.equal(await holder.send("acquire"), "won");
  assert.equal(holder.child.kill("SIGSTOP"), true);

  const later = now + TAKEOVER_AFTER_MS;
  const before = readFileSync(join(dir, "usage.json"), "utf8");
  assert.equal(tryAcquireLock(dir), undefined);
  assert.equal(claimRefresh(dir, "new", later), undefined);
  assert.equal(readFileSync(join(dir, "usage.json"), "utf8"), before);

  assert.equal(holder.child.kill("SIGCONT"), true);
  assert.equal(await holder.send("release"), "released");
  const successor = claimRefresh(dir, "new", later);
  assert.ok(successor);
  const after = readFileSync(join(dir, "usage.json"), "utf8");
  assert.equal(publishRefresh(dir, old, { ok: true, report: {} }, later + 1), false);
  assert.equal(readFileSync(join(dir, "usage.json"), "utf8"), after);
});
