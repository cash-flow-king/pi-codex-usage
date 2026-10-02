/** Domain: Codex Fast. Owns: provider semantics and wire adaptation. Excludes: command arbitration and JSONC editing. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isModelOverrideValue, toggleModelOverrideValue } from "@llblab/pi-command-fast";
import { isOpenAICodexModel } from "./usage.ts";

const target = (id: string) => ({ provider: "openai-codex", id, property: "serviceTier", enabledValue: "priority" });

export function isFastEligibleModel(model: ExtensionContext["model"]): model is NonNullable<ExtensionContext["model"]> {
  return !!model && isOpenAICodexModel(model);
}
export function isFastEnabled(modelId: string, path?: string): boolean {
  return isModelOverrideValue(target(modelId), path);
}
export function toggleFast(modelId: string, path?: string): boolean {
  return toggleModelOverrideValue(target(modelId), path);
}

export function applyFastToRequest(payload: unknown, modelId: string, enabled: boolean): unknown {
  if (!enabled || !payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const body = payload as Record<string, unknown>;
  if (body.model !== modelId || "service_tier" in body) return undefined;
  return { ...body, service_tier: "priority" };
}
