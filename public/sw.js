// D´Padrones — service worker
//
// OJO AL DESPLEGAR: sube el número de CACHE en CADA cambio del front.
// El navegador solo avisa de que hay versión nueva cuando ESTE archivo cambia.
// En una aplicación anterior estuvo dos meses sin tocarse y seis arreglos seguidos nunca
// llegaron a los teléfonos, mientras dábamos el trabajo por terminado. La
// versión se ve al pie de Ajustes: si no coincide, ese aparato tiene código
// viejo y no vale para probar nada.
const CACHE = 'dp-v20260831-2';

const ASSETS = [
  './',
  './index.html',
  './estilos.css',
  './app.js',
  './manifest.json',
  './img/logo.png',
  './img/icono-192.png',
  './img/icono-512.png',
  './img/icono-maskable-512.png',
  './img/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // cache:'reload' salta la caché HTTP del navegador: sin esto el service
      // worker nuevo puede volver a guardarse la página vieja.
      .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Tocar el aviso del teléfono trae la aplicación a la pantalla en vez de abrir
// otra copia: quien lo toca quiere ver el pedido, no quedarse con dos ventanas
// de la caja abiertas y el carrito a medias en una de las dos.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(vs => {
      for (const v of vs) if ('focus' in v) return v.focus();
      if (self.clients.openWindow) return self.clients.openWindow('./');
    }));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;   // los datos nunca se cachean

  const esHTML = req.mode === 'navigate' || req.destination === 'document';
  if (esHTML) {
    e.respondWith(
      fetch(req).then(r => {
        if (r && r.status === 200) { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); }
        return r;
      }).catch(() => caches.match(req).then(c => c || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(c => c || fetch(req).then(r => {
      if (r && r.status === 200 && r.type !== 'opaque') {
        const cl = r.clone(); caches.open(CACHE).then(x => x.put(req, cl));
      }
      return r;
    }))
  );
});
