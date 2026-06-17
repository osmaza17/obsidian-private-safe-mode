import esbuild from "esbuild";
import builtins from "builtin-modules";

const production = process.argv.includes("production");

const ctx = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  // Everything below is provided by Obsidian/Electron at runtime.
  external: [
    "obsidian",
    "electron",
    ...builtins,
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  minify: production,
  outfile: "main.js",
});

if (production) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
