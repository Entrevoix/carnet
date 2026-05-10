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

const FALLBACK_SETTINGS: Settings = {
  navettedUrl: "ws://localhost:7878",
  navettedToken: "",
  omniRouteUrl: "",
};

export default function SettingsScreen() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [clientId, setClientId] = useState("");
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  useEffect(() => {
    setClientId(getClientId());
    // Catch on the load path: if getSettings rejects (e.g. keyring write
    // failure during legacy migration on Linux without a daemon), surface
    // the error and fall back to defaults so the form stays usable. Without
    // this, the screen wedges on "Chargement…" with no escape.
    void getSettings()
      .then(setSettings)
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        setSettings({ ...FALLBACK_SETTINGS });
        setLoadError(msg);
      });
  }, []);

  if (!settings) {
    return (
      <main className="screen">
        <p className="muted">Chargement…</p>
      </main>
    );
  }

  const update = (patch: Partial<Settings>) =>
    setSettings({ ...settings, ...patch });

  const save = async () => {
    setSaveError(null);
    try {
      await saveSettings(settings);
      disconnectClient();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: unknown) {
      // Without this, a keychain write failure leaves the user re-tapping
      // Save with no feedback while the same error fires every time.
      setSaveError(e instanceof Error ? e.message : String(e));
    }
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
        {loadError && (
          <p className="error">
            Impossible de charger les paramètres ({loadError}). Saisis-les à
            nouveau ci-dessous.
          </p>
        )}
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

        <button onClick={() => void save()} className="primary-btn">
          Enregistrer
        </button>
        {saved && <p className="info">Paramètres enregistrés</p>}
        {saveError && (
          <p className="error">Échec de l'enregistrement: {saveError}</p>
        )}
      </section>
    </main>
  );
}
