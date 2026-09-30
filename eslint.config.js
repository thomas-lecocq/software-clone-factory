import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", "**/out/**", "**/dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: { "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }] },
  },
  { files: ["*.js"], ...tseslint.configs.disableTypeChecked },
);
