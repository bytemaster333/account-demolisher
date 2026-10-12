import coreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const config = [
  ...coreWebVitals,
  ...nextTypeScript,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "dist/**",
      "out/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "design/**",
      "docs/**",
      // local agent worktrees and internal notes, both gitignored
      ".claude/**",
      "resources/**",
      "next-env.d.ts",
    ],
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // the soroban rpc client rejects with plain { code, message } objects, which
      // this pattern turns into "[object Object]"
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ConditionalExpression[test.type='BinaryExpression'][test.operator='instanceof'][test.right.name='Error'][alternate.type='CallExpression'][alternate.callee.name='String']",
          message: "use errorMessage() from @/lib/errors",
        },
      ],
    },
  },
];

export default config;
