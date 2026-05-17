/**
 * Desktop is a v0.3-deferred placeholder per README. The previous Tauri
 * implementation was built around `navetted` (WebSocket pairing daemon),
 * which v0.2 retired in favor of OmniRoute on mobile + Syncthing for the
 * vault. The screens were ripped out rather than half-ported so this
 * package stays buildable without dragging navetted ghosts along.
 *
 * When v0.3 picks desktop back up, decide first: rebuild against OmniRoute
 * (mirror the mobile capture flow) or deprecate the package entirely.
 */
export default function App() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
        fontFamily: "system-ui, sans-serif",
        textAlign: "center",
        gap: 16,
      }}
    >
      <h1 style={{ margin: 0 }}>Carnet desktop</h1>
      <p style={{ maxWidth: 480, opacity: 0.8 }}>
        Mobile capture is the v0.2 focus. The desktop client is paused
        pending a v0.3 decision on whether to rebuild against OmniRoute or
        deprecate. Use Obsidian on your workstation to read and edit the
        Syncthing-shared vault for now.
      </p>
    </main>
  );
}
