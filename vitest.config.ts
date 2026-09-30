import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["harness/test/**/*.test.ts", "targets/*/test/**/*.test.ts"] },
});
