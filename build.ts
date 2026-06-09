import * as esbuild from "esbuild";
import * as fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const production = process.argv.includes("--production");

const uiTemplatePath = "ui/interface.html";
const generatedUiPath = "ui/generated-interface.html";

function escapeInlineScript(code: string): string {
  return code.replace(/<\/script/gi, "<\\/script");
}

function escapeInlineStyle(code: string): string {
  return code.replace(/<\/style/gi, "<\\/style");
}

const uiBuild = await esbuild.build({
  entryPoints: ["ui/main.tsx"],
  bundle: true,
  write: false,
  outdir: "ui/.inline-build",
  platform: "browser",
  format: "iife",
  minify: production,
  sourcemap: false,
  loader: { ".css": "css" },
  logLevel: "info",
  define: {
    // Always use React's production build — eliminates ~800KB of dev-only warnings/devtools.
    "process.env.NODE_ENV": '"production"',
  },
});

const bundledJs = uiBuild.outputFiles.find((file) => file.path.endsWith(".js"));
if (!bundledJs) {
  throw new Error("UI build did not produce a JavaScript bundle.");
}

const bundledCss = uiBuild.outputFiles
  .filter((file) => file.path.endsWith(".css"))
  .map((file) => file.text)
  .join("\n");

const uiTemplate = fs.readFileSync(uiTemplatePath, "utf8");
const generatedUi = uiTemplate
  .replace(
    "<!-- __INLINE_CSS__ -->",
    `<style>${escapeInlineStyle(bundledCss)}</style>`,
  )
  .replace(
    "<!-- __INLINE_JS__ -->",
    `<script>${escapeInlineScript(bundledJs.text)}</script>`,
  );

fs.writeFileSync(generatedUiPath, generatedUi);

// Copy the interface HTML to dist/ so it can be read at runtime
if (!fs.existsSync("dist")) fs.mkdirSync("dist");
fs.copyFileSync(generatedUiPath, "dist/interface.html");

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcesContent: false,
  logLevel: "info",
  minify: production,
  sourcemap: !production,
});
