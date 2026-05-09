import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

/** Same default ignores `next lint` used; required when running `eslint .` (Next 16 CLI has no `lint` command). */
const eslintConfig = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      ".turbo/**",
      "coverage/**",
    ],
  },
  ...compat.extends("next/core-web-vitals"),
];

export default eslintConfig;
