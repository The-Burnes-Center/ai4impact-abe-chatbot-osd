import { defineConfig, configDefaults } from "vitest/config";

// The backend uses vitest only for the websocket-chat Lambda unit tests
// (`npm run test:lambda`). Scope discovery to those files and exclude stray
// agent worktrees under .claude so local runs match CI's clean checkout — under
// vitest 4 the bare positional path is only a filter, not a discovery root.
export default defineConfig({
  test: {
    include: ["lib/chatbot-api/functions/websocket-chat/**/*.test.mjs"],
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
