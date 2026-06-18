import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // Report on all source. The import-side-effecting bundles (main.ts wraps
      // RTCPeerConnection/fetch at import; meet.ts calls main()) cannot run under
      // node, so they surface low here on purpose — their testable logic was
      // extracted into the pure sibling modules (identity, lifecycle,
      // meet-lifecycle) which ARE covered. The number is an honest signal, not a gate.
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text", "html"],
    },
  },
})
