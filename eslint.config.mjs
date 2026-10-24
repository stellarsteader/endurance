import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig, globalIgnores } from "eslint/config";
export default defineConfig([
  globalIgnores(["node_modules/**", "out/**", "release/**", "artifacts/**", "src/harness/vendor/**"]),
  { files: ["**/*.ts", "**/*.tsx"], extends: [js.configs.recommended, ...tseslint.configs.recommended] },
  { files: ["src/**/*.tsx"], plugins: { "react-hooks": reactHooks }, rules: reactHooks.configs.recommended.rules },
]);
