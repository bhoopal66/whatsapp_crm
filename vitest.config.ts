import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Dummy secrets — encryption.ts / webhook-signature.ts read these
    // at module load. Tests never hit a real Meta/Supabase service, so
    // any 32-byte hex / non-empty string will do; keep them lexically
    // identical to the CI build env so behaviour matches.
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test_app_secret",
      // Calling from the CRM is off unless this is `on`
      // (lib/pbx/outbound.ts). The dial tests run with it on; the off
      // case is stubbed per test.
      NEXT_PUBLIC_PBX_OUTBOUND_CALLS: "on",
    },
    clearMocks: true,
  },
});
