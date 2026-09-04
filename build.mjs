import { build } from "esbuild";
import { rm, mkdir } from "node:fs/promises";

await rm("./dist", { recursive: true, force: true });
await mkdir("./dist", { recursive: true });

await build({
  entryPoints: ["./index.ts"],
  outfile: "./dist/index.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: true,
  packages: "external",
  external: ["better-sqlite3"],
  logLevel: "info",
});