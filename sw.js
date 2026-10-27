/* Finanças — service worker: guarda os arquivos do app no celular. Os dados vêm sempre da planilha (pela ponte). */
const CACHE = 'financas-0bb05ac445';
const SHELL = ['./', './ponte.js', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png'];
const LIBS = ['https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL).then(() => Promise.all(LIBS.map(u => c.add(new Request(u, { mode: 'cors' })).catch(() => { })))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

/* arquivos do app: busca a versão nova; se a internet estiver lenta (3,5 s) ou fora, usa a cópia guardada */
function networkFirst(req) {
  const nav = req.mode === 'navigate';
  const fromCache = () => caches.match(req, { ignoreSearch: nav }).then(r => r || (nav ? caches.match('./') : undefined));
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done && r) { done = true; resolve(r); } };
    const timer = setTimeout(() => fromCache().then(finish), 3500);
    // sempre confere com o servidor (o GitHub Pages manda guardar por 10 min; assim a versão nova chega na hora)
    (nav ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(new Request(req, { cache: 'no-cache' }))).then(r => {
      if (r && r.ok && r.type === 'basic') { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); }
      clearTimeout(timer); finish(r);
    }).catch(() => fromCache().then(r => { clearTimeout(timer); finish(r || Response.error()); }));
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (/(^|\.)script\.google(usercontent)?\.com$/.test(u.hostname)) return;   // planilha: sempre direto
  if (u.origin === self.location.origin) { e.respondWith(networkFirst(req)); return; }
  // bibliotecas e fontes: usa a cópia guardada; se não tiver, busca e guarda
  e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
    if (res && (res.ok || res.type === 'opaque')) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); }
    return res;
  })));
});
