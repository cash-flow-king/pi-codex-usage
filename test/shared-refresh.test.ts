import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

test("different Codex models share one root usage.json and claim before fetching", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-shared-refresh-"));
  // Isolate Pi's agent directory and module-level configuration in a child.
  // Fetch is mocked: this test must never query subscription endpoints.
  const script = `
    import assert from "node:assert/strict";
    import { readFileSync, readdirSync } from "node:fs";
    import { join } from "node:path";
    const dir = process.env.PI_CODING_AGENT_DIR;
    const stateDir = join(dir, "tmp", "pi-codex-usage");
    const statePath = join(stateDir, "usage.json");
    let calls = 0;
    let claimedOwner;
    globalThis.fetch = async () => {
      calls++;
      const claim = JSON.parse(readFileSync(statePath, "utf8"));
      assert.ok(claim.owner);
      assert.ok(claim.claimedAt);
      assert.equal(claim.report, undefined);
      assert.equal(claim.updatedAt, undefined);
      claimedOwner = claim.owner;
      await new Promise(resolve => setTimeout(resolve, 25));
      return new Response(JSON.stringify({
        rate_limit: {
          primary_window: { used_percent: 10 },
          secondary_window: { used_percent: 20 },
        },
        additional_rate_limits: [{
          limit_name: "retired quota",
          rate_limit: { primary_window: { used_percent: 0 } },
        }],
      }), { status: 200 });
    };
    const { default: extension } = await import(${JSON.stringify(new URL("../index.ts", import.meta.url).href)});
    const instances = Array.from({ length: 6 }, (_, i) => {
      const handlers = new Map();
      let status;
      const model = { provider: "openai-codex", id: "model-" + i, name: "Model " + i };
      const ctx = {
        model,
        ui: {
          theme: { fg: (_, value) => value, bg: (_, value) => value },
          setStatus: (_, value) => { status = value; },
        },
        modelRegistry: {
          getAvailable: () => [model],
          getAll: () => [model],
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-token" }),
        },
      };
      extension({ on: (name, handler) => handlers.set(name, handler) });
      return { ctx, handlers, status: () => status };
    });
    try {
      instances.forEach(({ handlers, ctx }) => handlers.get("session_start")({}, ctx));
      const expected = "codex ████████▀⠀";
      const deadline = Date.now() + 5000;
      while (instances.some(instance => instance.status() !== expected) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(instances.map(instance => instance.status()), Array(6).fill(expected));
      assert.equal(calls, 1);
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(state.owner, claimedOwner);
      assert.ok(state.updatedAt >= state.claimedAt);
      assert.deepEqual(state.report.snapshots.map(snapshot => snapshot.limitId), ["codex"]);
      assert.deepEqual(readdirSync(stateDir).sort(), ["mutex.sqlite", "usage.json"]);
      // Switching models or refreshing the session must not create a new bucket or query.
      await Promise.all(instances.map(async ({ handlers, ctx }) => {
        ctx.model = { ...ctx.model, id: "another-model" };
        handlers.get("model_select")({ model: ctx.model }, ctx);
      }));
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(calls, 1);
      assert.deepEqual(readdirSync(stateDir).sort(), ["mutex.sqlite", "usage.json"]);
      console.log("shared refresh ok");
    } finally {
      instances.forEach(({ handlers, ctx }) => handlers.get("session_shutdown")({}, ctx));
    }
  `;
  try {
    const { stdout } = await run(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      { env: { ...process.env, PI_CODING_AGENT_DIR: dir }, timeout: 15_000 },
    );
    assert.match(stdout, /shared refresh ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
