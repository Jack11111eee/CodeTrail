import js from "@eslint/js";
import tseslint from "typescript-eslint";

const TS_FILES = ["src/**/*.{ts,tsx}", "test/**/*.{ts,tsx}"];

// Node's runtime globals for ESM scripts (`scripts/*.mjs`). Without these,
// `no-undef` flags every `process`/`Buffer`/`fetch` reference in the fixture,
// scanner, and toolchain scripts that run directly under Node.
const NODE_GLOBALS = {
  AbortController: "readonly",
  AbortSignal: "readonly",
  Buffer: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  atob: "readonly",
  btoa: "readonly",
  clearImmediate: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  fetch: "readonly",
  global: "readonly",
  globalThis: "readonly",
  process: "readonly",
  queueMicrotask: "readonly",
  setImmediate: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  structuredClone: "readonly",
};

export default tseslint.config(
  {
    ignores: [
      // Generated fixture repositories (`pnpm run fixtures`) contain third-party
      // and deliberately malformed source that is not ours to lint.
      ".tmp/**",
      "**/.tmp/**",
      "coverage/**",
      "dist/**",
      "node_modules/**",
      "*.tgz",
      "pnpm-lock.yaml",
    ],
  },
  js.configs.recommended,
  // Type-checked linting for the TypeScript sources and tests.
  {
    extends: [...tseslint.configs.recommendedTypeChecked],
    files: TS_FILES,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Non-TypeScript files (e.g. this config) can't use type-aware rules.
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  // ESM scripts (`scripts/*.mjs`) run directly under Node with ES module
  // semantics and Node's runtime globals.
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: NODE_GLOBALS,
    },
  },
  // CommonJS scripts (e.g. the install-time environment check) run directly
  // under Node, so they need Node globals and CommonJS module semantics.
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        __dirname: "readonly",
        __filename: "readonly",
        console: "readonly",
        module: "writable",
        process: "readonly",
        require: "readonly",
      },
    },
  },
);
