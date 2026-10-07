import assert from "node:assert/strict";
import { test } from "node:test";
import { applyFastToHeaders, applyFastToRequest, isFastEligibleModel } from "../lib/fast.ts";

const m = (id: string, provider = "openai-codex") => ({ id, provider });

test("catalog: regular priority models eligible, guardian and unsupported models rejected", () => {
  for (const id of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"])
    assert.equal(isFastEligibleModel(m(id)), true, id);
  for (const id of ["gpt-daybreak-blue-latest", "gpt-daybreak-red-latest", "codex-auto-review", "future-codex-model"])
    assert.equal(isFastEligibleModel(m(id)), false, id);
  assert.equal(isFastEligibleModel(m("gpt-6.1-sol", "openai")), false);
  assert.equal(isFastEligibleModel(undefined), false);
});

test("enabled tier and routing hint agree even with an existing default or flex body tier", () => {
  const model = m("gpt-6.1-sol");
  const headers = { "x-other": "untouched" };
  applyFastToHeaders(headers, model, true);
  assert.deepEqual(headers, {
    "x-other": "untouched", "x-codex-routing-hint": "model=gpt-6.1-sol;tier=priority",
  });
  for (const previous of [undefined, "default", "flex", null]) {
    const payload = { model: model.id, ...(previous === undefined ? {} : { service_tier: previous }), input: [] };
    const next = applyFastToRequest(payload, model.id, true);
    assert.deepEqual(next, { ...payload, service_tier: "priority" });
    assert.deepEqual(payload, { model: model.id, ...(previous === undefined ? {} : { service_tier: previous }), input: [] });
  }
  assert.equal(applyFastToRequest({ model: model.id, service_tier: "priority" }, model.id, true), undefined);
});

test("OFF, wrong model, unsupported model, and non-Codex provider never force Fast", () => {
  const supported = m("gpt-6-astra");
  const headers: Record<string, string | null> = {};
  applyFastToHeaders(headers, supported, false);
  applyFastToHeaders(headers, m("gpt-daybreak-blue-latest"), true);
  applyFastToHeaders(headers, m("gpt-6-astra", "other"), true);
  assert.deepEqual(headers, {});
  assert.equal(applyFastToRequest({ model: supported.id }, supported.id, false), undefined);
  assert.equal(applyFastToRequest({ model: "gpt-5.5" }, supported.id, true), undefined);
  assert.equal(applyFastToRequest({ model: "future-codex-model" }, "future-codex-model", true), undefined);
  assert.equal(applyFastToRequest([], supported.id, true), undefined);
  assert.equal(applyFastToRequest(null, supported.id, true), undefined);
});
