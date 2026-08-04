export interface TransportObject {
  key: string;
  revision?: string;
}

/** Transport moves opaque files; it does not define or reinterpret schemas. */
export interface TransportAdapter {
  readonly name: string;
  discover(): Promise<TransportObject[]>;
  fetch(key: string): Promise<Uint8Array>;
  put(key: string, content: Uint8Array, expectedRevision?: string): Promise<{ revision?: string }>;
}

// The filesystem repository is the Phase 1 adapter. WebDAV, S3, Git, and REST
// adapters can implement this interface without changing Markdown contracts.
