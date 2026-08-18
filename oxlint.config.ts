import { strictRules } from "@2h2d/oxlint-config/strict-rules";
import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["typescript", "unicorn", "oxc"],
  jsPlugins: [
    {
      name: "2h2d",
      specifier: "@2h2d/oxlint-config/plugin",
    },
  ],
  categories: {
    correctness: "error",
  },
  rules: strictRules,
  env: {
    builtin: true,
  },
  options: {
    reportUnusedDisableDirectives: "error",
    typeAware: true,
    typeCheck: true,
  },
});
