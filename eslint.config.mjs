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
      // standalone Node QA seeders (testnet), not part of the app build
      "scripts/**",
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
  {
    // files that still carry the pattern, each owned by another part of the
    // remediation. remove a file from this list once it uses errorMessage().
    files: [
      "src/app/demolish/_lib/signing-bundle.ts",
      "src/app/api/mediator/_shared/http.ts",
      "src/lib/plan/simulator.ts",
      "src/lib/plan/hydration.ts",
      "src/lib/multisig/plan-client.ts",
      "src/lib/adapters/aquarius/concentrated.ts",
      "src/lib/adapters/aquarius/pools.ts",
      "src/lib/adapters/blend/client.ts",
      "src/lib/adapters/positions/direct.ts",
      "src/lib/mediator/pending-flow.ts",
    ],
    rules: { "no-restricted-syntax": "off" },
  },
];

export default config;
