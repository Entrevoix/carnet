/**
 * Filesystem seam for the vault writer.
 *
 * The vault lives behind one of two Android storage backends, distinguished
 * only by the shape of the configured folder URI (see resolveRoot in writer.ts):
 *   - `file://...` — direct filesystem path inside the app sandbox or a legacy
 *     raw Android path. Uses the regular expo-file-system legacy API.
 *   - `content://...tree/...` — Storage Access Framework tree URI granted
 *     persistently by the OS document picker. Uses StorageAccessFramework
 *     (createFileAsync, readDirectoryAsync, …) because raw path concatenation
 *     doesn't work on SAF URIs.
 *
 * `VaultFs` is the narrow set of primitives writer.ts needs. The backend is
 * chosen ONCE (in resolveRoot / fsForUri) so callers stop threading an `isSaf`
 * boolean and re-deciding the branch inside every primitive. Branch-free logic
 * that sits ON TOP of these primitives (collision-free naming, note
 * enumeration, archiving) stays in writer.ts.
 */

import * as FileSystem from "expo-file-system/legacy";

const { StorageAccessFramework } = FileSystem;

/**
 * Extract the filename/subdir name from a SAF document or tree URI. SAF URIs:
 *   tree:     content://authority/tree/{encoded-tree-id}
 *   document: content://authority/tree/{encoded-tree-id}/document/{encoded-document-id}
 *
 * The encoded id (after `/document/` or `/tree/`) decodes into something like
 * `primary:Download/Carnet/Ideas/myidea.md` — the filename is the last `/`
 * segment of that decoded id. We deliberately do NOT decode the whole URI,
 * which would mangle the authority component that contains its own `/`s.
 */
export function safLastSegment(uri: string): string {
  const docMarker = uri.indexOf("/document/");
  const treeMarker = uri.indexOf("/tree/");
  let encodedId: string;
  if (docMarker >= 0) {
    encodedId = uri.slice(docMarker + "/document/".length);
  } else if (treeMarker >= 0) {
    encodedId = uri.slice(treeMarker + "/tree/".length);
  } else {
    return uri;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedId);
  } catch {
    decoded = encodedId;
  }
  const slash = decoded.lastIndexOf("/");
  if (slash >= 0) return decoded.slice(slash + 1);
  // No slash — handle root-of-volume case like "primary:foldername"
  const colon = decoded.indexOf(":");
  return colon >= 0 ? decoded.slice(colon + 1) : decoded;
}

/** A directory child: its full readable URI plus its basename. On SAF the URI
 * is a document URI and the name is its decoded last segment; on file:// the
 * URI is `${parent}/${name}`. */
export interface VaultChild {
  uri: string;
  name: string;
}

/**
 * The filesystem primitives the vault writer needs, with the SAF/file:// branch
 * resolved once by the concrete implementation instead of a threaded boolean.
 */
export interface VaultFs {
  /** True for the SAF (content://) backend. A few callers still need the
   * discriminator (e.g. deriving a SAF create-time rename). */
  readonly isSaf: boolean;
  /** List `parentUri`'s children as `{ uri, name }`. A missing directory yields
   * `[]` (first write into a fresh subdir). */
  listChildren(parentUri: string): Promise<VaultChild[]>;
  /** Return the URI of an existing child file named `name`, or null. */
  findChild(parentUri: string, name: string): Promise<string | null>;
  /** Return an existing subdir's URI without creating it, or null. */
  findSubdir(parentUri: string, name: string): Promise<string | null>;
  /** Return a subdir's URI, creating it if absent. */
  findOrCreateSubdir(parentUri: string, name: string): Promise<string>;
  /** Create an empty file and return its ACTUAL URI. SAF's createFileAsync may
   * RENAME the file (DocumentsContract appends the mime's canonical extension
   * when the display name lacks it), so the returned URI — not the requested
   * name — is authoritative. */
  createFile(parentUri: string, name: string, mime: string): Promise<string>;
  /** Read a file's UTF-8 string content. */
  readString(uri: string): Promise<string>;
  /** Overwrite a file with UTF-8 string content. */
  writeString(uri: string, content: string): Promise<void>;
  /** Read a file as base64. */
  readBinary(uri: string): Promise<string>;
  /** Overwrite a file with base64-encoded bytes. */
  writeBinaryBytes(uri: string, base64: string): Promise<void>;
  /** Delete a file. */
  delete(uri: string): Promise<void>;
}

/** file:// backend — direct paths inside the app sandbox or a legacy raw path. */
const fileFs: VaultFs = {
  isSaf: false,

  async listChildren(parentUri) {
    try {
      const names = await FileSystem.readDirectoryAsync(parentUri);
      const base = parentUri.replace(/\/$/, "");
      return names.map((name) => ({ uri: `${base}/${name}`, name }));
    } catch {
      // Directory may not exist yet — first write into a fresh subdir.
      return [];
    }
  },

  async findChild(parentUri, name) {
    const fileUri = `${parentUri.replace(/\/$/, "")}/${name}`;
    const info = await FileSystem.getInfoAsync(fileUri);
    return info.exists ? fileUri : null;
  },

  async findSubdir(parentUri, name) {
    const dir = `${parentUri.replace(/\/$/, "")}/${name}`;
    const info = await FileSystem.getInfoAsync(dir);
    return info.exists ? dir : null;
  },

  async findOrCreateSubdir(parentUri, name) {
    const dir = `${parentUri.replace(/\/$/, "")}/${name}`;
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
    return dir;
  },

  async createFile(parentUri, name, _mime) {
    // No native create step: the path is deterministic and writeString/
    // writeBinaryBytes creates the file. Mime is irrelevant on file://.
    return `${parentUri.replace(/\/$/, "")}/${name}`;
  },

  async readString(uri) {
    return FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.UTF8,
    });
  },

  async writeString(uri, content) {
    await FileSystem.writeAsStringAsync(uri, content, {
      encoding: FileSystem.EncodingType.UTF8,
    });
  },

  async readBinary(uri) {
    return FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
  },

  async writeBinaryBytes(uri, base64) {
    await FileSystem.writeAsStringAsync(uri, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
  },

  async delete(uri) {
    // idempotent so a retry after a partial archive doesn't crash.
    await FileSystem.deleteAsync(uri, { idempotent: true });
  },
};

/** SAF backend — a content:// tree URI granted by the document picker. */
const safFs: VaultFs = {
  isSaf: true,

  async listChildren(parentUri) {
    const children = await StorageAccessFramework.readDirectoryAsync(parentUri);
    return children.map((uri) => ({ uri, name: safLastSegment(uri) }));
  },

  async findChild(parentUri, name) {
    const children = await StorageAccessFramework.readDirectoryAsync(parentUri);
    return children.find((u) => safLastSegment(u) === name) ?? null;
  },

  async findSubdir(parentUri, name) {
    const children = await StorageAccessFramework.readDirectoryAsync(parentUri);
    return children.find((u) => safLastSegment(u) === name) ?? null;
  },

  async findOrCreateSubdir(parentUri, name) {
    const children = await StorageAccessFramework.readDirectoryAsync(parentUri);
    const existing = children.find((u) => safLastSegment(u) === name);
    if (existing) return existing;
    return StorageAccessFramework.makeDirectoryAsync(parentUri, name);
  },

  async createFile(parentUri, name, mime) {
    return StorageAccessFramework.createFileAsync(parentUri, name, mime);
  },

  async readString(uri) {
    return StorageAccessFramework.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.UTF8,
    });
  },

  async writeString(uri, content) {
    await StorageAccessFramework.writeAsStringAsync(uri, content, {
      encoding: FileSystem.EncodingType.UTF8,
    });
  },

  async readBinary(uri) {
    return StorageAccessFramework.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
  },

  async writeBinaryBytes(uri, base64) {
    await StorageAccessFramework.writeAsStringAsync(uri, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
  },

  async delete(uri) {
    // NOT idempotent: SAF deleteAsync throws when the tree permission was
    // revoked AND when the file is already gone. Callers wrap in try/catch.
    await StorageAccessFramework.deleteAsync(uri);
  },
};

/** Select the backend for a configured root, by whether it's a SAF URI. */
export function vaultFsFor(isSaf: boolean): VaultFs {
  return isSaf ? safFs : fileFs;
}

/** Select the backend for an arbitrary file URI by its scheme. Used by the
 * read/write-by-URI helpers, which operate on a caller-supplied URI rather than
 * the configured root (the URI itself carries the discriminator). */
export function fsForUri(uri: string): VaultFs {
  return uri.startsWith("content://") ? safFs : fileFs;
}
