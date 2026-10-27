import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored AI Elements source, copied in by its CLI. Its lint findings (React Compiler
    // rules in shimmer and code-block) are upstream's; fix one here only if we hit it in use.
    "components/ai-elements/**",
  ]),
]);

export default eslintConfig;
