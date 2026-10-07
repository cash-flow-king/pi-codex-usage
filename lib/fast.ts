/** Domain: Codex Fast. Owns: provider semantics and wire adaptation. Excludes: command arbitration and JSONC editing. */
import { isModelOverrideValue, toggleModelOverrideValue } from "@llblab/pi-command-fast";

/** Codex model catalog snapshot, 2026-10-07. Unknown models are not presumed Fast-capable.
 * Auto-review is excluded: Codex suppresses service tiers for guardian requests.
 */
export const CODEX_FAST_MODEL_IDS: ReadonlySet<string> = new Set([
  "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
]);
type CodexModel = { provider: string; id: string };
type MutableHeaders = Record<string, string | null>;

const target = (id: string) => ({ provider: "openai-codex", id, property: "serviceTier", enabledValue: "priority" });

export function isFastEligibleModel<T extends CodexModel>(model: T | undefined): model is T {
  return !!model && model.provider === "openai-codex" && CODEX_FAST_MODEL_IDS.has(model.id);
}
export function isFastEnabled(modelId: string, path?: string): boolean {
  return isModelOverrideValue(target(modelId), path);
}
export function toggleFast(modelId: string, path?: string): boolean {
  return toggleModelOverrideValue(target(modelId), path);
}

/**
 * Best-effort header hook: in Pi 1.0.4 the header event precedes the payload
 * event, provides the selected model rather than actual request model, and can
 * be stale on reused WebSocket connections. See README for limitations.
 */
export function applyFastToHeaders(headers: MutableHeaders, model: CodexModel | undefined, enabled: boolean): void {
  if (!enabled || !isFastEligibleModel(model)) return;
  headers["x-codex-routing-hint"] = `model=${model.id};tier=priority`;
}

/** A deliberate Fast choice overrides an earlier default/flex tier for matching requests. */
export function applyFastToRequest(payload: unknown, modelId: string, enabled: boolean): unknown {
  if (!enabled || !CODEX_FAST_MODEL_IDS.has(modelId) || !payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const body = payload as Record<string, unknown>;
  if (body.model !== modelId || body.service_tier === "priority") return undefined;
  return { ...body, service_tier: "priority" };
}
