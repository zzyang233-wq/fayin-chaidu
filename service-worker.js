const CACHE_VERSION = 'v1-20260923-gloss-1';
const SHELL_CACHE = `fayin-chaidu-shell-${CACHE_VERSION}`;
const DATA_CACHE = `fayin-chaidu-data-${CACHE_VERSION}`;
const APP_SHELL = [
  './',
  './index.html',
  './offline.html',
  './sources.html',
  './style.css?v=20260923-gloss-1',
  './app.js?v=20260923-gloss-1',
  './install.js?v=20260923-gloss-1',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png',
  './data/catalog-meta.json',
  './data/search-index.json',
];

let offlinePreparation = null;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, DATA_CACHE]);
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('fayin-chaidu-') && !keep.has(key)).map(key => caches.delete(key)));
    await self.clients.claim();
    await notifyClients({type: 'SHELL_READY'});
    prepareOfflineDataset().catch(() => {});
  })());
});

function chunkPath(item) {
  const value = typeof item === 'string' ? item : (item.url || item.path || item.file || item.id || item.chunk_id);
  if (!value) return null;
  const text = String(value);
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith('./data/') || text.startsWith('data/')) return new URL(text, self.registration.scope).href;
  if (text.includes('/')) return new URL(text, new URL('./data/', self.registration.scope)).href;
  return new URL(`./data/chunks/${text.endsWith('.json') ? text : `${text}.json`}`, self.registration.scope).href;
}

function discoverChunkUrls(meta) {
  const manifest = meta.data_manifest || meta.manifest || {};
  const chunks = manifest.chunks || meta.chunks || manifest.files || [];
  const items = Array.isArray(chunks) ? chunks : Object.entries(chunks).map(([id, item]) => (
    typeof item === 'string' ? {id, url: item} : {id, ...item}
  ));
  return [...new Set(items.map(chunkPath).filter(Boolean))];
}

async function notifyClients(message) {
  const clients = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
  clients.forEach(client => client.postMessage(message));
}

async function cachedJson(path) {
  const cached = await caches.match(path);
  if (cached) return cached.json();
  const response = await fetch(path);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function cacheChunk(cache, url) {
  if (await cache.match(url)) return;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  await cache.put(url, response);
}

function prepareOfflineDataset() {
  if (offlinePreparation) return offlinePreparation;
  offlinePreparation = (async () => {
    try {
      const meta = await cachedJson('./data/catalog-meta.json');
      const urls = discoverChunkUrls(meta);
      const cache = await caches.open(DATA_CACHE);
      let done = 0;
      await notifyClients({type: 'OFFLINE_PROGRESS', done, total: urls.length});
      for (const url of urls) {
        await cacheChunk(cache, url);
        done += 1;
        await notifyClients({type: 'OFFLINE_PROGRESS', done, total: urls.length});
      }
      await cache.put('./offline-complete.json', new Response(JSON.stringify({version: CACHE_VERSION, chunks: urls.length}), {headers: {'Content-Type': 'application/json'}}));
      await notifyClients({type: 'OFFLINE_READY', total: urls.length});
    } catch (error) {
      await notifyClients({type: 'OFFLINE_ERROR', message: error.message});
      throw error;
    } finally {
      offlinePreparation = null;
    }
  })();
  return offlinePreparation;
}

self.addEventListener('message', event => {
  if (event.data?.type === 'PREPARE_OFFLINE') event.waitUntil(prepareOfflineDataset());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // External Commons audio is never bundled.

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(async response => {
          if (response.ok) (await caches.open(SHELL_CACHE)).put(event.request, response.clone());
          return response;
        })
        .catch(async () => (await caches.match(event.request)) || (await caches.match('./index.html')) || caches.match('./offline.html'))
    );
    return;
  }

  if (url.pathname.includes('/data/chunks/')) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(async response => {
      if (response.ok) (await caches.open(DATA_CACHE)).put(event.request, response.clone());
      return response;
    })));
    return;
  }

  event.respondWith(caches.match(event.request).then(cached => {
    // Versioned shell files already in cache remain usable without a network.
    if (cached) return cached;
    const network = fetch(event.request).then(async response => {
      if (response.ok) (await caches.open(SHELL_CACHE)).put(event.request, response.clone());
      return response;
    });
    return network;
  }));
});
