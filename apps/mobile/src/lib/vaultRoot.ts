/**
 * Vault root resolution (the one place a storage backend is chosen).
 *
 * Storage paths come in two flavors — `file://...` (expo-file-system legacy)
 * and `content://...tree/...` (Storage Access Framework). The per-backend
 * branching lives behind the `VaultFs` seam in ./vaultFs; resolveRoot selects
 * a backend ONCE from the configured `captureFolderPath` setting and hands the
 * pair back, so callers (writer.ts, pairedBinaries.ts) never re-decide it.
 *
 * Lives in its own module rather than in writer.ts so both writer.ts and
 * pairedBinaries.ts can depend on it without forming an import cycle.
 */

import * as FileSystem from "expo-file-system/legacy";
import { getSettings } from "./settings";
import { vaultFsFor, type VaultFs } from "./vaultFs";

export interface Root {
  /** Either a `file://` URI or a `content://...tree/...` SAF tree URI. */
  uri: string;
  /** The filesystem backend selected for `uri` (SAF vs file://). */
  fs: VaultFs;
}

/**
 * Resolve the root folder URI from settings.
 *   - empty / default → app sandbox carnet/
 *   - content://...tree/... → SAF tree URI as-is
 *   - anything else → treat as a file:// URI (legacy raw Android path)
 */
export async function resolveRoot(): Promise<Root> {
  const { captureFolderPath } = await getSettings();
  const trimmed = captureFolderPath.trim();
  if (!trimmed) {
    const base = FileSystem.documentDirectory ?? "file:///data/user/0/carnet/files/";
    return { uri: `${base.replace(/\/$/, "")}/carnet`, fs: vaultFsFor(false) };
  }
  if (trimmed.startsWith("content://")) {
    return { uri: trimmed, fs: vaultFsFor(true) };
  }
  // Best-effort: file:// or raw path. Ensure file:// prefix for FileSystem API.
  const uri = trimmed.startsWith("file://") ? trimmed : `file://${trimmed}`;
  return { uri, fs: vaultFsFor(false) };
}
