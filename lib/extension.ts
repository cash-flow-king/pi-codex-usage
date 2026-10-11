/** Domain: extension composition. Owns: provider registration, Fast bridge and status wiring. Excludes: shared command ownership. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFastProvider } from "@llblab/pi-command-fast";
import { applyFastToRequest, isFastEnabled, isFastEligibleModel, toggleFast } from "./fast.ts";
import { createCodexUsageStatus } from "./status.ts";
import { OPENAI_USAGE_PROVIDERS } from "./usage.ts";

export default function codexUsage(pi: ExtensionAPI) {
  let releaseFast: Array<() => void> = [];
  pi.on("session_start", (_event, ctx) => {
    for (const provider of OPENAI_USAGE_PROVIDERS) {
      releaseFast.push(registerFastProvider(pi, ctx, {
        provider,
        toggle(commandCtx) {
          toggleFast(commandCtx.model!);
          status.fastChanged(commandCtx, commandCtx.model!);
        },
      }));
    }
  });
  pi.on("session_shutdown", () => { releaseFast.forEach((release) => release()); releaseFast = []; });
  const status = createCodexUsageStatus(pi);
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (!isFastEligibleModel(model)) return;
    return applyFastToRequest(event.payload, model.id, isFastEnabled(model));
  });
}
