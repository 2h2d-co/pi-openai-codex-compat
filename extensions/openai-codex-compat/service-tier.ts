import type { Usage } from "@earendil-works/pi-ai";
import type { CodexCompatConfig, Speed } from "./config.ts";

// Ultrafast costs 6 times the Standard rate. GPT-6.2 models cost 3 times the Standard rate through
// February 28, 2027, Pacific time.
const GPT_6_2_ULTRAFAST_LIST_PRICE_FROM = Date.parse("2027-03-01T00:00:00-08:00");

/** The service tiers this extension requests for the Fast and Ultrafast speeds. */
export const SPEED_SERVICE_TIERS = ["priority", "ultrafast"] as const;

export type SpeedServiceTier = (typeof SPEED_SERVICE_TIERS)[number];

export function isSpeedServiceTier(value: unknown): value is SpeedServiceTier {
  return SPEED_SERVICE_TIERS.some((tier) => tier === value);
}

/** The service tier a speed asks for. Standard asks for none. */
export function speedServiceTier(speed: Speed): SpeedServiceTier | undefined {
  if (speed === "fast") return "priority";
  if (speed === "ultrafast") return "ultrafast";
  return undefined;
}

/**
 * Whether the account's plan includes a tier for a model, from the tiers its model catalog lists
 * for the model. Like the Codex CLI without a fetched catalog, an unknown model keeps Fast, and
 * Ultrafast needs the catalog to list it.
 */
export function serviceTierAvailable(
  tier: SpeedServiceTier,
  catalogTiers: ReadonlySet<string> | undefined,
): boolean {
  return catalogTiers === undefined ? tier === "priority" : catalogTiers.has(tier);
}

/** The configured speed of a model: its `speedByModel` entry, or else the default speed. */
export function modelSpeed(
  config: Pick<CodexCompatConfig, "speed" | "speedByModel">,
  modelId: string,
): Speed {
  return Object.hasOwn(config.speedByModel, modelId)
    ? (config.speedByModel[modelId] ?? config.speed)
    : config.speed;
}

/** The service tier that the configured speed of a model asks for. */
export function configServiceTier(
  config: Pick<CodexCompatConfig, "speed" | "speedByModel">,
  modelId: string,
): SpeedServiceTier | undefined {
  return speedServiceTier(modelSpeed(config, modelId));
}

/** The service tier that requests to a model use: the configured one if the plan includes it. */
export function effectiveServiceTier(
  config: Pick<CodexCompatConfig, "speed" | "speedByModel">,
  modelId: string,
  catalogTiers: ReadonlySet<string> | undefined,
): SpeedServiceTier | undefined {
  const tier = configServiceTier(config, modelId);
  return tier !== undefined && serviceTierAvailable(tier, catalogTiers) ? tier : undefined;
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
