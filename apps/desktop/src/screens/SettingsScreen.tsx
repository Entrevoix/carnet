import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { NavettedClient } from "@carnet/shared";

import {
  getClientId,
  getSettings,
  saveSettings,
  type Settings,
} from "../lib/storage";
import { disconnectClient } from "../lib/client";

interface TestResult {
  ok: boolean;
  msg: string;
}

export default function SettingsScreen() {
  const [settings, setSettings] = useState<Settings>(getSettings());
  const [clientId, setClientId] = useState("");
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  useEffect(() => {
    setClientId(getClientId());
  }, []);

  const update = (patch: Partial<Settings>) =>
    setSettings({ ...settings, ...patch });

  const save = () => {
    saveSettings(settings);
    disconnectClient();
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    const probe = new NavettedClient({
      url: settings.navettedUrl,
      token: settings.navettedToken,
      clientId,
      requestTimeoutMs: 5_000,
      initialReconnectDelay: 60_000,
      maxReconnectDelay: 60_000,
    });
    probe.connect();
    try {
      const start = Date.now();
      while (probe.getStatus() !== "connected" && Date.now() - start < 5_000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (probe.getStatus() !== "connected") {
        throw new Error(`connexion impossible (statut: ${probe.getStatus()})`);
      }
      const { rttMs } = await probe.ping();
      setTestResult({ ok: true, msg: `Connecté en ${rttMs}ms` });
    } catch (e: unknown) {
      setTestResult({
        ok: false,
        msg: e instanceof Error ? e.message : String(e),
      });
    } finally {
      probe.disconnect();
      setTesting(false);
    }
  };

  return (
    <main className="screen">
      <header className="topbar">
        <Link to="/" className="back">
          ← Carnet
        </Link>
        <h1>Paramètres</h1>
      </header>

      <section className="form">
        <label>
          <span>navetted URL</span>
          <input
            type="text"
            value={settings.navettedUrl}
            onChange={(e) => update({ navettedUrl: e.target.value })}
            placeholder="ws://localhost:7878"
          />
        </label>
        <label>
          <span>navetted token</span>
          <input
            type="password"
            value={settings.navettedToken}
            onChange={(e) => update({ navettedToken: e.target.value })}
          />
        </label>
        <label>
          <span>OmniRoute URL (optionnel)</span>
          <input
            type="text"
            value={settings.omniRouteUrl}
            onChange={(e) => update({ omniRouteUrl: e.target.value })}
          />
        </label>

        <div className="meta">
          <strong>Client ID</strong>
          <code>{clientId}</code>
        </div>

        <button
          onClick={() => void testConnection()}
          disabled={testing}
          className="secondary-btn"
        >
          {testing ? "Test en cours…" : "Tester la connexion"}
        </button>
        {testResult && (
          <p className={testResult.ok ? "info" : "error"}>{testResult.msg}</p>
        )}

        <button onClick={save} className="primary-btn">
          Enregistrer
        </button>
        {saved && <p className="info">Paramètres enregistrés</p>}
      </section>
    </main>
  );
}
