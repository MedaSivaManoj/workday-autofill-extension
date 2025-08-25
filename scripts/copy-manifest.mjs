import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = path.resolve(__dirname, "..");
const src = path.join(root, "manifest.json");
const dest = path.join(root, "dist", "manifest.json");

// Read manifest.json
let manifest = JSON.parse(fs.readFileSync(src, "utf-8"));

// ✅ Fix background path - use actual build output
if (manifest.background?.service_worker === "background/background.js") {
  manifest.background.service_worker = "background.js";
}

// ✅ Fix content script paths - use actual build output
if (Array.isArray(manifest.content_scripts)) {
  manifest.content_scripts.forEach(script => {
    // Add broader URL matching with valid patterns
    if (Array.isArray(script.matches)) {
      script.matches = [
        "*://*.myworkdayjobs.com/*",
        "*://*.workday.com/*",
        "*://*/workday/*"
      ];
    }
    // Add all_frames support
    script.all_frames = true;
    // Fix JS paths
    if (Array.isArray(script.js)) {
      script.js = script.js.map(jsFile =>
        jsFile === "content/content.js" ? "content.js" : jsFile
      );
    }
  });
}// ❌ Remove options_ui if pointing to popup (not needed)
if (manifest.options_ui?.page === "popup/index.html") {
	delete manifest.options_ui;
}

// ✅ Fix popup path - use actual build output
if (manifest.action?.default_popup === "popup/index.html") {
  manifest.action.default_popup = "src/popup/index.html";
}

// Write updated manifest to dist
fs.writeFileSync(dest, JSON.stringify(manifest, null, 2));
console.log("✅ Manifest copied & fixed paths");
