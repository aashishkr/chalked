import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import DrawingTab, { TabActions } from "./DrawingTab";
import WelcomeTab, { RecentFile } from "./WelcomeTab";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { appDataDir } from "@tauri-apps/api/path";
import { writeTextFile, readTextFile, exists, mkdir } from "@tauri-apps/plugin-fs";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { logger } from "./logger";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Tab {
  id: string;
  title: string;
  filePath?: string;   // undefined = unsaved
  tempPath?: string;   // auto-save path for unsaved tabs
  isDirty: boolean;
  type: "welcome" | "drawing";
}

interface SessionTab {
  title: string;
  filePath?: string;
  tempPath?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _seq = 0;
function uid() { return `tab-${Date.now()}-${++_seq}`; }

function newTab(opts: Partial<Tab> = {}): Tab {
  const type = opts.type ?? "drawing";
  return {
    id: opts.id ?? uid(),
    title: opts.title ?? (type === "welcome" ? "Welcome" : (opts.filePath ? opts.filePath.split("/").pop()! : "Untitled")),
    filePath: opts.filePath,
    tempPath: opts.tempPath,
    isDirty: false,
    type,
    ...opts,
  };
}

const MAX_RECENTS = 12;

function addToRecents(prev: RecentFile[], filePath: string, title: string): RecentFile[] {
  const entry: RecentFile = { path: filePath, title, openedAt: Date.now() };
  const filtered = prev.filter((r) => r.path !== filePath);
  return [entry, ...filtered].slice(0, MAX_RECENTS);
}

// ─── Unsaved Changes Modal ────────────────────────────────────────────────────

function UnsavedDialog({
  title,
  onSave,
  onDiscard,
  onCancel,
}: {
  title: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onSave();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onSave, onCancel]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Unsaved Changes</h3>
        <p>
          Save changes to <strong>{title}</strong>?
        </p>
        <div className="modal-actions">
          <button className="modal-btn primary" onClick={onSave} autoFocus>
            Save
          </button>
          <button className="modal-btn danger" onClick={onDiscard}>
            Don't Save
          </button>
          <button className="modal-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  // Start with the welcome tab; session restore may replace it with drawing tabs
  const [tabs, setTabs] = useState<Tab[]>([newTab({ type: "welcome" })]);
  const [activeId, setActiveId] = useState<string>(tabs[0].id);
  const [dialog, setDialog] = useState<null | {
    title: string;
    onSave: () => void;
    onDiscard: () => void;
    onCancel: () => void;
  }>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);

  const tabsRef = useRef<Tab[]>(tabs);
  tabsRef.current = tabs;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const appDirRef = useRef("");
  const saveCallbacks = useRef<Map<string, () => Promise<void>>>(new Map());
  const tabActionsRef = useRef<Map<string, TabActions>>(new Map());
  const recentFilesRef = useRef<RecentFile[]>(recentFiles);
  recentFilesRef.current = recentFiles;

  // ── Init: resolve app dir + restore session + load recents ────────────────
  useEffect(() => {
    (async () => {
      try {
        const dir = await appDataDir();
        const tempDir = dir + "/temp";
        appDirRef.current = dir;

        logger.init(dir);
        logger.info("App started", { appDataDir: dir });

        if (!(await exists(dir))) await mkdir(dir, { recursive: true });
        if (!(await exists(tempDir))) await mkdir(tempDir, { recursive: true });

        // Load recents
        const recentsPath = dir + "/recents.json";
        if (await exists(recentsPath)) {
          try {
            const raw = await readTextFile(recentsPath);
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) setRecentFiles(parsed);
          } catch { /* ignore malformed recents */ }
        }

        // Restore session — if session exists, replace the welcome tab with real tabs
        const sessionPath = dir + "/session.json";
        if (await exists(sessionPath)) {
          const raw = await readTextFile(sessionPath);
          const saved: SessionTab[] = JSON.parse(raw);
          if (Array.isArray(saved) && saved.length > 0) {
            const restored = saved.map((s) =>
              newTab({ title: s.title, filePath: s.filePath, tempPath: s.tempPath, type: "drawing" })
            );
            setTabs(restored);
            setActiveId(restored[0].id);
            logger.info("Session restored", { tabCount: restored.length });
          }
        }
      } catch (e) {
        logger.error("Session restore failed", e);
      }
    })();
  }, []);

  // ── Persist session (only drawing tabs) whenever tabs change ─────────────
  useEffect(() => {
    if (!appDirRef.current) return;
    const timer = setTimeout(async () => {
      try {
        const data: SessionTab[] = tabsRef.current
          .filter((t) => t.type === "drawing")
          .map((t) => ({ title: t.title, filePath: t.filePath, tempPath: t.tempPath }));
        await writeTextFile(appDirRef.current + "/session.json", JSON.stringify(data));
      } catch (e) {
        logger.error("Session write failed", e);
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [tabs]);

  // ── Persist recents whenever they change ──────────────────────────────────
  useEffect(() => {
    if (!appDirRef.current || recentFiles.length === 0) return;
    const timer = setTimeout(async () => {
      try {
        await writeTextFile(
          appDirRef.current + "/recents.json",
          JSON.stringify(recentFiles)
        );
      } catch (e) {
        logger.error("Recents write failed", e);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [recentFiles]);

  // ── Unsaved-changes prompt ────────────────────────────────────────────────
  function askUnsaved(tabTitle: string): Promise<"save" | "discard" | "cancel"> {
    return new Promise((resolve) => {
      setDialog({
        title: tabTitle,
        onSave: () => { setDialog(null); resolve("save"); },
        onDiscard: () => { setDialog(null); resolve("discard"); },
        onCancel: () => { setDialog(null); resolve("cancel"); },
      });
    });
  }

  // ── Window close: check all dirty tabs ───────────────────────────────────
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let closing = false;

    win
      .onCloseRequested(async (event) => {
        if (closing) return;
        event.preventDefault();

        const dirty = tabsRef.current.filter((t) => t.type === "drawing" && t.isDirty);
        for (const tab of dirty) {
          const r = await askUnsaved(tab.title);
          if (r === "cancel") return;
          if (r === "save") await saveCallbacks.current.get(tab.id)?.();
        }

        closing = true;
        await win.close();
      })
      .then((fn) => { unlisten = fn; });

    return () => unlisten?.();
  }, []);

  // ── Tab management ────────────────────────────────────────────────────────
  const addTab = useCallback(
    (opts: Partial<Tab> = {}) => {
      const tab = newTab({ ...opts, type: opts.type ?? "drawing" });
      setTabs((prev) => [...prev, tab]);
      setActiveId(tab.id);
      return tab.id;
    },
    []
  );

  const requestClose = useCallback(async (id: string) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (!tab) return;

    if (tab.type === "drawing" && tab.isDirty) {
      const r = await askUnsaved(tab.title);
      if (r === "cancel") return;
      if (r === "save") await saveCallbacks.current.get(id)?.();
    }

    saveCallbacks.current.delete(id);
    tabActionsRef.current.delete(id);
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (!next.length) {
        const fresh = newTab({ type: "drawing" });
        setActiveId(fresh.id);
        return [fresh];
      }
      if (activeIdRef.current === id) setActiveId(next.at(-1)!.id);
      return next;
    });
  }, []);

  const patchTab = useCallback((id: string, patch: Partial<Tab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  // ── Inline rename ─────────────────────────────────────────────────────────
  const startRename = (id: string, current: string) => {
    setRenamingId(id);
    setRenameVal(current);
  };

  const commitRename = () => {
    if (renamingId && renameVal.trim()) patchTab(renamingId, { title: renameVal.trim() });
    setRenamingId(null);
  };

  // ── Welcome tab actions ───────────────────────────────────────────────────

  const handleWelcomeNewDrawing = useCallback(() => {
    addTab({ type: "drawing" });
  }, [addTab]);

  const handleWelcomeOpenFile = useCallback(async () => {
    const selected = await openFilePicker({
      title: "Open Drawing",
      multiple: false,
      filters: [{ name: "Excalidraw", extensions: ["excalidraw"] }],
    });
    if (!selected || Array.isArray(selected)) return;
    const path = selected as string;
    const title = path.split("/").pop()!;
    addTab({ filePath: path, title, type: "drawing" });
    setRecentFiles((prev) => addToRecents(prev, path, title));
  }, [addTab]);

  const handleWelcomeOpenRecent = useCallback(
    (path: string, title: string) => {
      addTab({ filePath: path, title, type: "drawing" });
      setRecentFiles((prev) => addToRecents(prev, path, title));
    },
    [addTab]
  );

  // ── Stable per-tab callbacks ──────────────────────────────────────────────
  const tabCallbacks = useMemo(() => {
    const map: Record<string, {
      onDirtyChange: (d: boolean) => void;
      onSaved: (title: string, fp?: string) => void;
      onTempPath: (tp: string) => void;
      onOpenNewTab: (fp?: string, title?: string, tp?: string) => void;
      onRegisterSave: (fn: () => Promise<void>) => void;
      onRegisterActions: (actions: TabActions) => void;
    }> = {};
    for (const tab of tabsRef.current) {
      const id = tab.id;
      map[id] = {
        onDirtyChange: (d) => patchTab(id, { isDirty: d }),
        onSaved: (title, fp) => {
          patchTab(id, { title, filePath: fp, isDirty: false });
          if (fp) setRecentFiles((prev) => addToRecents(prev, fp, title));
        },
        onTempPath: (tp) => patchTab(id, { tempPath: tp }),
        onOpenNewTab: (fp, title, tp) => addTab({ filePath: fp, title, tempPath: tp }),
        onRegisterSave: (fn) => saveCallbacks.current.set(id, fn),
        onRegisterActions: (actions) => tabActionsRef.current.set(id, actions),
      };
    }
    return map;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.map((t) => t.id).join(","), patchTab, addTab]);

  // ── Derived state ─────────────────────────────────────────────────────────
  const activeTab = tabs.find((t) => t.id === activeId);
  const isWelcomeActive = activeTab?.type === "welcome";

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* Unsaved-changes modal */}
      {dialog && <UnsavedDialog {...dialog} />}

      {/* Tab bar */}
      <div className="tab-bar">
        <div className="tab-bar-tabs">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab ${tab.id === activeId ? "active" : ""}${tab.type === "welcome" ? " tab-welcome" : ""}`}
              onClick={() => setActiveId(tab.id)}
              title={
                tab.type === "welcome"
                  ? "Welcome"
                  : tab.filePath
                  ? `${tab.filePath}${tab.isDirty ? " (unsaved)" : ""}`
                  : tab.title
              }
            >
              {renamingId === tab.id ? (
                <input
                  className="tab-rename-input"
                  value={renameVal}
                  autoFocus
                  onChange={(e) => setRenameVal(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span
                  className="tab-title"
                  onDoubleClick={(e) => {
                    if (tab.type === "welcome") return;
                    e.stopPropagation();
                    startRename(tab.id, tab.title);
                  }}
                  title={tab.type !== "welcome" ? "Double-click to rename" : undefined}
                >
                  {tab.type === "welcome" ? "🏠 Welcome" : tab.isDirty ? `• ${tab.title}` : tab.title}
                </span>
              )}
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  requestClose(tab.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button className="tab-new" onClick={() => addTab()} title="New drawing (⌘T)">
            +
          </button>
        </div>
      </div>

      {/* Toolbar — hidden when welcome tab is active */}
      {!isWelcomeActive && (
        <div className="toolbar">
          <button
            className="toolbar-btn"
            onClick={() => tabActionsRef.current.get(activeId)?.save()}
            title="Save (⌘S)"
          >
            Save
          </button>
          <button
            className="toolbar-btn"
            onClick={() => tabActionsRef.current.get(activeId)?.saveAs()}
            title="Save As (⌘⇧S)"
          >
            Save As
          </button>
          <div className="toolbar-sep" />
          <button
            className="toolbar-btn"
            onClick={() => tabActionsRef.current.get(activeId)?.open()}
            title="Open (⌘O)"
          >
            Open
          </button>
          <button
            className="toolbar-btn"
            onClick={() => tabActionsRef.current.get(activeId)?.openInNewTab()}
            title="Open in new tab (⌘⇧O)"
          >
            Open in New Tab
          </button>
          <div className="toolbar-sep" />
          <button
            className="toolbar-btn"
            onClick={() => tabActionsRef.current.get(activeId)?.openInWeb()}
            title="Copy to excalidraw.com"
          >
            Open in Web ↗
          </button>
        </div>
      )}

      {/* Tab panes — all mounted, only active visible */}
      <div style={{ flex: 1, position: "relative" }}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            style={{
              position: "absolute",
              inset: 0,
              display: tab.id === activeId ? "block" : "none",
            }}
          >
            {tab.type === "welcome" ? (
              <WelcomeTab
                recentFiles={recentFiles}
                onNewDrawing={handleWelcomeNewDrawing}
                onOpenFile={handleWelcomeOpenFile}
                onOpenRecent={handleWelcomeOpenRecent}
              />
            ) : (
              <DrawingTab
                tabId={tab.id}
                filePath={tab.filePath}
                tempPath={tab.tempPath}
                isActive={tab.id === activeId}
                appDataDir={appDirRef.current}
                {...(tabCallbacks[tab.id] ?? {})}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
