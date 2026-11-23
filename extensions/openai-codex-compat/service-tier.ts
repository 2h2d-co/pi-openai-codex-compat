import type { Usage } from "@earendil-works/pi-ai";
import type { Speed } from "./config.ts";

/**
 * Models that the Ultrafast speed sends through the ultrafast service tier. Codex accepts the tier
 * for any model and silently serves Standard speed when the account's plan does not include
 * Ultrafast for that model.
 */
const ULTRAFAST_MODEL_IDS: ReadonlySet<string> = new Set(["gpt-6.2-sol"]);

// Ultrafast costs 6 times the Standard rate. GPT-6.2 models cost 3 times the Standard rate through
// February 28, 2027, Pacific time.
const GPT_6_2_ULTRAFAST_LIST_PRICE_FROM = Date.parse("2027-03-01T00:00:00-08:00");

/** The service tiers this extension requests for the Fast and Ultrafast speeds. */
export const SPEED_SERVICE_TIERS = ["priority", "ultrafast"] as const;

export type SpeedServiceTier = (typeof SPEED_SERVICE_TIERS)[number];

export function supportsUltrafast(modelId: string): boolean {
  return ULTRAFAST_MODEL_IDS.has(modelId);
}

/**
 * The service tier a speed requests on a model. Standard requests no tier. Like the Codex CLI,
 * Ultrafast on a model without Ultrafast requests no tier either.
 */
export function speedServiceTier(speed: Speed, modelId: string): SpeedServiceTier | undefined {
  if (speed === "fast") return "priority";
  if (speed === "ultrafast" && supportsUltrafast(modelId)) return "ultrafast";
  return undefined;
}

/** The multiple of the Standard rate that a request in `tier` started at `timestamp` costs. */
export function serviceTierCostMultiplier(
  modelId: string,
  tier: unknown,
  timestamp: number,
): number {
  switch (tier) {
    case "flex":
      return 0.5;
    case "priority":
      return modelId === "gpt-5.5" ? 2.5 : 2;
    case "ultrafast":
      return modelId.startsWith("gpt-6.2-") && timestamp < GPT_6_2_ULTRAFAST_LIST_PRICE_FROM
        ? 3
        : 6;
    default:
      return 1;
  }
}

/** Multiply Standard-rate costs that Pi AI's `calculateCost` filled in. */
export function applyCostMultiplier(usage: Usage, multiplier: number): void {
  if (multiplier === 1) return;
  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
