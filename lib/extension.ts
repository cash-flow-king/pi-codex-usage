/** Domain: extension composition. Owns: provider registration, Fast bridge and status wiring. Excludes: shared command ownership. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFastProvider } from "@llblab/pi-command-fast";
import { applyFastToHeaders, applyFastToRequest, isFastEnabled, isFastEligibleModel, toggleFast } from "./fast.ts";
import { createCodexUsageStatus } from "./status.ts";

export default function codexUsage(pi: ExtensionAPI) {
  let releaseFast: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    releaseFast = registerFastProvider(pi, ctx, {
      provider: "openai-codex",
      toggle(commandCtx) {
        if (!isFastEligibleModel(commandCtx.model)) {
          commandCtx.ui.notify("Fast is not advertised for this Codex model", "warning");
          return;
        }
        toggleFast(commandCtx.model.id);
        status.fastChanged(commandCtx, commandCtx.model);
      },
    });
  });
  pi.on("session_shutdown", () => { releaseFast?.(); releaseFast = undefined; });
  const status = createCodexUsageStatus(pi);
  pi.on("before_provider_headers", (event, ctx) => {
    const model = ctx.model;
    if (!isFastEligibleModel(model)) return;
    applyFastToHeaders(event.headers, model, isFastEnabled(model.id));
  });
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (!isFastEligibleModel(model)) return;
    return applyFastToRequest(event.payload, model.id, isFastEnabled(model.id));
  });
}
