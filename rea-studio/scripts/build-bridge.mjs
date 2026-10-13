import { build } from "esbuild";
await build({
  entryPoints: ["bridge/main.ts"],
  outfile: "src-tauri/resources/bridge.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
