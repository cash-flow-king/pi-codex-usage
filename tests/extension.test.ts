import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import codexUsage from "../lib/extension.ts";
import { isFastEnabled } from "../lib/fast.ts";

test("every declared Pi peer has the 1.0.0 minimum", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const [name, range] of Object.entries(pkg.peerDependencies))
    if (name.startsWith("@earendil-works/")) assert.equal(range, ">=1.0.0", name);
});

test("provider-level shared /fast persists, dispatches, redraws every status and never fetches quota", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-fast-codex-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("Unexpected quota fetch"); };
  process.env.PI_CODING_AGENT_DIR = dir;
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const commands: Array<(args: string, ctx: any) => Promise<void>> = [];
  const statuses: Array<string | undefined> = [];
  const notices: string[] = [];
  const model = { id: "future-codex-model", name: "Future", provider: "openai-codex", api: "openai-codex-responses" };
  const ctx = { sessionManager: {}, model, ui: {
    setStatus: (key: string, text: string | undefined) => { assert.equal(key, "aa-codex-usage"); statuses.push(text); },
    notify: (text: string) => notices.push(text),
    theme: { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text },
  } };
  const emit = async (name: string, event: object = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  const stateDir = join(dir, "tmp", "pi-codex-usage");
  mkdirSync(stateDir, { recursive: true });
  const publish = (data: object) => writeFileSync(join(stateDir, "usage.json"), JSON.stringify({ ...data, owner: "other", claimedAt: Date.now(), updatedAt: Date.now() }));
  publish({ report: { snapshots: [{ limitId: "codex", secondary: { usedPercent: 33 } }] } });
  try {
    codexUsage({
      on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
      registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) { assert.equal(name, "fast"); commands.push(options.handler); },
    } as never);
    assert.equal(commands.length, 0);
    await emit("session_start");
    assert.equal(commands.length, 1);
    const command = commands[0];
    await command("on", ctx);
    assert.equal(notices.pop(), "Usage: /fast");
    await command("", { ...ctx, model: { ...model, provider: "deepseek" } });
    assert.equal(notices.pop(), "Fast mode is not supported for the current provider");
    assert.equal(existsSync(join(dir, "models.json")), false);
    await command("", ctx);
    assert.equal(isFastEnabled(model.id), true);
    assert.equal(statuses.at(-1), "codex 67% fast");
    assert.equal(notices.length, 0);
    const request = handlers.get("before_provider_request")![0];
    assert.deepEqual(request({ payload: { model: model.id } }, ctx), { model: model.id, service_tier: "priority" });
    assert.equal(request({ payload: { model: model.id, service_tier: "flex" } }, ctx), undefined);
    assert.equal(request({ payload: { model: "different" } }, ctx), undefined);
    const other = { ...model, id: "another-future-model" };
    ctx.model = other;
    await emit("model_select", { model: other });
    assert.equal(statuses.at(-1), "codex 67%");
    ctx.model = model;
    await emit("model_select", { model });
    assert.equal(statuses.at(-1), "codex 67% fast");
    for (const [data, expected] of [
      [{ error: "unavailable", unavailable: true }, "codex n/a fast"],
      [{ error: "network failure" }, "codex error fast"],
      [{ report: { snapshots: [], credits: { remainingPercent: 81 } } }, "codex 81% fast"],
      [{ report: { snapshots: [{ limitId: "codex", primary: { usedPercent: 25 }, secondary: { usedPercent: 50 } }] } }, null],
    ] as const) {
      publish(data);
      await emit("model_select", { model });
      await new Promise(resolve => setTimeout(resolve, 180));
      if (expected) assert.equal(statuses.at(-1), expected);
      else assert.match(statuses.at(-1)!, /^codex .+ fast$/);
    }
    publish({});
    await emit("model_select", { model });
    assert.match(statuses.at(-1)!, / fast$/); // Loading also passes through the one terminal boundary.
    await command("", ctx);
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(isFastEnabled(model.id), false);
    assert.doesNotMatch(statuses.at(-1)!, / fast$/);
    assert.equal(request({ payload: { model: model.id } }, ctx), undefined);
    writeFileSync(join(dir, "models.json"), '{ "providers": ');
    await emit("model_select", { model });
    assert.doesNotMatch(statuses.at(-1)!, / fast$/);
    await command("", ctx);
    assert.match(notices.at(-1)!, /^Could not update models\.json:/);
    assert.equal(readFileSync(join(dir, "models.json"), "utf8"), '{ "providers": ');
    assert.equal(fetches, 0);
  } finally {
    await emit("session_shutdown");
    globalThis.fetch = previousFetch;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
