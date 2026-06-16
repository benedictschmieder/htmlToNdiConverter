// Loads configuration from config.json with sensible defaults.
//
// Resolution order for the config file:
//   1. The HTML2NDI_CONFIG environment variable (absolute path), if set.
//   2. config.json next to the packaged executable (process.resourcesPath/..).
//   3. config.json in the project root (development).
//
// The file may describe a single stream or several. All of the following are
// accepted:
//
//   // 1) Single stream (legacy/flat form)
//   { "url": "...", "ndiName": "...", ... }
//
//   // 2) Multiple streams under a "streams" array. Keys outside the array act
//   //    as shared defaults for every stream, plus app-level options.
//   { "disableHardwareAcceleration": true,
//     "streams": [ { "url": "...", "ndiName": "A" }, { "url": "...", "ndiName": "B" } ] }
//
//   // 3) A top-level array of stream objects.
//   [ { "url": "...", "ndiName": "A" }, { "url": "...", "ndiName": "B" } ]

const fs = require("fs");
const path = require("path");

// Per-stream options (each NDI source gets its own values).
const STREAM_DEFAULTS = {
  url: "https://example.com",
  ndiName: "Web2NDI",
  width: 1920,
  height: 1080,
  fps: 60,
  frameRateNumerator: 60000,
  frameRateDenominator: 1000,
  transparent: false,
  reloadOnFailureSeconds: 5,
};

// App-level options (apply to the whole process, not a single stream).
const APP_DEFAULTS = {
  disableHardwareAcceleration: true,
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

// Resolve the config file we should read/watch: the first candidate that
// exists, or the most likely place one should live (next to the packaged exe).
function resolveConfigPath() {
  const candidates = candidatePaths();
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return candidates[candidates.length - 1] || null;
}

function sanitizeStream(raw) {
  const s = { ...STREAM_DEFAULTS, ...raw };
  s.width = Math.max(2, Math.round(Number(s.width) || STREAM_DEFAULTS.width));
  s.height = Math.max(
    2,
    Math.round(Number(s.height) || STREAM_DEFAULTS.height),
  );
  s.fps = Math.min(
    60,
    Math.max(1, Math.round(Number(s.fps) || STREAM_DEFAULTS.fps)),
  );
  s.frameRateNumerator =
    Math.round(Number(s.frameRateNumerator)) ||
    STREAM_DEFAULTS.frameRateNumerator;
  s.frameRateDenominator =
    Math.round(Number(s.frameRateDenominator)) ||
    STREAM_DEFAULTS.frameRateDenominator;
  s.transparent = !!s.transparent;
  s.reloadOnFailureSeconds = Math.max(
    1,
    Math.round(Number(s.reloadOnFailureSeconds) || 5),
  );
  s.url = String(s.url);
  s.ndiName = String(s.ndiName);
  return s;
}

// NDI source names must be unique on the network; suffix any duplicates.
function ensureUniqueNames(streams) {
  const counts = new Map();
  for (const s of streams) {
    const base = s.ndiName;
    if (counts.has(base)) {
      const n = counts.get(base) + 1;
      counts.set(base, n);
      const unique = `${base} ${n}`;
      console.warn(`[config] Duplicate NDI name "${base}" -> "${unique}"`);
      s.ndiName = unique;
    } else {
      counts.set(base, 1);
    }
  }
  return streams;
}

// Read and parse the config file. Throws on JSON parse errors so callers can
// decide whether to keep the previous good config (used on live reload).
function loadConfig() {
  const configPath = resolveConfigPath();
  let raw = {};
  if (configPath && fs.existsSync(configPath)) {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }

  // Split the parsed file into app-level options and the list of stream objects.
  let appOptions;
  let rawStreams;
  if (Array.isArray(raw)) {
    appOptions = {};
    rawStreams = raw;
  } else if (raw && Array.isArray(raw.streams)) {
    const { streams, ...rest } = raw;
    appOptions = rest;
    rawStreams = streams;
  } else {
    // Flat single-stream object: it can also carry app-level keys.
    appOptions = raw || {};
    rawStreams = [raw || {}];
  }

  // Top-level per-stream keys act as shared defaults for every stream.
  const sharedDefaults = {};
  for (const key of Object.keys(STREAM_DEFAULTS)) {
    if (appOptions[key] !== undefined) sharedDefaults[key] = appOptions[key];
  }

  let streams = rawStreams
    .filter((s) => s && typeof s === "object" && !Array.isArray(s))
    .map((s) => sanitizeStream({ ...sharedDefaults, ...s }));

  if (streams.length === 0) {
    streams = [sanitizeStream({ ...sharedDefaults })];
  }

  ensureUniqueNames(streams);

  const disableHardwareAcceleration =
    appOptions.disableHardwareAcceleration !== undefined
      ? !!appOptions.disableHardwareAcceleration
      : APP_DEFAULTS.disableHardwareAcceleration;

  return { configPath, disableHardwareAcceleration, streams };
}

// Per-stream keys that do not make sense as a shared/global default. Each stream
// needs its own URL, and NDI source names must be unique on the network.
const PER_STREAM_ONLY_KEYS = ["url", "ndiName"];

// Keys that may be set as a global default for every stream.
const SHARED_STREAM_KEYS = Object.keys(STREAM_DEFAULTS).filter(
  (k) => !PER_STREAM_ONLY_KEYS.includes(k),
);

// Coerce a raw value to the type implied by STREAM_DEFAULTS for that key.
function coerceField(key, value) {
  const type = typeof STREAM_DEFAULTS[key];
  if (type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === "boolean") return !!value;
  return value === undefined || value === null ? undefined : String(value);
}

// Keep only the known stream keys from a raw object (drops anything the editor
// and app do not understand).
function pickStreamKeys(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const key of Object.keys(STREAM_DEFAULTS)) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

// Read the config file WITHOUT applying defaults, so the editor can distinguish
// values that were explicitly set from values that are merely inherited. The
// result is split into the app option, the explicit global defaults, the raw
// per-stream overrides, and the built-in defaults used for placeholders.
//
// Throws on JSON parse errors so the caller can surface "the current file is
// invalid" rather than silently overwriting it.
function loadRawConfig() {
  const configPath = resolveConfigPath();
  let raw = {};
  if (configPath && fs.existsSync(configPath)) {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }

  let appOptions;
  let rawStreams;
  let globalDefaults = {};
  if (Array.isArray(raw)) {
    appOptions = {};
    rawStreams = raw;
  } else if (raw && Array.isArray(raw.streams)) {
    const { streams, ...rest } = raw;
    appOptions = rest;
    rawStreams = streams;
    globalDefaults = pickStreamKeys(rest);
  } else {
    // Flat single-stream object: it is one stream that may also carry app keys.
    appOptions = raw || {};
    rawStreams = [appOptions];
  }
  // url/ndiName are never global defaults, even in the {streams:[]} form.
  for (const key of PER_STREAM_ONLY_KEYS) delete globalDefaults[key];

  const disableHardwareAcceleration =
    appOptions.disableHardwareAcceleration !== undefined
      ? !!appOptions.disableHardwareAcceleration
      : APP_DEFAULTS.disableHardwareAcceleration;

  const streams = rawStreams
    .filter((s) => s && typeof s === "object" && !Array.isArray(s))
    .map(pickStreamKeys);

  return {
    configPath,
    disableHardwareAcceleration,
    globalDefaults,
    streams,
    builtInDefaults: STREAM_DEFAULTS,
  };
}

// Write a config object in the canonical `{streams:[]}` shape: app option +
// explicit global defaults at the top level, then a streams array where each
// stream carries only url, ndiName, and the fields it overrides. Empty/blank
// values are omitted so they fall back to the global default (or built-in).
function writeConfig(model) {
  const data = model || {};
  const out = {
    disableHardwareAcceleration: !!data.disableHardwareAcceleration,
  };

  const globalDefaults = data.globalDefaults || {};
  for (const key of SHARED_STREAM_KEYS) {
    const value = globalDefaults[key];
    if (value === undefined || value === null || value === "") continue;
    const coerced = coerceField(key, value);
    if (coerced === undefined) continue;
    // A global default equal to the built-in default is a no-op; skip it so the
    // file stays minimal (e.g. global "transparent: off" is never written).
    if (coerced === STREAM_DEFAULTS[key]) continue;
    out[key] = coerced;
  }

  out.streams = (data.streams || []).map((stream) => {
    const s = stream || {};
    const obj = {
      url: String(s.url == null ? "" : s.url),
      ndiName: String(s.ndiName == null ? "" : s.ndiName),
    };
    for (const key of SHARED_STREAM_KEYS) {
      const value = s[key];
      if (value === undefined || value === null || value === "") continue;
      const coerced = coerceField(key, value);
      if (coerced !== undefined) obj[key] = coerced;
    }
    return obj;
  });

  const target = resolveConfigPath();
  fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n", "utf8");
  return target;
}

module.exports = {
  loadConfig,
  loadRawConfig,
  writeConfig,
  resolveConfigPath,
  sanitizeStream,
  STREAM_DEFAULTS,
  APP_DEFAULTS,
  SHARED_STREAM_KEYS,
  PER_STREAM_ONLY_KEYS,
};
