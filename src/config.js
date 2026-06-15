// Loads configuration from config.json with sensible defaults.
//
// Resolution order for the config file:
//   1. The HTML2NDI_CONFIG environment variable (absolute path), if set.
//   2. config.json next to the packaged executable (process.resourcesPath/..).
//   3. config.json in the project root (development).

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  url: "https://example.com",
  ndiName: "HTML to NDI",
  width: 1920,
  height: 1080,
  fps: 60,
  frameRateNumerator: 60000,
  frameRateDenominator: 1000,
  transparent: false,
  disableHardwareAcceleration: true,
  reloadOnFailureSeconds: 5,
};

function candidatePaths() {
  const paths = [];
  if (process.env.HTML2NDI_CONFIG) {
    paths.push(process.env.HTML2NDI_CONFIG);
  }
  // Packaged: config.json sits next to the .exe (extraResources -> ../config.json).
  if (process.resourcesPath) {
    paths.push(path.join(process.resourcesPath, "..", "config.json"));
    paths.push(path.join(process.resourcesPath, "config.json"));
  }
  // Development: project root.
  paths.push(path.join(__dirname, "..", "config.json"));
  return paths;
}

function loadConfig() {
  let fileConfig = {};
  let loadedPath = null;
  const candidates = candidatePaths();
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        fileConfig = JSON.parse(fs.readFileSync(p, "utf8"));
        loadedPath = p;
        console.log(`[config] Loaded ${p}`);
        break;
      }
    } catch (err) {
      console.error(`[config] Failed to parse ${p}: ${err.message}`);
    }
  }

  const merged = { ...DEFAULTS, ...fileConfig };

  // Clamp / sanitize.
  merged.width = Math.max(2, Math.round(merged.width));
  merged.height = Math.max(2, Math.round(merged.height));
  merged.fps = Math.min(60, Math.max(1, Math.round(merged.fps)));

  // The config file that was actually loaded, or the most likely place one
  // should live (next to the packaged exe), so the UI can open it.
  merged.configPath = loadedPath || candidates[candidates.length - 1] || null;

  return merged;
}

module.exports = loadConfig();
