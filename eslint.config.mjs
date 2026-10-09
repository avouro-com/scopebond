// ESLint for the packages' TypeScript sources and the repository scripts.
//
// The type-aware rules (`recommendedTypeChecked`) catch what the compiler does not:
// floating and misused promises, unsafe `any` flows, awaiting non-promises.
// `eslint-plugin-security` adds the Node injection-style checks (dynamic
// `require`, non-literal `RegExp`, `child_process` with variable input).
//
// CI runs this from `quality.yml` and uploads the result to code scanning, so
// findings appear beside CodeQL's in the Security tab. It reports and does not
// gate yet; once the backlog is clear the job becomes a required check.

import js from "@eslint/js";
import security from "eslint-plugin-security";
import globals from "globals";
import tseslint from "typescript-eslint";

// Two `eslint-plugin-security` rules flag every computed property and every
// variable path (about 1,100 findings here, nearly all intended), so they stay
// off and the rest of the plugin's findings get read.
const signalOnly = {
  "security/detect-object-injection": "off",
  "security/detect-non-literal-fs-filename": "off",
};

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "packages/native/**", "examples/**"],
  },
  {
    files: ["packages/*/src/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked, security.configs.recommended],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      ...signalOnly,
      // `any` hygiene: these fire on every parsed JSON document the packages read
      // (about 1,700 findings), which buries the promise and injection findings.
      // Tighten one package at a time once it narrows its parsed input.
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs", "packages/*/test/**/*.{js,mjs}"],
    extends: [js.configs.recommended, security.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
    rules: signalOnly,
  },
);
