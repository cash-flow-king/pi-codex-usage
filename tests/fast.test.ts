import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "jsonc-parser";
import { applyFastToRequest, isFastEnabled, isFastEligibleModel, toggleFast } from "../lib/fast.ts";

function fixture(run: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "pi-codex-fast-"));
  try { run(join(dir, "models.json")); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("/fast creates only the selected override and removes its property on the second toggle", () => fixture((path) => {
  assert.equal(isFastEnabled("gpt-5.5", path), false);
  assert.equal(toggleFast("gpt-5.5", path), true);
  assert.equal(isFastEnabled("gpt-5.5", path), true);
  assert.equal(isFastEnabled("gpt-5.4", path), false);
  assert.equal(parse(readFileSync(path, "utf8")).providers["openai-codex"].modelOverrides["gpt-5.5"].serviceTier, "priority");
  assert.equal(toggleFast("gpt-5.5", path), false);
  assert.equal(isFastEnabled("gpt-5.5", path), false);
  assert.equal(Object.hasOwn(parse(readFileSync(path, "utf8")).providers["openai-codex"].modelOverrides["gpt-5.5"], "serviceTier"), false);
}));

test("/fast retains JSONC comments, trailing comma, other providers and existing model settings", () => fixture((path) => {
  const source = '{\n  // keep me\n  "providers": {\n    "elsewhere": { "models": [{"id":"x"}] },\n    "openai-codex": { "modelOverrides": { "gpt-5.5": { "reasoning": true, "contextWindow": 200000, }, "gpt-5.4": { "serviceTier": "priority" } } },\n  },\n}\n';
  writeFileSync(path, source);
  toggleFast("gpt-5.5", path);
  const enabled = readFileSync(path, "utf8");
  assert.match(enabled, /\/\/ keep me/);
  assert.equal(parse(enabled).providers.elsewhere.models[0].id, "x");
  assert.equal(parse(enabled).providers["openai-codex"].modelOverrides["gpt-5.5"].contextWindow, 200000);
  assert.equal(parse(enabled).providers["openai-codex"].modelOverrides["gpt-5.4"].serviceTier, "priority");
  toggleFast("gpt-5.5", path);
  const disabled = readFileSync(path, "utf8");
  assert.match(disabled, /\/\/ keep me/);
  assert.deepEqual(parse(disabled).providers["openai-codex"].modelOverrides["gpt-5.5"], { reasoning: true, contextWindow: 200000 });
}));

test("BOM and comments survive a targeted toggle", () => fixture((path) => {
  writeFileSync(path, '\uFEFF{\n  // private note\n  "providers": {}\n}\n');
  toggleFast("gpt-5.5", path);
  assert.equal(isFastEnabled("gpt-5.5", path), true);
  assert.match(readFileSync(path, "utf8"), /^\uFEFF\{\n  \/\/ private note/);
}));

test("malformed models.json is neither overwritten nor treated as enabled", () => fixture((path) => {
  writeFileSync(path, '{ "providers": ');
  assert.equal(isFastEnabled("gpt-5.5", path), false);
  assert.throws(() => toggleFast("gpt-5.5", path), /Invalid models.json/);
  assert.equal(readFileSync(path, "utf8"), '{ "providers": ');
}));

test("Codex Fast capability is provider-level, including arbitrary future models", () => {
  const model = { provider: "openai-codex", id: "future-codex-model" };
  assert.equal(isFastEligibleModel(model as never), true);
  assert.equal(isFastEligibleModel({ ...model, provider: "deepseek" } as never), false);
  assert.equal(isFastEligibleModel(undefined), false);
});

test("request decoration is limited to an enabled, matching model and does not mutate inputs", () => {
  const body = { model: "gpt-5.5", input: [{ text: "secret" }] };
  assert.equal(applyFastToRequest(body, "gpt-5.5", false), undefined);
  assert.equal(applyFastToRequest({ model: "gpt-5.4" }, "gpt-5.5", true), undefined);
  assert.equal(applyFastToRequest({ ...body, service_tier: "default" }, "gpt-5.5", true), undefined);
  assert.deepEqual(applyFastToRequest(body, "gpt-5.5", true), { ...body, service_tier: "priority" });
  assert.equal(Object.hasOwn(body, "service_tier"), false);
});
