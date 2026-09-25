# @widespread/storage-client

Browser-safe Logos Storage (Codex) client — the persistence layer for
client-side-encrypted vault blobs, recovery shares, and registry
artifacts. Thin wrapper over `@codex-storage/sdk-js` that works in
browser, extension-service-worker, and worker contexts (the upload
strategy is implemented here rather than importing the SDK's Node-only
one).

Widespread runs **no storage gateway** — `nodeUrl` points at a Codex
node the user runs (local or their own remote). Everything stored is
already ciphertext; the node sees opaque bytes.

## Usage

```ts
import { StorageClient } from '@widespread/storage-client'

const storage = new StorageClient({ nodeUrl: 'http://localhost:8080' })

const { cid } = await storage.upload(ciphertextBytes)

// Bytes the node already holds locally:
const local = await storage.localDownload(cid)

// Retrieval for content stored by another device — fetches over the
// Logos Storage network into the local node, then streams it back:
const bytes = await storage.networkDownload(cid)

await storage.manifest(cid) // block size, dataset size, codec
await storage.cids()        // what this node holds
```

Nodes requiring HTTP basic auth: `new StorageClient({ nodeUrl, basicAuth: 'user:pass' })`.

## Related

- `packages/recovery/src/storage.ts` (`RestStorageClient`) — a zero-dep
  fetch-based client with the same contract, for surfaces that don't
  bundle the Codex SDK.
- `crates/wsp-lez-core/src/storage.rs` — the native equivalent used by
  the CLI and `wsp-lezd`.
