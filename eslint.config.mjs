import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Each game is a self-contained app with its own toolchain and is
    // typechecked by `tsc --noEmit` from its own directory.
    "games/**",
    // Generated: game bundles and the game registry.
    "public/g/**",
    "src/lib/games.generated.ts",
  ]),
]);

export default eslintConfig;
