import { useRef, useEffect, useCallback, memo } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import { logger } from "./logger";

// Bundled libraries — always available in the app's personal library panel
import archDiagram from "./assets/libs/architecture-diagram-components.excalidrawlib";
import softwareArch from "./assets/libs/software-architecture.excalidrawlib";
import stickFigures from "./assets/libs/stick-figures.excalidrawlib";
import systemsDesign from "./assets/libs/systems-design-components.excalidrawlib";

// Normalise a library file — handles both v1 (`library` key) and v2 (`libraryItems` key)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function libItems(file: any): unknown[] {
  return file.libraryItems ?? file.library ?? [];
}

// Merge all library items into one flat list at module level (computed once)
const BUNDLED_LIBRARY_ITEMS = [
  ...libItems(archDiagram),
  ...libItems(softwareArch),
  ...libItems(stickFigures),
  ...libItems(systemsDesign),
];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExcalidrawImperativeAPI = any; // avoids deep-path import that varies by version

import { save, open, message } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile, stat } from "@tauri-apps/plugin-fs";
// Note: `stat` requires "fs:allow-stat" in capabilities/default.json
import { open as openUrl } from "@tauri-apps/plugin-shell";

// 50 MB — refuse to load files larger than this to avoid OOM hangs
const MAX_FILE_BYTES = 50 * 1024 * 1024;

// Safe JSON parse — returns null on any error instead of throwing
function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null ? v : null;
  } catch {
    return null;
  }
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface TabActions {
  save: () => Promise<void>;
  saveAs: () => Promise<void>;
  open: () => Promise<void>;
  openInNewTab: () => Promise<void>;
  openInWeb: () => Promise<void>;
}

interface Props {
  tabId: string;
  filePath?: string;       // set for saved files
  tempPath?: string;       // set for unsaved-but-auto-saved files
  isActive: boolean;
  appDataDir: string;      // resolved app data dir for temp files
  onDirtyChange: (isDirty: boolean) => void;
  onSaved: (title: string, filePath?: string) => void;
  onTempPath: (tempPath: string) => void;
  onOpenNewTab: (filePath?: string, title?: string, tempPath?: string) => void;
  onRegisterSave: (fn: () => Promise<void>) => void;
  onRegisterActions: (actions: TabActions) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

// React.memo: skips re-render when a sibling tab's state changes (dirty, title, etc.)
// This is the biggest perf win for multi-tab use — Excalidraw is expensive to reconcile.
const DrawingTab = memo(function DrawingTab({
  tabId,
  filePath,
  tempPath,
  isActive,
  appDataDir,
  onDirtyChange,
  onSaved,
  onTempPath,
  onOpenNewTab,
  onRegisterSave,
  onRegisterActions,
}: Props) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);

  // Track saved file path in a ref so async callbacks always see the latest
  const savedPathRef = useRef<string | undefined>(filePath);

  // Snapshot of element id+version when file was last clean (loaded or saved).
  // onChange compares against this — only real edits change element versions.
  const cleanSnapshotRef = useRef<string>("");
  // Whether we're still in the loading window (suppress onChange during mount)
  const isLoadingRef = useRef(true);
  // Last reported dirty value — avoids calling onDirtyChange when nothing changed
  const lastDirtyRef = useRef(false);

  // Debounce timer for auto-saving unsaved (temp) tabs
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Debounce timer for snapshot-based dirty check (avoids computing on every mouse-move event)
  const dirtyCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Snapshot helpers ──────────────────────────────────────────────────────
  // Lightweight fingerprint: element id + version counter.
  // Version increments only on real edits, not on scroll/zoom/re-render.
  function makeSnapshot(elements: Array<{ id: string; version: number }>): string {
    return elements.map((e) => `${e.id}:${e.version}`).join("|");
  }

  function captureClean(api: ExcalidrawImperativeAPI) {
    cleanSnapshotRef.current = makeSnapshot(api.getSceneElements());
  }

  function reportDirty(isDirty: boolean) {
    if (isDirty === lastDirtyRef.current) return;
    lastDirtyRef.current = isDirty;
    onDirtyChange(isDirty);
  }

  // ── Safe file loader ──────────────────────────────────────────────────────
  async function loadFile(path: string): Promise<{ elements: unknown[]; appState: object } | null> {
    try {
      const info = await stat(path);
      if (info.size > MAX_FILE_BYTES) {
        await message(
          `File is ${(info.size / 1024 / 1024).toFixed(1)} MB — exceeds the 50 MB limit.`,
          { title: "File Too Large", kind: "error" }
        );
        return null;
      }
      const content = await readTextFile(path);
      const parsed = safeJsonParse(content);
      if (!parsed) {
        await message("Not a valid Excalidraw file.", { title: "Invalid File", kind: "error" });
        return null;
      }
      return {
        elements: (parsed.elements as unknown[]) ?? [],
        appState: (parsed.appState as object) ?? {},
      };
    } catch (e) {
      logger.error("loadFile failed", e, { path });
      return null;
    }
  }

  function applyScene(api: ExcalidrawImperativeAPI, elements: unknown[], appState: object) {
    isLoadingRef.current = true;
    api.updateScene({ elements, appState });
    // Wait for Excalidraw to finish internal layout (font measurement, etc.)
    // then snapshot the settled state as the new clean baseline.
    setTimeout(() => {
      captureClean(api);
      reportDirty(false);
      isLoadingRef.current = false;
    }, 300);
  }

  // ── Save to disk ──────────────────────────────────────────────────────────
  const handleSave = useCallback(
    async (saveAs = false) => {
      const api = apiRef.current;
      if (!api) return;

      const elements = api.getSceneElements();
      const appState = api.getAppState();
      const files = api.getFiles();

      const data = JSON.stringify(
        {
          type: "excalidraw",
          version: 2,
          source: "chalked",
          elements,
          appState: {
            viewBackgroundColor: appState.viewBackgroundColor,
            currentItemFontFamily: appState.currentItemFontFamily,
          },
          files,
        },
        null,
        2
      );

      let targetPath = saveAs ? undefined : savedPathRef.current;

      if (!targetPath) {
        targetPath =
          (await save({
            title: "Save Drawing",
            filters: [{ name: "Excalidraw", extensions: ["excalidraw"] }],
            defaultPath: "Untitled.excalidraw",
          })) ?? undefined;
      }

      if (!targetPath) return; // user cancelled

      await writeTextFile(targetPath, data);
      savedPathRef.current = targetPath;
      // Re-snapshot so the saved state becomes the new clean baseline
      captureClean(api);
      reportDirty(false);
      onSaved(targetPath.split("/").pop()!, targetPath);
    },
    [onSaved]
  );

  // ── Auto-save to temp (only for unsaved tabs) ─────────────────────────────
  const scheduleAutoSave = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      if (!appDataDir || savedPathRef.current) return; // skip for saved files

      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = setTimeout(async () => {
        try {
          const elements = api.getSceneElements();
          if (!elements.length) return;

          const tp = appDataDir + "/temp/" + tabId + ".excalidraw";
          const data = JSON.stringify({
            type: "excalidraw",
            version: 2,
            elements,
            appState: { viewBackgroundColor: api.getAppState().viewBackgroundColor },
          });
          await writeTextFile(tp, data);
          onTempPath(tp); // tell App about the temp path (idempotent)
        } catch (e) {
          logger.error("Auto-save failed", e, { tabId });
        }
      }, 2000); // 2 s debounce
    },
    [appDataDir, tabId, onTempPath]
  );

  // ── Open from disk ────────────────────────────────────────────────────────
  const handleOpen = useCallback(
    async (inNewTab = false) => {
      const selected = await open({
        title: "Open Drawing",
        multiple: false,
        filters: [{ name: "Excalidraw", extensions: ["excalidraw"] }],
      });
      if (!selected || Array.isArray(selected)) return;

      if (inNewTab) {
        onOpenNewTab(selected);
        return;
      }

      const scene = await loadFile(selected);
      if (!scene) return;

      applyScene(apiRef.current, scene.elements, scene.appState);
      savedPathRef.current = selected;
      onSaved(selected.split("/").pop()!, selected);
    },
    [onSaved, onOpenNewTab]
  );

  // ── Open in web ───────────────────────────────────────────────────────────
  const handleOpenInWeb = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;

    const elements = api.getSceneElements();
    const appState = api.getAppState();

    // Exclude embedded image files to prevent URL size explosion
    const payload = JSON.stringify({
      type: "excalidraw",
      elements,
      appState: { viewBackgroundColor: appState.viewBackgroundColor },
    });

    if (payload.length > 4 * 1024 * 1024) {
      await message(
        "Drawing too large to open in web (~4 MB limit). Remove large images first.",
        { title: "Drawing Too Large", kind: "warning" }
      );
      return;
    }

    const encoded = encodeURIComponent(btoa(unescape(encodeURIComponent(payload))));
    await openUrl(`https://excalidraw.com/#json=${encoded}`);
  }, []);

  // ── Register save + all toolbar actions with parent ───────────────────────
  // MUST come after handleSave, handleOpen, handleOpenInWeb are all declared —
  // the dependency array is evaluated immediately, so referencing them before
  // their `const` initialisation causes a temporal dead zone (TDZ) crash.
  useEffect(() => {
    onRegisterSave(() => handleSave(false));
    onRegisterActions({
      save: () => handleSave(false),
      saveAs: () => handleSave(true),
      open: () => handleOpen(false),
      openInNewTab: () => handleOpen(true),
      openInWeb: handleOpenInWeb,
    });
  }, [handleSave, handleOpen, handleOpenInWeb, onRegisterSave, onRegisterActions]);

  // ── Load on mount ─────────────────────────────────────────────────────────
  // Priority: filePath > tempPath > start blank
  useEffect(() => {
    const source = filePath ?? tempPath;

    // Poll until Excalidraw API is ready (may lag behind first render)
    function waitForApi(cb: (api: ExcalidrawImperativeAPI) => void) {
      if (apiRef.current) { cb(apiRef.current); return; }
      const t = setInterval(() => {
        if (apiRef.current) { clearInterval(t); cb(apiRef.current); }
      }, 50);
    }

    // Load bundled libraries into the personal library panel.
    // merge: false replaces whatever Excalidraw stored in IndexedDB so the
    // bundled set is always authoritative. Items are keyed by id so duplicates
    // are silently de-duped by Excalidraw internally.
    function loadBundledLibrary(api: ExcalidrawImperativeAPI) {
      try {
        api.updateLibrary({
          libraryItems: BUNDLED_LIBRARY_ITEMS,
          merge: false,
          openLibraryMenu: false,
        });
      } catch (e) {
        logger.warn("Failed to load bundled libraries", e);
      }
    }

    if (!source) {
      // Blank tab: wait for Excalidraw to finish init, then snapshot the empty state
      waitForApi((api) => {
        setTimeout(() => {
          loadBundledLibrary(api);
          captureClean(api);  // snapshot = "" (no elements) = clean
          isLoadingRef.current = false;
        }, 300);
      });
      return;
    }

    waitForApi(async (api) => {
      const scene = await loadFile(source);
      if (scene) applyScene(api, scene.elements, scene.appState);
      else {
        isLoadingRef.current = false;
        logger.warn("File load returned null, starting blank", { source });
      }
      // Load libraries regardless of whether a file was loaded
      setTimeout(() => loadBundledLibrary(api), 300);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — only run on mount

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    if (!isActive) return;
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === "s") { e.preventDefault(); handleSave(e.shiftKey); }
      if (e.key === "o") { e.preventDefault(); handleOpen(e.shiftKey); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isActive, handleSave, handleOpen]);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="drawing-area">
      <Excalidraw
        excalidrawAPI={(api: ExcalidrawImperativeAPI) => {
          apiRef.current = api;
        }}
        onChange={() => {
          if (isLoadingRef.current) return;

          // ── Performance: short-circuit when already dirty ──────────────────
          // Once dirty we only need auto-save scheduling; skip snapshot work.
          if (lastDirtyRef.current) {
            if (apiRef.current) scheduleAutoSave(apiRef.current);
            return;
          }

          // ── Debounced snapshot comparison (100 ms) ─────────────────────────
          // onChange fires on every pointer-move while drawing. Computing a
          // snapshot on every event for a drawing with 1000+ elements is wasteful.
          // We debounce and read from the API (always current) inside the timer.
          if (dirtyCheckTimerRef.current) clearTimeout(dirtyCheckTimerRef.current);
          dirtyCheckTimerRef.current = setTimeout(() => {
            if (!apiRef.current || isLoadingRef.current) return;
            const snapshot = makeSnapshot(apiRef.current.getSceneElements());
            const nowDirty = snapshot !== cleanSnapshotRef.current;
            reportDirty(nowDirty);
            if (nowDirty) scheduleAutoSave(apiRef.current);
          }, 100);
        }}
        UIOptions={{
          canvasActions: {
            changeViewBackgroundColor: true,
            clearCanvas: true,
            export: { saveFileToDisk: true },
            loadScene: true,
            saveToActiveFile: true,
            toggleTheme: true,
          },
        }}
      />
    </div>
  );
});

export default DrawingTab;
