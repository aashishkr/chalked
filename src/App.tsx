import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import DrawingTab, { TabActions } from "./DrawingTab";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { appDataDir } from "@tauri-apps/api/path";
import { writeTextFile, readTextFile, exists, mkdir } from "@tauri-apps/plugin-fs";
import { logger } from "./logger";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Tab {
  id: string;
  title: string;
  filePath?: string;  // undefined = unsaved
  tempPath?: string;  // auto-save path for unsaved tabs
  isDirty: boolean;
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
  return {
    id: opts.id ?? uid(),
    title: opts.title ?? (opts.filePath ? opts.filePath.split("/").pop()! : "Untitled"),
    filePath: opts.filePath,
    tempPath: opts.tempPath,
    isDirty: false,
    ...opts,
  };
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
  // Trap keyboard so Escape = cancel, Enter = save
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
  const [tabs, setTabs] = useState<Tab[]>([newTab()]);
  const [activeId, setActiveId] = useState<string>(tabs[0].id);
  const [dialog, setDialog] = useState<null | {
    title: string;
    onSave: () => void;
    onDiscard: () => void;
    onCancel: () => void;
  }>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");

  // Stable refs so callbacks always see current values
  const tabsRef = useRef<Tab[]>(tabs);
  tabsRef.current = tabs;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // appDataDir resolved once on mount (e.g. ~/Library/Application Support/com.excalidraw.desktop)
  const appDirRef = useRef("");

  // DrawingTab registers its save fn here so App can call it on window close
  const saveCallbacks = useRef<Map<string, () => Promise<void>>>(new Map());
  // Per-tab action handlers — keyed by tab id, updated by each DrawingTab on mount
  const tabActionsRef = useRef<Map<string, TabActions>>(new Map());

  // ── Init: resolve app dir + restore session ────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const dir = await appDataDir();
        const tempDir = dir + "/temp";
        appDirRef.current = dir;

        // Init logger first so any subsequent errors are captured
        logger.init(dir);
        logger.info("App started", { appDataDir: dir });

        if (!(await exists(dir))) await mkdir(dir, { recursive: true });
        if (!(await exists(tempDir))) await mkdir(tempDir, { recursive: true });

        const sessionPath = dir + "/session.json";
        if (await exists(sessionPath)) {
          const raw = await readTextFile(sessionPath);
          const saved: SessionTab[] = JSON.parse(raw);
          if (Array.isArray(saved) && saved.length > 0) {
            const restored = saved.map((s) =>
              newTab({ title: s.title, filePath: s.filePath, tempPath: s.tempPath })
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

  // ── Persist session whenever tabs change (debounced 800 ms) ───────────────
  useEffect(() => {
    if (!appDirRef.current) return;
    const timer = setTimeout(async () => {
      try {
        const data: SessionTab[] = tabsRef.current.map((t) => ({
          title: t.title,
          filePath: t.filePath,
          tempPath: t.tempPath,
        }));
        await writeTextFile(appDirRef.current + "/session.json", JSON.stringify(data));
      } catch (e) {
        logger.error("Session write failed", e);
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [tabs]);

  // ── Unsaved-changes prompt ─────────────────────────────────────────────────
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

  // ── Window close: check all dirty tabs ────────────────────────────────────
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let closing = false;

    win
      .onCloseRequested(async (event) => {
        if (closing) return;
        event.preventDefault();

        const dirty = tabsRef.current.filter((t) => t.isDirty);
        for (const tab of dirty) {
          const r = await askUnsaved(tab.title);
          if (r === "cancel") return;
          if (r === "save") await saveCallbacks.current.get(tab.id)?.();
        }

        closing = true;
        // close() re-fires onCloseRequested; the `closing` guard above returns
        // without calling preventDefault(), so the window closes normally.
        await win.close();
      })
      .then((fn) => { unlisten = fn; });

    return () => unlisten?.();
  }, []);

  // ── Tab management ─────────────────────────────────────────────────────────
  const addTab = useCallback(
    (opts: Partial<Tab> = {}) => {
      const tab = newTab(opts);
      setTabs((prev) => [...prev, tab]);
      setActiveId(tab.id);
      return tab.id;
    },
    []
  );

  const requestClose = useCallback(async (id: string) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (!tab) return;

    if (tab.isDirty) {
      const r = await askUnsaved(tab.title);
      if (r === "cancel") return;
      if (r === "save") await saveCallbacks.current.get(id)?.();
    }

    saveCallbacks.current.delete(id);
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (!next.length) {
        const fresh = newTab();
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

  // ── Inline rename ──────────────────────────────────────────────────────────
  const startRename = (id: string, current: string) => {
    setRenamingId(id);
    setRenameVal(current);
  };

  const commitRename = () => {
    if (renamingId && renameVal.trim()) patchTab(renamingId, { title: renameVal.trim() });
    setRenamingId(null);
  };

  // ── Stable per-tab callbacks (keyed by tab ID) ───────────────────────────
  // Memoised so DrawingTab wrapped in React.memo doesn't re-render when
  // a different tab's title/dirty state changes.
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
        onSaved: (title, fp) => patchTab(id, { title, filePath: fp, isDirty: false }),
        onTempPath: (tp) => patchTab(id, { tempPath: tp }),
        onOpenNewTab: (fp, title, tp) => addTab({ filePath: fp, title, tempPath: tp }),
        onRegisterSave: (fn) => saveCallbacks.current.set(id, fn),
        onRegisterActions: (actions) => tabActionsRef.current.set(id, actions),
      };
    }
    return map;
  // Rebuild only when the set of tab IDs changes (not on every dirty/title change)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.map((t) => t.id).join(","), patchTab, addTab]);

  // ─── Render ──────────────────────────────────────────────────────────────

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
              className={`tab ${tab.id === activeId ? "active" : ""}`}
              onClick={() => setActiveId(tab.id)}
              title={
                tab.filePath
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
                    e.stopPropagation();
                    startRename(tab.id, tab.title);
                  }}
                  title="Double-click to rename"
                >
                  {tab.isDirty ? `• ${tab.title}` : tab.title}
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

      {/* Toolbar — sits between tab bar and canvas, never overlaps Excalidraw UI */}
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

      {/* Drawing panes — all mounted, only active one visible */}
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
            <DrawingTab
              tabId={tab.id}
              filePath={tab.filePath}
              tempPath={tab.tempPath}
              isActive={tab.id === activeId}
              appDataDir={appDirRef.current}
              {...(tabCallbacks[tab.id] ?? {})}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
