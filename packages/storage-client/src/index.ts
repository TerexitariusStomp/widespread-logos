/**
 * @widespread/storage-client — Logos Storage (Codex) client for the
 * wallet path.
 *
 * Everything stored here is already client-side ciphertext: the sealed
 * vault blob and the PRF-wrapped `S_id` share. The client never sees
 * plaintext key material — it only moves opaque bytes.
 *
 * Transport is the upstream `@codex-storage/sdk-js` against a Codex node
 * REST endpoint (default http://localhost:8080 — the user runs the node;
 * Widespread operates no storage gateway).
 */

import { Codex, CodexError, type SafeValue } from "@codex-storage/sdk-js";

export interface StorageClientOptions {
  /** Codex node REST base URL, e.g. http://localhost:8080 */
  nodeUrl: string;
  /** Optional HTTP basic-auth credential for nodes that require it. */
  basicAuth?: string;
}

export interface UploadResult {
  cid: string;
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export class StorageClient {
  private readonly data;

  constructor(options: StorageClientOptions) {
    const codex = new Codex(options.nodeUrl, {
      auth: options.basicAuth ? { basic: options.basicAuth } : undefined,
    });
    this.data = codex.data;
  }

  /**
   * Upload bytes to the node's local storage. Returns the CID by which
   * any node in the network can retrieve the content.
   */
  async upload(bytes: Uint8Array): Promise<UploadResult> {
    const strategy = new BytesUploadStrategy(bytes);
    const res = await this.data.upload(strategy).result;
    if (res.error || !res.data) {
      throw new StorageError(`upload failed: ${JSON.stringify(res)}`);
    }
    return { cid: res.data };
  }

  /**
   * Fetch content the node already holds locally. Throws if the CID is
   * not available locally — callers wanting network retrieval should use
   * {@link networkDownload} (async fetch via the network).
   */
  async localDownload(cid: string): Promise<Uint8Array> {
    const res = await this.data.localDownload(cid);
    if (res.error || !res.data) {
      throw new StorageError(`local download failed for ${cid}`);
    }
    return new Uint8Array(await res.data.arrayBuffer());
  }

  /**
   * Download content from the Logos Storage network into the local node,
   * then stream it back. This is the retrieval path for vault blobs and
   * `S_id` shares stored by another device.
   */
  async networkDownload(cid: string): Promise<Uint8Array> {
    const res = await this.data.networkDownloadStream(cid);
    if (res.error || !res.data) {
      throw new StorageError(`network download failed for ${cid}`);
    }
    return new Uint8Array(await res.data.arrayBuffer());
  }

  /** Manifest metadata for a CID (block size, dataset size, codec). */
  async manifest(cid: string): Promise<unknown> {
    const res = await this.data.fetchManifest(cid);
    if (res.error) {
      throw new StorageError(`manifest fetch failed for ${cid}`);
    }
    return res.data;
  }

  /** CIDs the node currently holds locally. */
  async cids(): Promise<unknown> {
    const res = await this.data.cids();
    if (res.error) {
      throw new StorageError("could not list local CIDs");
    }
    return res.data;
  }
}

/**
 * Minimal upload strategy implementing the SDK's `UploadStrategy`
 * interface — wraps a Uint8Array payload for the multipart POST to
 * `{base}/data`. Implemented here rather than importing the Node-only
 * strategy so the same code path works in browser, extension, and
 * worker contexts.
 */
class BytesUploadStrategy {
  constructor(private readonly bytes: Uint8Array) {}

  async upload(
    url: string,
    options?: { auth?: { basic?: string } },
  ): Promise<SafeValue<string>> {
    try {
      // Codex upload is a raw-body POST with attachment disposition —
      // matching NodeUploadStrategy (no multipart).
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": 'attachment; filename="blob"',
          ...(options?.auth?.basic
            ? { Authorization: `Basic ${options.auth.basic}` }
            : {}),
        },
        body: this.bytes.slice().buffer as ArrayBuffer,
      });
      if (!res.ok) {
        return {
          error: true,
          data: new CodexError(`upload failed: HTTP ${res.status}`, {
            code: res.status,
          }),
        };
      }
      return { error: false, data: await res.text() };
    } catch (e) {
      return { error: true, data: new CodexError(String(e)) };
    }
  }

  abort(): void {}
}
