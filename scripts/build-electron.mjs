import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");
const watch = process.argv.includes("--watch");

const mainOpts = {
  entryPoints: [path.join(root, "src/main/main.ts")],
  bundle: true,
  platform: "node",
  target: ["node20"],
  format: "cjs",
  outfile: path.join(root, "dist-electron/main.cjs"),
  external: ["electron", "better-sqlite3", "ffmpeg-static"],
  logLevel: "info",
};

const preloadOpts = {
  entryPoints: [path.join(root, "src/preload/preload.ts")],
  bundle: true,
  platform: "node",
  target: ["node20"],
  format: "cjs",
  outfile: path.join(root, "dist-electron/preload.cjs"),
  external: ["electron"],
  logLevel: "info",
};

if (watch) {
  const mainCtx = await esbuild.context(mainOpts);
  const preloadCtx = await esbuild.context(preloadOpts);
  await Promise.all([mainCtx.watch(), preloadCtx.watch()]);
  console.log(
    "[build-electron] watch ativo — após alterar o main/preload, reinicie o Electron."
  );
} else {
  await esbuild.build(mainOpts);
  await esbuild.build(preloadOpts);
}
