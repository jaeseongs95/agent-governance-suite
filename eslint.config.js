import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "mcp-server/dist/**",
      "**/__pycache__/**",
      "**/evals/results/**",
      "node_modules/**"
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        structuredClone: "readonly",
        URL: "readonly"
      }
    }
  },
  {
    files: ["skills/**/*.mjs", "tests/**/*.node*.mjs"],
    rules: {
      "preserve-caught-error": "off",
      "no-useless-assignment": "off",
      "no-control-regex": "off",
      "no-useless-escape": "off",
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }]
    }
  }
);
