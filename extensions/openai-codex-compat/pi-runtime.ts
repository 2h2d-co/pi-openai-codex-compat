/**
 * Every transcript API this extension imports as a value from
 * `@earendil-works/pi-ai`. Pi's extension loader turns a missing named import
 * into `undefined` rather than a load error, so an older host fails at first use
 * unless the surface is checked up front. Keep this list equal to the value
 * imports in `codex-provider/codex-provider-runtime.ts`, `compaction-checkpoint.ts`,
 * and `vendor/pi-ai/openai-responses-serialization.ts`.
 */
export const TRANSCRIPT_APIS = [
  "getCurrentTools",
  "getDeclaredTools",
  "getInitialSystemMessage",
  "getSystemMessageText",
  "normalizeContext",
  "renderSystemMessageUpdate",
  "resolveTranscript",
  "resolveTranscriptTools",
] as const;

/**
 * Every session API this extension imports as a value from
 * `@earendil-works/pi-coding-agent`. Keep this list equal to the value imports
 * in `compaction-checkpoint.ts`.
 */
export const SESSION_APIS = ["buildSessionProjection"] as const;

/**
 * Host APIs that first shipped in Pi 0.99: the footer's `SessionManager.getEntryCount()`
 * and the extension API's `getSettings()`. They prove the loaded runtime is 0.99 even when
 * `PI_PACKAGE_DIR` points package metadata at another installation.
 */
export const PI_099_APIS = ["SessionManager.getEntryCount", "ExtensionAPI.getSettings"] as const;

export const MINIMUM_PI_VERSION = "0.99.1";
export const REQUIRED_PI = `Pi ${MINIMUM_PI_VERSION} or later`;

function isFunction(value: unknown): boolean {
  return typeof value === "function";
}

function prototypeMethod(value: unknown, name: string): unknown {
  if (typeof value !== "function") return undefined;
  const prototype: unknown = value.prototype;
  return typeof prototype === "object" && prototype !== null
    ? Reflect.get(prototype, name)
    : undefined;
}

/** Compare dotted numeric release versions; prerelease suffixes rank below their release. */
export function atLeastVersion(version: unknown, minimum: string): boolean {
  if (typeof version !== "string") return false;
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version);
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
  const required = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const left = actual[index] ?? 0;
    const right = required[index] ?? 0;
    if (left !== right) return left > right;
  }
  return match[4] === undefined;
}

/**
 * Require the Pi 0.99 host surface and a reported version of at least 0.99.1. The version comes
 * from package metadata, so the API checks also run to catch an older executable whose
 * `PI_PACKAGE_DIR` names a newer package.
 */
export function requirePiRuntime(
  transcriptApi: Record<string, unknown>,
  sessionApi: Record<string, unknown>,
  extensionApi: { readonly getSettings?: unknown },
): void {
  const missing = [
    ...TRANSCRIPT_APIS.filter((name) => !isFunction(transcriptApi[name])),
    ...SESSION_APIS.filter((name) => !isFunction(sessionApi[name])),
    ...(isFunction(prototypeMethod(sessionApi["SessionManager"], "getEntryCount"))
      ? []
      : ["SessionManager.getEntryCount"]),
    ...(isFunction(extensionApi.getSettings) ? [] : ["ExtensionAPI.getSettings"]),
  ];
  const version = sessionApi["VERSION"];
  const problems = [
    ...(missing.length > 0 ? [`Missing host APIs: ${missing.join(", ")}.`] : []),
    ...(atLeastVersion(version, MINIMUM_PI_VERSION)
      ? []
      : [
          `The host reports Pi ${typeof version === "string" ? version : "with no version"}, below ${MINIMUM_PI_VERSION}.`,
        ]),
  ];
  if (problems.length > 0) {
    throw new Error(
      `pi-openai-codex-compat requires a running ${REQUIRED_PI} runtime. ` +
        `${problems.join(" ")} ` +
        `Exit Pi and start ${REQUIRED_PI} after updating. /reload cannot upgrade the running ` +
        "runtime, and PI_PACKAGE_DIR can make an older executable report a newer version.",
    );
  }
}
