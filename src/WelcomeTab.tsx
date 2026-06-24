import { open as openUrl } from "@tauri-apps/plugin-shell";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecentFile {
  path: string;
  title: string;
  openedAt: number;
}

interface Props {
  recentFiles: RecentFile[];
  onNewDrawing: () => void;
  onOpenFile: () => void;
  onOpenRecent: (path: string, title: string) => void;
}

// ─── Inline logo (infinity mark only — no wordmark) ──────────────────────────
// Filter IDs are scoped with "wlc-" prefix to avoid conflicts when Excalidraw
// also renders SVG filters on the same page.

function ChalkedMark({ size = 72 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      width={size}
      height={size}
      style={{ flexShrink: 0 }}
    >
      <defs>
        <filter id="wlc-roughen" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="3" seed="2" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="2.5" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="wlc-glow">
          <feGaussianBlur stdDeviation="6" result="coloredBlur" />
          <feMerge>
            <feMergeNode in="coloredBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Background */}
      <rect width="512" height="512" rx="110" ry="110" fill="#1A1D2E" />

      {/* Grid */}
      <g opacity="0.07" stroke="#F0EEE6" strokeWidth="1">
        {[64, 128, 192, 256, 320, 384, 448].map((y) => (
          <line key={`h${y}`} x1="0" y1={y} x2="512" y2={y} />
        ))}
        {[64, 128, 192, 256, 320, 384, 448].map((x) => (
          <line key={`v${x}`} x1={x} y1="0" x2={x} y2="512" />
        ))}
      </g>

      {/* Glow */}
      <ellipse cx="256" cy="256" rx="155" ry="90" fill="#FF5F6D" opacity="0.08" filter="url(#wlc-glow)" />

      {/* Left lobe */}
      <path
        d="M 256 256 C 242 226, 210 194, 176 194 C 138 194, 112 222, 112 256 C 112 290, 138 318, 176 318 C 210 318, 240 288, 256 256"
        fill="none" stroke="#F0EEE6" strokeWidth="22" strokeLinecap="round"
        filter="url(#wlc-roughen)" opacity="0.95"
      />

      {/* Right lobe */}
      <path
        d="M 256 256 C 270 226, 302 194, 336 194 C 374 194, 400 222, 400 256 C 400 290, 374 318, 336 318 C 302 318, 272 288, 256 256"
        fill="none" stroke="#F0EEE6" strokeWidth="22" strokeLinecap="round"
        filter="url(#wlc-roughen)" opacity="0.95"
      />

      {/* Coral accent */}
      <path
        d="M 256 256 C 266 239, 284 224, 302 216"
        fill="none" stroke="#FF5F6D" strokeWidth="10" strokeLinecap="round"
        opacity="0.9" filter="url(#wlc-roughen)"
      />

      {/* Blue accent */}
      <path
        d="M 256 256 C 246 273, 228 288, 210 296"
        fill="none" stroke="#7EC8E3" strokeWidth="10" strokeLinecap="round"
        opacity="0.85" filter="url(#wlc-roughen)"
      />

      {/* Center dot */}
      <circle cx="256" cy="256" r="9" fill="#F0EEE6" opacity="0.9" filter="url(#wlc-roughen)" />
    </svg>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  const days = Math.floor(secs / 86400);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+\//, "~/");
}

async function nav(url: string) {
  try {
    await openUrl(url);
  } catch {
    // silently ignore
  }
}

// ─── Bundled libraries metadata ───────────────────────────────────────────────

const BUNDLED_LIBS = [
  { name: "Architecture Diagrams",  count: 11, icon: "🏗️" },
  { name: "Software Architecture",  count: 7,  icon: "🧩" },
  { name: "Stick Figures",          count: 9,  icon: "🕺" },
  { name: "Systems Design",         count: 6,  icon: "⚙️" },
];

// ─── Learn links ─────────────────────────────────────────────────────────────

const LEARN_LINKS = [
  { label: "Excalidraw Docs",     url: "https://docs.excalidraw.com",                         icon: "📖" },
  { label: "YouTube Tutorial",    url: "https://www.youtube.com/results?search_query=excalidraw+tutorial", icon: "▶️" },
  { label: "Share feedback",      url: "https://github.com/aashishkr/chalked/issues", icon: "💬" },
];

// ─── Component ───────────────────────────────────────────────────────────────

export default function WelcomeTab({ recentFiles, onNewDrawing, onOpenFile, onOpenRecent }: Props) {
  return (
    <div className="welcome-page">
      <div className="welcome-inner">

        {/* ── Header ── */}
        <div className="welcome-header">
          <ChalkedMark size={80} />
          <div className="welcome-title-block">
            <h1 className="welcome-title">chalked</h1>
            <p className="welcome-subtitle">
              Native desktop drawing — infinite canvas, zero friction
            </p>
            <p className="welcome-powered-by">
              Powered by{" "}
              <button className="welcome-excalidraw-credit" onClick={() => nav("https://excalidraw.com")}>
                Excalidraw
              </button>
              {" "}— the open-source virtual whiteboard
            </p>
          </div>
        </div>

        {/* ── Two-column body ── */}
        <div className="welcome-columns">

          {/* Left — Start + Recent */}
          <div className="welcome-col">
            <section className="welcome-section">
              <h2 className="welcome-section-title">Start</h2>

              <button className="welcome-action" onClick={onNewDrawing}>
                <span className="welcome-action-icon">✏️</span>
                <span className="welcome-action-text">
                  <span className="welcome-action-label">New Drawing</span>
                  <span className="welcome-action-desc">Start from a blank canvas</span>
                </span>
                <kbd className="welcome-kbd">⌘N</kbd>
              </button>

              <button className="welcome-action" onClick={onOpenFile}>
                <span className="welcome-action-icon">📂</span>
                <span className="welcome-action-text">
                  <span className="welcome-action-label">Open File…</span>
                  <span className="welcome-action-desc">Load a .excalidraw file from disk</span>
                </span>
                <kbd className="welcome-kbd">⌘O</kbd>
              </button>
            </section>

            {recentFiles.length > 0 && (
              <section className="welcome-section">
                <h2 className="welcome-section-title">Recent</h2>
                {recentFiles.slice(0, 8).map((f) => (
                  <button
                    key={f.path}
                    className="welcome-action welcome-recent-item"
                    onClick={() => onOpenRecent(f.path, f.title)}
                    title={f.path}
                  >
                    <span className="welcome-action-icon welcome-file-dot" />
                    <span className="welcome-action-text">
                      <span className="welcome-action-label">{f.title}</span>
                      <span className="welcome-action-desc welcome-path">{shortPath(f.path)}</span>
                    </span>
                    <span className="welcome-time">{timeAgo(f.openedAt)}</span>
                  </button>
                ))}
              </section>
            )}

            {recentFiles.length === 0 && (
              <section className="welcome-section">
                <h2 className="welcome-section-title">Recent</h2>
                <p className="welcome-empty">No recent files yet. Open or create a drawing to get started.</p>
              </section>
            )}
          </div>

          {/* Right — Learn + Libraries */}
          <div className="welcome-col">
            <section className="welcome-section">
              <h2 className="welcome-section-title">Learn</h2>
              {LEARN_LINKS.map((l) => (
                <button
                  key={l.url}
                  className="welcome-action welcome-link-item"
                  onClick={() => nav(l.url)}
                >
                  <span className="welcome-action-icon">{l.icon}</span>
                  <span className="welcome-action-text">
                    <span className="welcome-action-label">{l.label}</span>
                  </span>
                  <span className="welcome-ext-arrow">↗</span>
                </button>
              ))}
            </section>

            <section className="welcome-section">
              <h2 className="welcome-section-title">Bundled Libraries</h2>
              <p className="welcome-lib-note">
                These shape libraries are pre-loaded in every drawing. Open the Library panel (the book icon) to browse them.
              </p>
              <div className="welcome-libs">
                {BUNDLED_LIBS.map((lib) => (
                  <div key={lib.name} className="welcome-lib-row">
                    <span className="welcome-lib-icon">{lib.icon}</span>
                    <span className="welcome-lib-name">{lib.name}</span>
                    <span className="welcome-lib-count">{lib.count} shapes</span>
                  </div>
                ))}
              </div>
            </section>
          </div>

        </div>

        {/* ── Footer ── */}
        <div className="welcome-footer">
          <span>Built with </span>
          <button className="welcome-footer-link" onClick={() => nav("https://tauri.app")}>Tauri v2</button>
          <span> + </span>
          <button className="welcome-footer-link" onClick={() => nav("https://excalidraw.com")}>Excalidraw</button>
          <span> · </span>
          <button className="welcome-footer-link" onClick={() => nav("https://github.com/aashishkr/chalked")}>GitHub ↗</button>
        </div>

      </div>
    </div>
  );
}
