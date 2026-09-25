/* App-shell cache — all vault data lives in IndexedDB, never in this cache. */
const CACHE = 'widespread-wallet-v1'
const SHELL = ['./', './index.html', './bundle.js', './manifest.webmanifest',
  './wsp_lez_wasm_bg.wasm', './icons/icon-192.png', './icons/icon-512.png']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.origin !== self.location.origin) return // sequencer/storage calls pass through
  e.respondWith(
    caches.match(e.request).then((hit) => hit ?? fetch(e.request)),
  )
})
