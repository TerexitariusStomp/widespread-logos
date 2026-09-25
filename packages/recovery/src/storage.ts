/**
 * Logos Storage client — the only remote persistence the wallet uses.
 *
 * `StorageClient` is the seam: the browser build can bind logos-storage-js
 * (embedded client), while CLI/native surfaces talk to a storage node's
 * REST API. `RestStorageClient` implements the standard node endpoints:
 *
 *   POST /api/storage/v1/data                    -> returns the new CID
 *   GET  /api/storage/v1/data/{cid}/network      -> download bytes
 *   POST /api/storage/v1/storage/request/{cid}   -> request persistence
 *
 * Everything uploaded through here is already client-side encrypted
 * (wrapped shares, sealed vaults) — the node only ever sees ciphertext.
 */

export interface StorageClient {
  /** Upload ciphertext; returns the content identifier. */
  upload(data: Uint8Array): Promise<string>
  /** Download by CID. Throws if unavailable. */
  download(cid: string): Promise<Uint8Array>
  /** Ask the network to persist the CID (availability contract). */
  requestPersistence?(cid: string, params?: Record<string, unknown>): Promise<unknown>
}

export class RestStorageClient implements StorageClient {
  constructor(private baseUrl: string) {}

  async upload(data: Uint8Array): Promise<string> {
    const resp = await fetch(`${this.baseUrl}/api/storage/v1/data`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: data.slice().buffer as ArrayBuffer,
    })
    if (!resp.ok) throw new Error(`storage upload failed: ${resp.status}`)
    return (await resp.text()).trim()
  }

  async download(cid: string): Promise<Uint8Array> {
    const c = encodeURIComponent(cid)
    // Local read first; fall back to the network fetch stream for CIDs the
    // node hasn't pinned yet. `/network` (no /stream) was the old path.
    for (const path of [`data/${c}`, `data/${c}/network/stream`, `data/${c}/network`]) {
      const resp = await fetch(`${this.baseUrl}/api/storage/v1/${path}`)
      if (resp.ok) return new Uint8Array(await resp.arrayBuffer())
    }
    throw new Error(`storage download failed for ${cid}`)
  }

  async requestPersistence(cid: string, params: Record<string, unknown> = {}) {
    const resp = await fetch(
      `${this.baseUrl}/api/storage/v1/storage/request/${encodeURIComponent(cid)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tolerance: 0,
          expiry: 0,
          ...params,
        }),
      },
    )
    if (!resp.ok) throw new Error(`persistence request failed: ${resp.status}`)
    return resp.json().catch(() => ({}))
  }
}
