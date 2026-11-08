import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "mcp-server/dist/**",
      "claude-plugin/**",
      "**/__pycache__/**",
      "**/evals/results/**",
      "node_modules/**"
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Audited, SHA-bound development helpers retain their frozen source bytes.
    // They have separate strict TypeScript and offline effect checks.
    files: [
      "tests/skill-classification/live-bootstrap/bootstrap.mts",
      "tests/skill-classification/live-bootstrap/contract-selfcheck.mts"
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off"
    }
  },
  {
    // The frozen helper reports a fixed ledger error without private causes.
    files: ["tests/skill-classification/live-bootstrap/bootstrap.mts"],
    rules: {
      "preserve-caught-error": "off"
    }
  },
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
  },
  {
    files: ["skills/evaluation-validity-auditor/scripts/check-repository.mjs"],
    rules: {
      "no-empty": "off"
    }
  }
);
