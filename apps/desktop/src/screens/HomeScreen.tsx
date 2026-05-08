import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  getRecentCaptures,
  type CaptureEntry,
  type CaptureMode,
} from "../lib/storage";
import { useConnectionStatus } from "../lib/useConnectionStatus";

export default function HomeScreen() {
  const [recent, setRecent] = useState<CaptureEntry[]>([]);
  const status = useConnectionStatus();

  useEffect(() => {
    setRecent(getRecentCaptures());
  }, []);

  return (
    <main className="screen">
      <header className="topbar">
        <h1>Carnet</h1>
        <div className="topbar-actions">
          <span className={`pill pill-${status}`}>{status}</span>
          <Link to="/settings" className="cog" aria-label="Paramètres">
            ⚙
          </Link>
        </div>
      </header>

      <section className="capture-buttons">
        <Link to="/capture/idea" className="cap-btn cap-btn-primary">
          💡 Idée
        </Link>
        <Link to="/capture/journal" className="cap-btn cap-btn-tonal">
          🎙 Journal
        </Link>
        <Link to="/capture/person" className="cap-btn cap-btn-outline">
          👤 Contact
        </Link>
      </section>

      <section className="recent">
        <h2>Récents</h2>
        {recent.length === 0 ? (
          <p className="muted">Aucune capture pour le moment.</p>
        ) : (
          <ul className="recent-list">
            {recent.map((item) => (
              <li key={item.id}>
                <span className="recent-mode">{labelMode(item.mode)}</span>
                <span className="recent-title">{item.title}</span>
                <span className="recent-time">
                  {new Date(item.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function labelMode(mode: CaptureMode): string {
  switch (mode) {
    case "idea":
      return "Idée";
    case "journal":
      return "Journal";
    case "person":
      return "Contact";
  }
}
