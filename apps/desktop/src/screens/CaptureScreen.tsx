import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  IDEA_STATUSES,
  deriveTitle,
  parseStatusFromMarkdown,
  type CaptureResponse,
  type IdeaStatus,
} from "@carnet/shared";

import { getClient } from "../lib/client";
import { useConnectionStatus } from "../lib/useConnectionStatus";
import {
  recordCapture,
  type CaptureMode,
} from "../lib/storage";

type Phase = "input" | "submitting" | "preview";

export default function CaptureScreen() {
  const params = useParams<{ mode: CaptureMode }>();
  const navigate = useNavigate();
  const mode = (params.mode ?? "idea") as CaptureMode;
  const status = useConnectionStatus();

  const [phase, setPhase] = useState<Phase>("input");
  const [text, setText] = useState("");
  const [ocrText, setOcrText] = useState("");
  const [contextText, setContextText] = useState("");
  const [response, setResponse] = useState<CaptureResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentStatus = useMemo(
    () => parseStatusFromMarkdown(response?.preview_markdown ?? ""),
    [response?.preview_markdown],
  );

  const canSubmit =
    phase === "input" &&
    status === "connected" &&
    (mode === "person"
      ? ocrText.trim().length > 0 || contextText.trim().length > 0
      : text.trim().length > 0);

  const submit = async () => {
    setPhase("submitting");
    setError(null);
    try {
      const client = await getClient();
      let result: CaptureResponse;
      if (mode === "idea") {
        result = await client.captureIdea({ text: text.trim() });
      } else if (mode === "journal") {
        result = await client.captureJournal({ transcript: text.trim() });
      } else {
        result = await client.capturePerson({
          ocr_result: ocrText.trim(),
          context: contextText.trim(),
        });
      }
      if (result.status !== "ok") {
        throw new Error(result.error ?? "Unknown error");
      }
      setResponse(result);
      setPhase("preview");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("input");
    }
  };

  const confirmSave = () => {
    if (!response?.filepath) return;
    recordCapture({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      mode,
      title: deriveTitle(response.preview_markdown ?? ""),
      filepath: response.filepath,
      createdAt: Date.now(),
    });
    navigate("/");
  };

  const promote = async (next: IdeaStatus) => {
    if (!response?.filepath || next === currentStatus) return;
    setError(null);
    try {
      const client = await getClient();
      const updated = await client.promoteIdea(response.filepath, next);
      if (updated.status !== "ok") {
        throw new Error(updated.error ?? "promote failed");
      }
      setResponse(updated);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <main className="screen">
      <header className="topbar">
        <Link to="/" className="back">
          ← Carnet
        </Link>
        <h1>{labelMode(mode)}</h1>
        <span className={`pill pill-${status}`}>{status}</span>
      </header>

      {phase === "input" && (
        <section className="form">
          {mode === "person" ? (
            <>
              <textarea
                placeholder="Texte OCR (carte de visite)"
                rows={5}
                value={ocrText}
                onChange={(e) => setOcrText(e.target.value)}
              />
              <textarea
                placeholder="Contexte de la rencontre"
                rows={4}
                value={contextText}
                onChange={(e) => setContextText(e.target.value)}
              />
            </>
          ) : (
            <textarea
              placeholder={
                mode === "idea" ? "Ton idée…" : "Transcription / notes…"
              }
              rows={8}
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="primary-btn"
          >
            Envoyer
          </button>
          {error && <p className="error">{error}</p>}
        </section>
      )}

      {phase === "submitting" && (
        <section className="loading">
          <p>Claude rédige la note…</p>
        </section>
      )}

      {phase === "preview" && response && (
        <section className="preview">
          <p className="filepath">{response.filepath}</p>
          {mode === "idea" && response.filepath && (
            <div className="status-row">
              {IDEA_STATUSES.map((s) => (
                <button
                  key={s}
                  className={`status-chip ${currentStatus === s ? "selected" : ""}`}
                  onClick={() => void promote(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          <pre className="markdown">{response.preview_markdown ?? ""}</pre>
          <button onClick={confirmSave} className="primary-btn">
            Enregistrer
          </button>
          {error && <p className="error">{error}</p>}
        </section>
      )}
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

