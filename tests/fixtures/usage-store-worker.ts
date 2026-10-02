import { createInterface } from "node:readline";
import { claimRefresh, tryAcquireLock } from "../../lib/usage-store.ts";

const dir = process.argv[2];
let release: (() => void) | undefined;
const input = createInterface({ input: process.stdin });
input.on("line", (command) => {
  if (command === "acquire") {
    if (release) throw new Error("Worker already holds the mutex");
    release = tryAcquireLock(dir);
    console.log(release ? "won" : "lost");
  } else if (command === "claim") {
    console.log(claimRefresh(dir, String(process.pid)) ? "claimed" : "lost");
  } else if (command === "release") {
    release?.();
    release = undefined;
    console.log("released");
  } else {
    throw new Error(`Unknown test command: ${command}`);
  }
});
input.on("close", () => {
  release?.();
  process.exit(0);
});
console.log("ready");
