import { useState, useRef } from "react";
import "./App.css";

// --- Types ---
interface Config {
  id: string;
  name: string;
  checkedTrackIds: string[];
  trackRenames: Record<string, string>;
}

interface Track {
  id: string;
  name: string;
  type: "audio" | "midi" | "group";
  children?: Track[];
}

// Shape of the JSON injected by extension.ts at runtime
interface TrackData {
  id: string;
  name: string;
  type: "audio" | "midi" | "group";
  groupTrackId: string | null;
}

// Shape of the injected data payload from extension.ts
interface InjectedPayload {
  tracks: TrackData[];
  savedConfigs: Config[];
}

// --- Load tracks from the data tag injected by extension.ts ---
function loadPayload(): InjectedPayload {
  try {
    const el = document.getElementById("__stem-export-helper-data__");
    if (!el) return { tracks: [], savedConfigs: [] };
    const raw = JSON.parse(el.textContent ?? "{}");
    // Support old flat-array format as fallback
    if (Array.isArray(raw)) return { tracks: raw as TrackData[], savedConfigs: [] };
    return raw as InjectedPayload;
  } catch {
    return { tracks: [], savedConfigs: [] };
  }
}

function loadTracks(): Track[] {
  return buildTrackTree(loadPayload().tracks);
}

function buildTrackTree(flat: TrackData[]): Track[] {
  const byId = new Map<string, Track>(
    flat.map((t) => [t.id, { id: t.id, name: t.name, type: t.type }]),
  );
  const roots: Track[] = [];
  for (const t of flat) {
    const node = byId.get(t.id)!;
    if (t.groupTrackId === null) {
      roots.push(node);
    } else {
      const parent = byId.get(t.groupTrackId);
      if (parent) {
        parent.children = parent.children ?? [];
        parent.children.push(node);
      }
    }
  }
  return roots;
}

// --- Helpers ---
function allTrackIds(tracks: Track[]): string[] {
  return tracks.flatMap((t) => [t.id, ...allTrackIds(t.children ?? [])]);
}

function closeWithResult(result: string) {
  const message = { method: "close_and_send", params: [result] };
  const webkit = (window as any).webkit?.messageHandlers?.live;
  const webview2 = (window as any).chrome?.webview;

  if (webkit) {
    webkit.postMessage(message);
    return;
  }

  if (webview2) {
    webview2.postMessage(message);
  }
}

// --- TrackItem component ---
function TrackItem({
  track,
  checked,
  onToggle,
  onRename,
  renames,
  depth = 0,
}: {
  track: Track;
  checked: Set<string>;
  onToggle: (id: string) => void;
  onRename: (id: string, name: string) => void;
  renames: Record<string, string>;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const hasChildren = (track.children?.length ?? 0) > 0;
  const displayName = renames[track.id] ?? track.name;

  function startEdit() {
    setEditValue(displayName);
    setIsEditing(true);
  }

  function commitEdit() {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== (renames[track.id] ?? track.name)) {
      onRename(track.id, trimmed);
    }
    setIsEditing(false);
  }

  return (
    <div>
      <div className="track-row" style={{ paddingLeft: `${8 + depth * 16}px` }}>
        <input
          type="checkbox"
          checked={checked.has(track.id)}
          onChange={() => onToggle(track.id)}
        />
        {hasChildren && (
          <button
            type="button"
            className="track-expand"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "▾" : "▸"}
          </button>
        )}
        {isEditing ? (
          <input
            className="track-name-input"
            value={editValue}
            autoFocus
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit();
              if (e.key === "Escape") setIsEditing(false);
            }}
          />
        ) : (
          <span
            className={`track-name track-type-${track.type}`}
            onDoubleClick={startEdit}
            title="Double-click to rename"
          >
            {displayName}
          </span>
        )}
      </div>
      {hasChildren && expanded &&
        track.children!.map((child) => (
          <TrackItem
            key={child.id}
            track={child}
            checked={checked}
            onToggle={onToggle}
            onRename={onRename}
            renames={renames}
            depth={depth + 1}
          />
        ))
      }
    </div>
  );
}

// Cache payload and tracks once at module load — avoids repeated DOM queries + JSON parses.
const _payload = loadPayload();
const _flatTracks = _payload.tracks;
const _tracks = buildTrackTree(_flatTracks);
const _allIds = allTrackIds(_tracks);
const _savedConfigs = _payload.savedConfigs;

// --- Main App ---
function collectCheckedTracks(list: Track[], ids: Set<string>, result: Track[] = []): Track[] {
  for (const t of list) {
    if (ids.has(t.id)) result.push(t);
    collectCheckedTracks(t.children ?? [], ids, result);
  }
  return result;
}

export function App() {
  const [tracks] = useState<Track[]>(_tracks);
  const [configs, setConfigs] = useState<Config[]>(() => {
    if (_savedConfigs.length > 0) return _savedConfigs;
    return [{ id: "config-1", name: "Default", checkedTrackIds: _allIds, trackRenames: {} }];
  });
  const [selectedConfigId, setSelectedConfigId] = useState<string>(() =>
    _savedConfigs.length > 0 ? _savedConfigs[0].id : "config-1",
  );
  const [configEditId, setConfigEditId] = useState<string | null>(null);
  const [configEditValue, setConfigEditValue] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [checkedTracks, setCheckedTracks] = useState<Set<string>>(() =>
    new Set(_savedConfigs.length > 0 ? _savedConfigs[0].checkedTrackIds : _allIds),
  );
  const [trackRenames, setTrackRenames] = useState<Record<string, string>>(() =>
    _savedConfigs.length > 0 ? _savedConfigs[0].trackRenames : {},
  );

  // Batch rename state
  const [batchPrefix, setBatchPrefix] = useState("");
  const [batchSuffix, setBatchSuffix] = useState("");
  const [batchFind, setBatchFind] = useState("");
  const [batchReplace, setBatchReplace] = useState("");
  const [batchOpen, setBatchOpen] = useState(false);

  // --- Config management ---
  function selectConfig(id: string) {
    setConfigs((prev) =>
      prev.map((c) =>
        c.id === selectedConfigId
          ? { ...c, checkedTrackIds: [...checkedTracks], trackRenames }
          : c,
      ),
    );
    const cfg = configs.find((c) => c.id === id);
    if (cfg) {
      setSelectedConfigId(id);
      setCheckedTracks(new Set(cfg.checkedTrackIds));
      setTrackRenames(cfg.trackRenames);
    }
  }

  function newConfig() {
    const newId = `config-${Date.now()}`;
    const currentName = configs.find((c) => c.id === selectedConfigId)?.name ?? "Config";
    const snapshotChecked = [...checkedTracks];
    const snapshotRenames = { ...trackRenames };
    setConfigs((prev) => {
      const saved = prev.map((c) =>
        c.id === selectedConfigId
          ? { ...c, checkedTrackIds: snapshotChecked, trackRenames: snapshotRenames }
          : c,
      );
      return [
        ...saved,
        {
          id: newId,
          name: `${currentName} copy`,
          checkedTrackIds: snapshotChecked,
          trackRenames: snapshotRenames,
        },
      ];
    });
    setSelectedConfigId(newId);
    // New config starts with the same live state — no reset needed
  }

  function deleteConfig(id: string) {
    if (configs.length <= 1) return;
    const remaining = configs.filter((c) => c.id !== id);
    setConfigs(remaining);
    if (selectedConfigId === id) {
      const first = remaining[0];
      setSelectedConfigId(first.id);
      setCheckedTracks(new Set(first.checkedTrackIds));
      setTrackRenames(first.trackRenames);
    }
  }

  function startConfigRename(id: string, name: string) {
    setConfigEditId(id);
    setConfigEditValue(name);
  }

  function commitConfigRename() {
    if (configEditId && configEditValue.trim()) {
      setConfigs((prev) =>
        prev.map((c) =>
          c.id === configEditId ? { ...c, name: configEditValue.trim() } : c,
        ),
      );
    }
    setConfigEditId(null);
  }

  function saveToFile() {
    const snapshot = configs.map((c) =>
      c.id === selectedConfigId
        ? { ...c, checkedTrackIds: [...checkedTracks], trackRenames }
        : c,
    );
    const json = JSON.stringify(snapshot, null, 2);
    const a = document.createElement("a");
    a.href = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
    a.download = "stem-export-helper-configs.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function loadFromFile(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const loaded = JSON.parse(e.target?.result as string);
        if (
          Array.isArray(loaded) &&
          loaded.length > 0 &&
          loaded.every(
            (c: unknown) =>
              typeof (c as Config).id === "string" &&
              typeof (c as Config).name === "string",
          )
        ) {
          const normalized: Config[] = (loaded as Partial<Config>[]).map((c) => ({
            id: c.id!,
            name: c.name!,
            checkedTrackIds: Array.isArray(c.checkedTrackIds)
              ? c.checkedTrackIds
              : allTrackIds(tracks),
            trackRenames:
              c.trackRenames && typeof c.trackRenames === "object"
                ? (c.trackRenames as Record<string, string>)
                : {},
          }));
          setConfigs(normalized);
          setSelectedConfigId(normalized[0].id);
          setCheckedTracks(new Set(normalized[0].checkedTrackIds));
          setTrackRenames(normalized[0].trackRenames);
        }
      } catch {
        // ignore malformed files
      }
    };
    reader.readAsText(file);
  }

  function toggleTrack(id: string) {
    setCheckedTracks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setCheckedTracks(new Set(_allIds));
  }

  function deselectAll() {
    setCheckedTracks(new Set());
  }

  function renameTrack(id: string, name: string) {
    setTrackRenames((prev) => ({ ...prev, [id]: name }));
  }

  function applyBatchRename() {
    const checked = collectCheckedTracks(tracks, checkedTracks);
    const updates: Record<string, string> = {};
    for (const t of checked) {
      let name = trackRenames[t.id] ?? t.name;
      if (batchFind) name = name.split(batchFind).join(batchReplace);
      if (batchPrefix) name = batchPrefix + name;
      if (batchSuffix) name = name + batchSuffix;
      updates[t.id] = name;
    }
    setTrackRenames((prev) => ({ ...prev, ...updates }));
    setBatchPrefix("");
    setBatchSuffix("");
    setBatchFind("");
    setBatchReplace("");
  }

  return (
    <div className="app-shell">
      <div className="app-header">
        <span className="app-title">Stem Export Helper</span>
      </div>

      <div className="app-body">
        {/* Configs */}
        <section className="section section-jobs">
          <div className="section-label">Configs</div>
          <ul className="job-list">
            {configs.map((cfg) => (
              <li
                key={cfg.id}
                className={`job-item${cfg.id === selectedConfigId ? " job-item--selected" : ""}`}
                onClick={() => selectConfig(cfg.id)}
              >
                {configEditId === cfg.id ? (
                  <input
                    className="config-name-input"
                    value={configEditValue}
                    autoFocus
                    onChange={(e) => setConfigEditValue(e.target.value)}
                    onBlur={commitConfigRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitConfigRename();
                      if (e.key === "Escape") setConfigEditId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className="config-item-name"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      startConfigRename(cfg.id, cfg.name);
                    }}
                  >
                    {cfg.name}
                  </span>
                )}
                {configs.length > 1 && (
                  <button
                    type="button"
                    className="config-delete"
                    onClick={(e) => { e.stopPropagation(); deleteConfig(cfg.id); }}
                    title="Delete config"
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="config-toolbar">
            <button type="button" className="btn-ghost config-toolbar-btn config-toolbar-new" onClick={newConfig}>
              + New Config
            </button>
            <div className="config-toolbar-row">
              <button
                type="button"
                className="btn-ghost config-toolbar-btn"
                title="Load configs from file"
                onClick={() => fileInputRef.current?.click()}
              >
                Load
              </button>
              <button
                type="button"
                className="btn-ghost config-toolbar-btn"
                title="Save all configs to file"
                onClick={saveToFile}
              >
                Save
              </button>
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) loadFromFile(file);
              e.target.value = "";
            }}
          />
        </section>

        {/* Tracks */}
        <section className="section section-tracks">
          <div className="section-header-row">
            <div className="section-label">Tracks</div>
            <div className="track-select-actions">
              <span className="track-select-label">Select:</span>
              <button type="button" className="btn-ghost btn-xs" onClick={selectAll}>All</button>
              <button type="button" className="btn-ghost btn-xs" onClick={deselectAll}>None</button>
            </div>
          </div>
          <div className="track-list">
            {tracks.length === 0 ? (
              <p className="tracks-empty">No tracks found.</p>
            ) : (
              tracks.map((track) => (
                <TrackItem
                  key={track.id}
                  track={track}
                  checked={checkedTracks}
                  onToggle={toggleTrack}
                  onRename={renameTrack}
                  renames={trackRenames}
                />
              ))
            )}
          </div>
        </section>
      </div>

      {/* Batch Settings */}
      <section className={`section section-settings${batchOpen ? " is-open" : ""}`}>
        <button
          type="button"
          className="section-label section-accordion-trigger"
          aria-expanded={batchOpen}
          onClick={() => setBatchOpen((o) => !o)}
        >
          <span className="accordion-chevron" aria-hidden="true">{batchOpen ? "▾" : "▸"}</span>
          <span>Batch Rename</span>
        </button>
        <div className="settings-panel accordion-body">
          <p className="track-settings-hint">Double-click any track name to rename it inline.</p>
          <div className="batch-rename">
            <div className="batch-rename-label">Batch rename checked tracks</div>
            <div className="settings-grid">
              <label className="field">
                <span className="field-label">Find</span>
                <input className="field-input" type="text" value={batchFind} placeholder="text to find"
                  onChange={(e) => setBatchFind(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">Replace</span>
                <input className="field-input" type="text" value={batchReplace} placeholder="replace with"
                  onChange={(e) => setBatchReplace(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">Prefix</span>
                <input className="field-input" type="text" value={batchPrefix} placeholder="add before"
                  onChange={(e) => setBatchPrefix(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">Suffix</span>
                <input className="field-input" type="text" value={batchSuffix} placeholder="add after"
                  onChange={(e) => setBatchSuffix(e.target.value)} />
              </label>
            </div>
            <div className="batch-rename-footer">
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={!batchFind && !batchPrefix && !batchSuffix}
                onClick={applyBatchRename}
              >
                Apply to {checkedTracks.size} track{checkedTracks.size !== 1 ? "s" : ""}
              </button>
            </div>
          </div>
        </div>
      </section>

      <div className="app-footer">
        <p className="footer-hint">
          <span className="footer-hint-icon" aria-hidden="true">ℹ</span>
          After applying, use{" "}
          <strong>File &gt; Export Audio/Video</strong> to render the master
          mix or individual stems.
        </p>
        <div className="footer-actions">
          <button type="button" className="btn-ghost btn-sm" onClick={() => closeWithResult("cancel")}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => {
              const snapshot = configs.map((c) =>
                c.id === selectedConfigId
                  ? { ...c, checkedTrackIds: [...checkedTracks], trackRenames }
                  : c,
              );
              closeWithResult(JSON.stringify({ action: "save", configs: snapshot }));
            }}
          >
            Save
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={checkedTracks.size === 0}
            onClick={() => {
              const snapshot = configs.map((c) =>
                c.id === selectedConfigId
                  ? { ...c, checkedTrackIds: [...checkedTracks], trackRenames }
                  : c,
              );
              const payload = JSON.stringify({
                action: "apply",
                checkedTrackIds: [...checkedTracks],
                trackRenames,
                configs: snapshot,
              });
              closeWithResult(payload);
            }}
          >
            Apply to Live Set
          </button>
        </div>
      </div>
    </div>
  );
}
