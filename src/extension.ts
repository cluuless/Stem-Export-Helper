import { initialize, AudioTrack, MidiTrack, type ActivationContext } from "@ableton-extensions/sdk";
import * as fs from "fs";
import * as path from "path";



// Path to the bundled UI, resolved relative to this file at runtime.
const interfacePath = path.join(__dirname, "interface.html");
const IS_WINDOWS = process.platform === "win32";
/** Current extension version — update on each release. */
const EXTENSION_VERSION = "1.1.1";
const VERSION_FILE = ".extension-version";

// Set at runtime via `initPaths()`.
let TEMP_DIR = "";
let STORAGE_DIR = "";
let VENV_DIR = "";

interface TrackData {
  id: string;
  name: string;
  type: "audio" | "midi" | "group";
  groupTrackId: string | null;
}

interface SavedConfig {
  id: string;
  name: string;
  checkedTrackNames: string[];
  trackRenames: Record<string, string>; // originalName → newName
}

interface UiConfig {
  id: string;
  name: string;
  checkedTrackIds: string[];
  trackRenames: Record<string, string>; // handleId → newName
  staleTrackNames: string[];
}

interface ApplyConfig {
  action?: "apply" | "save";
  sessionName?: string;
  checkedTrackIds: string[];
  trackRenames: Record<string, string>;
  configs?: UiConfig[];
}

interface SessionStore {
  [sessionKey: string]: {
    configs: SavedConfig[];
  };
}

// In-memory caches to avoid disk reads on every dialog open.
let sessionStore: SessionStore | null = null;
/** Last-used session name within this Ableton run. */
let persistedSessionKey: string | null = null;
let persistedConfigs: SavedConfig[] | null = null;

function savedToUi(saved: SavedConfig[], tracks: TrackData[]): UiConfig[] {
  const nameToId = new Map(tracks.map((t) => [t.name, t.id]));
  return saved.map((cfg) => {
    const checkedTrackIds: string[] = [];
    const staleTrackNames: string[] = [];
    for (const name of (cfg.checkedTrackNames ?? [])) {
      const id = nameToId.get(name);
      if (id) checkedTrackIds.push(id);
      else staleTrackNames.push(name);
    }
    const trackRenames: Record<string, string> = {};
    for (const [name, newName] of Object.entries(cfg.trackRenames)) {
      const id = nameToId.get(name);
      if (id) trackRenames[id] = newName;
    }
    return { id: cfg.id, name: cfg.name, checkedTrackIds, trackRenames, staleTrackNames };
  });
}

function uiToSaved(ui: UiConfig[], tracks: TrackData[]): SavedConfig[] {
  const idToName = new Map(tracks.map((t) => [t.id, t.name]));
  return ui.map((cfg) => {
    const checkedTrackNames = cfg.checkedTrackIds
      .map((id) => idToName.get(id))
      .filter((n): n is string => n !== undefined);
    const trackRenames: Record<string, string> = {};
    for (const [id, newName] of Object.entries(cfg.trackRenames)) {
      const name = idToName.get(id);
      if (name) trackRenames[name] = newName;
    }
    return { id: cfg.id, name: cfg.name, checkedTrackNames, trackRenames };
  });
}

async function readSessionStore(storageDir: string): Promise<SessionStore> {
  try {
    const data = await fs.promises.readFile(path.join(storageDir, "sessions.json"), "utf8");
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as SessionStore;
  } catch {
    // File doesn't exist yet or is malformed — start fresh
  }
  return {};
}

async function writeSessionStore(storageDir: string, store: SessionStore): Promise<void> {
  await fs.promises.mkdir(storageDir, { recursive: true });
  await fs.promises.writeFile(path.join(storageDir, "sessions.json"), JSON.stringify(store, null, 2), "utf8");
}

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");
  let pathsReady = false;
  let storageDir = context.environment.storageDirectory;
  let tempDir = context.environment.tempDirectory;
  try {
    if (storageDir && tempDir) {
      initPaths(storageDir, tempDir);
      checkStorageVersion();
      pathsReady = true;
      console.log("[Stem Export Helper] Paths initialized:", JSON.stringify(getPaths(), null, 2));
    } else {
      // Fall back to OS temp directories if SDK doesn't provide them.
      const os = require("node:os") as typeof import("node:os");
      const fallbackStorage = path.join(os.tmpdir(), "ableton-stem-export-helper-storage");
      const fallbackTemp = path.join(os.tmpdir(), "ableton-stem-export-helper-temp");
      console.warn(`[Stem Export Helper] SDK directories not available (storage=${storageDir}, temp=${tempDir}). Using fallback: ${fallbackStorage}`);
      initPaths(fallbackStorage, fallbackTemp);
      storageDir = fallbackStorage;
      tempDir = fallbackTemp;
      checkStorageVersion();
      pathsReady = true;
    }
  } catch (err) {
    console.error("[Stem Export Helper] Failed to init paths:", err);
  }

  // Load session store from disk on startup
  if (pathsReady && storageDir) {
    readSessionStore(storageDir).then((store) => {
      sessionStore = store;
    });
  }

  context.commands.registerCommand("stem-export-helper.showDialog", async () => {
    const song = context.application.song;
    const bundledInterface = await fs.promises.readFile(interfacePath, "utf8");
    const trackData: TrackData[] = song.tracks.map((track) => ({
      id: track.handle.id.toString(),
      name: track.name,
      type:
        track instanceof AudioTrack
          ? "audio"
          : track instanceof MidiTrack
            ? "midi"
            : "group",
      groupTrackId: track.groupTrack ? track.groupTrack.handle.id.toString() : null,
    }));

    // Convert all saved sessions to UI format so the user can switch between them.
    const allSessions: Record<string, UiConfig[]> = {};
    for (const [key, entry] of Object.entries(sessionStore ?? {})) {
      allSessions[key] = savedToUi(entry.configs, trackData);
    }
    const payload = JSON.stringify({
      tracks: trackData,
      sessions: allSessions,
      currentSession: persistedSessionKey ?? "",
    });
    const htmlWithData = bundledInterface.replace(
      "__STEM_EXPORTER_TRACKS__",
      payload,
    );
    const url = `data:text/html,${encodeURIComponent(htmlWithData)}`;
    context.ui.showModalDialog(url, 680, 480).then((result) => {
      if (result === "cancel") return;

      let config: ApplyConfig;
      try {
        config = JSON.parse(result) as ApplyConfig;
      } catch {
        console.error("[Stem Export Helper] Failed to parse config:", result);
        return;
      }

      if (Array.isArray(config.configs) && config.configs.length > 0 && config.sessionName) {
        const toSave = uiToSaved(config.configs, trackData);
        persistedConfigs = toSave;
        persistedSessionKey = config.sessionName;
        if (storageDir) {
          if (!sessionStore) sessionStore = {};
          sessionStore[config.sessionName] = { configs: toSave };
          writeSessionStore(storageDir, sessionStore).catch((err) =>
            console.error("[Stem Export Helper] Failed to save configs:", err),
          );
        }
      }

      // Save-only: persist configs without applying to the Live Set
      if (config.action === "save") return;

      const checkedIds = new Set(config.checkedTrackIds);
      const tracks = song.tracks;

      context.withinTransaction(() => {
        for (const track of tracks) {
          const id = track.handle.id.toString();

          // Apply rename if provided
          if (config.trackRenames[id]) {
            track.name = config.trackRenames[id];
          }

          // Mute tracks not in the checked set, unmute those that are
          track.mute = !checkedIds.has(id);
        }
      });

      const activeNames = tracks
        .filter((t) => checkedIds.has(t.handle.id.toString()))
        .map((t) => config.trackRenames[t.handle.id.toString()] ?? t.name);

      const renamedCount = Object.keys(config.trackRenames).length;
      console.log(`[Stem Export Helper] Applied.`);
      if (renamedCount > 0) {
        console.log(`  Renamed ${renamedCount} track(s).`);
      }
      console.log(`  Active (unmuted) tracks: ${activeNames.join(", ")}`);
      console.log(`  Use File > Export Audio/Video (Cmd+Shift+R / Ctrl+Shift+R) to export.`);
    });
  });

  context.ui.registerContextMenuAction(
    "AudioTrack.ArrangementSelection",
    "Stem Export Helper",
    "stem-export-helper.showDialog",
  );

  context.ui.registerContextMenuAction(
    "MidiTrack.ArrangementSelection",
    "Stem Export Helper",
    "stem-export-helper.showDialog",
  );
}

/**
 * Must be called once at activation with the SDK-provided directories.
 */
export function initPaths(storageDir: string, tempDir: string) {
  STORAGE_DIR = storageDir;
  TEMP_DIR = tempDir;
  VENV_DIR = path.join(storageDir, ".venv");
  const scriptsDir = path.join(VENV_DIR, IS_WINDOWS ? "Scripts" : "bin");
}

/** Returns the resolved paths for debugging. */
export function getPaths() {
  return { VENV_DIR, STORAGE_DIR, TEMP_DIR };
}

/**
 * Checks the stored version in STORAGE_DIR.
 * If no version file exists (pre-1.1.1 install), wipes the storage folder
 * so everything can be reinstalled cleanly. Writes the current version afterward.
 */
export function checkStorageVersion(): void {
  const versionFilePath = path.join(STORAGE_DIR, VERSION_FILE);
  let existingVersion: string | null = null;

  try {
    if (fs.existsSync(versionFilePath)) {
      existingVersion = fs.readFileSync(versionFilePath, "utf-8").trim();
    }
  } catch {
    existingVersion = null;
  }

  if (!existingVersion) {
    // No version file — legacy install from before 1.1.1. Wipe everything.
    console.log("[Stem Export Helper] No version file found — clearing storage for clean reinstall.");
    try {
      fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
      fs.mkdirSync(STORAGE_DIR, { recursive: true });
    } catch (err) {
      console.error("[Stem Export Helper] Failed to clear storage directory:", err);
    }
    // Re-init paths since UV_BIN may have been set from a now-deleted dir
    initPaths(STORAGE_DIR, TEMP_DIR);
  }

  // Write current version.
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    fs.writeFileSync(versionFilePath, EXTENSION_VERSION, "utf-8");
  } catch (err) {
    console.error("[Stem Export Helper] Failed to write version file:", err);
  }
}