// Injected by esbuild's `define` at build time (see build.mjs). Under vitest
// these are NOT defined, so every read site must guard with `typeof`.
declare const __APP_VERSION__: string
declare const __BUILD_COMMIT__: string
