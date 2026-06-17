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
    // Modulos de CodeMirror 6 que Obsidian provee en runtime. DEBEN ser externos: si se
    // empaquetan, la extension de editor usaria una instancia distinta de CM6 a la del editor de
    // Obsidian y las decoraciones no aplicarian.
    "@codemirror/view",
    "@codemirror/state",
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
