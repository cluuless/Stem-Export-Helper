import { useState, useRef } from "react";
import "./App.css";

// --- Types ---
interface Config {
  id: string;
  name: string;
  checkedTrackIds: string[];
  trackRenames: Record<string, string>;
  staleTrackNames: string[];
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
  sessions: Record<string, Config[]>; // sessionName → saved configs
  currentSession: string;
}

// --- Load tracks from the data tag injected by extension.ts ---
function loadPayload(): InjectedPayload {
  try {
    const el = document.getElementById("__stem-export-helper-data__");
    if (!el) return { tracks: [], sessions: {}, currentSession: "" };
    const raw = JSON.parse(el.textContent ?? "{}");
    if (Array.isArray(raw)) return { tracks: raw as TrackData[], sessions: {}, currentSession: "" };
    return raw as InjectedPayload;
  } catch {
    return { tracks: [], sessions: {}, currentSession: "" };
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
const _sessions = _payload.sessions ?? {};
const _currentSession = _payload.currentSession ?? "";
const _initialConfigs: Config[] = _sessions[_currentSession] ?? [];

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
    if (_initialConfigs.length > 0) return _initialConfigs;
    return [{ id: "config-1", name: "Default", checkedTrackIds: _allIds, trackRenames: {}, staleTrackNames: [] }];
  });
  const [selectedConfigId, setSelectedConfigId] = useState<string>(() =>
    _initialConfigs.length > 0 ? _initialConfigs[0].id : "config-1",
  );
  const [configEditId, setConfigEditId] = useState<string | null>(null);
  const [configEditValue, setConfigEditValue] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [checkedTracks, setCheckedTracks] = useState<Set<string>>(() =>
    new Set(_initialConfigs.length > 0 ? _initialConfigs[0].checkedTrackIds : _allIds),
  );
  const [trackRenames, setTrackRenames] = useState<Record<string, string>>(() =>
    _initialConfigs.length > 0 ? _initialConfigs[0].trackRenames : {},
  );
  const [staleTrackNames, setStaleTrackNames] = useState<string[]>(() =>
    _initialConfigs.length > 0 ? (_initialConfigs[0].staleTrackNames ?? []) : [],
  );
  const [sessionName, setSessionName] = useState(_currentSession);

  // Batch rename state
  const [batchPrefix, setBatchPrefix] = useState("");
  const [batchSuffix, setBatchSuffix] = useState("");
  const [batchFind, setBatchFind] = useState("");
  const [batchReplace, setBatchReplace] = useState("");
  const [batchRegex, setBatchRegex] = useState(false);
  const [batchRegexError, setBatchRegexError] = useState("");
  const [batchOpen, setBatchOpen] = useState(false);

  // --- Config management ---
  function selectConfig(id: string) {
    setConfigs((prev) =>
      prev.map((c) =>
        c.id === selectedConfigId
          ? { ...c, checkedTrackIds: [...checkedTracks], trackRenames, staleTrackNames }
          : c,
      ),
    );
    const cfg = configs.find((c) => c.id === id);
    if (cfg) {
      setSelectedConfigId(id);
      setCheckedTracks(new Set(cfg.checkedTrackIds));
      setTrackRenames(cfg.trackRenames);
      setStaleTrackNames(cfg.staleTrackNames ?? []);
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
          ? { ...c, checkedTrackIds: snapshotChecked, trackRenames: snapshotRenames, staleTrackNames }
          : c,
      );
      return [
        ...saved,
        {
          id: newId,
          name: `${currentName} copy`,
          checkedTrackIds: snapshotChecked,
          trackRenames: snapshotRenames,
          staleTrackNames: [],
        },
      ];
    });
    setSelectedConfigId(newId);
    setStaleTrackNames([]);
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
      setStaleTrackNames(first.staleTrackNames ?? []);
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
            staleTrackNames: Array.isArray(c.staleTrackNames) ? c.staleTrackNames : [],
          }));
          setConfigs(normalized);
          setSelectedConfigId(normalized[0].id);
          setCheckedTracks(new Set(normalized[0].checkedTrackIds));
          setTrackRenames(normalized[0].trackRenames);
          setStaleTrackNames(normalized[0].staleTrackNames);
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

  function removeStaleTrack(name: string) {
    setStaleTrackNames((prev) => prev.filter((n) => n !== name));
  }

  function remapStaleTrack(staleName: string, newTrackId: string) {
    if (!newTrackId) return;
    // Update all configs: swap stale name out of checkedTrackIds and staleTrackNames
    setConfigs((prev) =>
      prev.map((c) => {
        const alreadyChecked = c.checkedTrackIds.includes(newTrackId);
        return {
          ...c,
          checkedTrackIds: alreadyChecked
            ? c.checkedTrackIds
            : [...c.checkedTrackIds, newTrackId],
          staleTrackNames: (c.staleTrackNames ?? []).filter((n) => n !== staleName),
        };
      }),
    );
    // Also update live state for the currently selected config
    setCheckedTracks((prev) => {
      const next = new Set(prev);
      next.add(newTrackId);
      return next;
    });
    setStaleTrackNames((prev) => prev.filter((n) => n !== staleName));
  }

  function handleSessionChange(name: string) {
    setSessionName(name);
    const saved = _sessions[name];
    if (saved && saved.length > 0) {
      setConfigs(saved);
      setSelectedConfigId(saved[0].id);
      setCheckedTracks(new Set(saved[0].checkedTrackIds));
      setTrackRenames(saved[0].trackRenames);
      setStaleTrackNames(saved[0].staleTrackNames ?? []);
    }
  }

  function applyBatchRename() {
    let regex: RegExp | null = null;
    if (batchFind && batchRegex) {
      try {
        regex = new RegExp(batchFind, "g");
        setBatchRegexError("");
      } catch {
        setBatchRegexError("Invalid regex");
        return;
      }
    }

    const checked = collectCheckedTracks(tracks, checkedTracks);
    const updates: Record<string, string> = {};
    for (const t of checked) {
      let name = trackRenames[t.id] ?? t.name;
      if (batchFind) {
        name = regex
          ? name.replace(regex, batchReplace)
          : name.split(batchFind).join(batchReplace);
      }
      if (batchPrefix) name = batchPrefix + name;
      if (batchSuffix) name = name + batchSuffix;
      updates[t.id] = name;
    }
    setTrackRenames((prev) => ({ ...prev, ...updates }));
    setBatchPrefix("");
    setBatchSuffix("");
    setBatchFind("");
    setBatchReplace("");
    setBatchRegexError("");
  }

  return (
    <div className="app-shell">
      <div className="app-header">
        <span className="app-title">Stem Export Helper</span>
      </div>

      <div className="session-bar">
        <label className="session-label" htmlFor="session-input">Session</label>
        <input
          id="session-input"
          className="session-input"
          type="text"
          list="session-list"
          value={sessionName}
          placeholder="Required — Name this session to save configs."
          onChange={(e) => handleSessionChange(e.target.value)}
        />
        <datalist id="session-list">
          {Object.keys(_sessions).map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
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
          </div>
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
          {staleTrackNames.length > 0 && (
            <div className="stale-warning">
              <div className="stale-warning-header">
                ⚠ {staleTrackNames.length} saved track{staleTrackNames.length !== 1 ? "s" : ""} not found in this session
              </div>
              {staleTrackNames.map((name) => (
                <div key={name} className="stale-track-row">
                  <span className="stale-track-name">"{name}"</span>
                  <div className="stale-track-actions">
                    <select
                      className="stale-remap-select"
                      defaultValue=""
                      onChange={(e) => { if (e.target.value) remapStaleTrack(name, e.target.value); }}
                    >
                      <option value="">Remap to…</option>
                      {_flatTracks.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn-ghost btn-xs"
                      onClick={() => removeStaleTrack(name)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
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
                <input className="field-input" type="text" value={batchFind} placeholder={batchRegex ? "regex pattern" : "text to find"}
                  onChange={(e) => { setBatchFind(e.target.value); setBatchRegexError(""); }} />
              </label>
              <label className="field">
                <span className="field-label">Replace</span>
                <input className="field-input" type="text" value={batchReplace} placeholder={batchRegex ? "replacement (use $1, $2…)" : "replace with"}
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
              <label className="batch-regex-toggle">
                <input type="checkbox" checked={batchRegex} onChange={(e) => { setBatchRegex(e.target.checked); setBatchRegexError(""); }} />
                <span>Regex</span>
              </label>
              {batchRegexError && <span className="batch-regex-error">{batchRegexError}</span>}
            </div>
            {batchRegex && (
              <div className="batch-regex-hints">
                <span className="batch-regex-hints-label">Common patterns:</span>
                {([
                  { label: "Remove numbers", find: "\\d+", replace: "" },
                  { label: "Remove leading numbers", find: "^\\d+\\s*", replace: "" },
                  { label: "Remove trailing numbers", find: "\\s*\\d+$", replace: "" },
                  { label: "Remove parentheses", find: "\\s*\\([^)]*\\)", replace: "" },
                  { label: "Trim spaces", find: "^\\s+|\\s+$", replace: "" },
                  { label: "Collapse spaces", find: "\\s+", replace: " " },
                ] as { label: string; find: string; replace: string }[]).map((h) => (
                  <button
                    key={h.label}
                    type="button"
                    className="batch-regex-hint-btn"
                    onClick={() => { setBatchFind(h.find); setBatchReplace(h.replace); setBatchRegexError(""); }}
                  >
                    {h.label}
                  </button>
                ))}
              </div>
            )}
            <div className="batch-rename-apply">
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
            disabled={!sessionName.trim()}
            onClick={() => {
              const snapshot = configs.map((c) =>
                c.id === selectedConfigId
                  ? { ...c, checkedTrackIds: [...checkedTracks], trackRenames, staleTrackNames }
                  : c,
              );
              closeWithResult(JSON.stringify({ action: "save", sessionName, configs: snapshot }));
            }}
          >
            Save
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={checkedTracks.size === 0 || !sessionName.trim()}
            onClick={() => {
              const snapshot = configs.map((c) =>
                c.id === selectedConfigId
                  ? { ...c, checkedTrackIds: [...checkedTracks], trackRenames, staleTrackNames }
                  : c,
              );
              const payload = JSON.stringify({
                action: "apply",
                sessionName,
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
