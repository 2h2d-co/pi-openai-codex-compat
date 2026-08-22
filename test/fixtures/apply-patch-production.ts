import { PRODUCTION_APPLY_PATCH_FILESYSTEM_FIXTURES } from "./apply-patch-production/apply-patch-production-filesystem-fixtures.ts";
import { PRODUCTION_APPLY_PATCH_PARSER_BOUNDARY_FIXTURES } from "./apply-patch-production/apply-patch-production-parser-boundary-fixtures.ts";
import { PRODUCTION_APPLY_PATCH_STRICT_MISMATCH_FIXTURES } from "./apply-patch-production/apply-patch-production-strict-mismatch-fixtures.ts";
import { PRODUCTION_APPLY_PATCH_FAIL_CLOSED_FIXTURES } from "./apply-patch-production/apply-patch-production-fail-closed-fixtures.ts";
import { PRODUCTION_APPLY_PATCH_MULTI_CHUNK_FIXTURES } from "./apply-patch-production/apply-patch-production-multi-chunk-fixtures.ts";

export type {
  ProductionApplyPatchFixture,
  ProductionFileFixture,
} from "./apply-patch-production/apply-patch-production-contracts.ts";

// Sanitized, minimized fixtures derived from apply_patch calls found in Pi's
// production session corpus. Fingerprints are truncated SHA-256 values of the
// original patches; no session paths, identifiers, or sensitive contents are
// retained here.
export const PRODUCTION_APPLY_PATCH_FIXTURES = [
  ...PRODUCTION_APPLY_PATCH_FILESYSTEM_FIXTURES,
  ...PRODUCTION_APPLY_PATCH_PARSER_BOUNDARY_FIXTURES,
  ...PRODUCTION_APPLY_PATCH_STRICT_MISMATCH_FIXTURES,
  ...PRODUCTION_APPLY_PATCH_FAIL_CLOSED_FIXTURES,
  ...PRODUCTION_APPLY_PATCH_MULTI_CHUNK_FIXTURES,
];
