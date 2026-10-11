/** Domain: Codex Fast. Owns: provider semantics and wire adaptation. Excludes: command arbitration and JSONC editing. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isModelOverrideValue, toggleModelOverrideValue } from "@llblab/pi-command-fast";
import { isOpenAICodexModel } from "./usage.ts";

type FastModel = Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">;
const target = (model: FastModel) => ({ provider: model.provider, id: model.id, property: "serviceTier", enabledValue: "priority" });

export function isFastEligibleModel(model: ExtensionContext["model"]): model is NonNullable<ExtensionContext["model"]> {
  return !!model && isOpenAICodexModel(model);
}
export function isFastEnabled(model: FastModel, path?: string): boolean {
  return isModelOverrideValue(target(model), path);
}
export function toggleFast(model: FastModel, path?: string): boolean {
  return toggleModelOverrideValue(target(model), path);
}

export function applyFastToRequest(payload: unknown, modelId: string, enabled: boolean): unknown {
  if (!enabled || !payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const body = payload as Record<string, unknown>;
  if (body.model !== modelId || "service_tier" in body) return undefined;
  return { ...body, service_tier: "priority" };
}
