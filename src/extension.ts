import { initialize, AudioTrack, MidiTrack, type ActivationContext } from "@ableton-extensions/sdk";
import * as fs from "fs/promises";
import * as path from "path";

// Path to the bundled UI, resolved relative to this file at runtime.
const interfacePath = path.join(__dirname, "interface.html");

interface TrackData {
  id: string;
  name: string;
  type: "audio" | "midi" | "group";
  groupTrackId: string | null;
}

interface SavedConfig {
  id: string;
  name: string;
  checkedTrackIds: string[];
  trackRenames: Record<string, string>;
}

interface ApplyConfig {
  action?: "apply" | "save";
  checkedTrackIds: string[];
  trackRenames: Record<string, string>;
  configs?: SavedConfig[];
}

// Persists configs across dialog open/close within a single Ableton session.
let persistedConfigs: SavedConfig[] | null = null;

async function readConfigs(storageDir: string): Promise<SavedConfig[]> {
  try {
    const data = await fs.readFile(path.join(storageDir, "configs.json"), "utf8");
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as SavedConfig[];
  } catch {
    // File doesn't exist yet or is malformed — start fresh
  }
  return [];
}

async function writeConfigs(storageDir: string, configs: SavedConfig[]): Promise<void> {
  await fs.mkdir(storageDir, { recursive: true });
  await fs.writeFile(path.join(storageDir, "configs.json"), JSON.stringify(configs, null, 2), "utf8");
}

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");
  const storageDir = context.environment.storageDirectory;

  // Load persisted configs from storage on startup
  if (storageDir) {
    readConfigs(storageDir).then((loaded) => {
      if (loaded.length > 0) persistedConfigs = loaded;
    });
  }

  context.commands.registerCommand("stem-export-helper.showDialog", async () => {
    const song = context.application.song;
    const bundledInterface = await fs.readFile(interfacePath, "utf8");
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

    const tracksJson = JSON.stringify(trackData);
    const payload = JSON.stringify({
      tracks: trackData,
      savedConfigs: persistedConfigs ?? [],
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

      if (Array.isArray(config.configs) && config.configs.length > 0) {
        persistedConfigs = config.configs;
        if (storageDir) {
          writeConfigs(storageDir, config.configs).catch((err) =>
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
