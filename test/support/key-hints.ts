import { keyHint, keyText, type KeybindingHints } from "@earendil-works/pi-coding-agent";

/** The key formatters Pi injects into render contexts, reading the installed keybindings. */
export const keyHints: KeybindingHints = { keyText, keyHint };
