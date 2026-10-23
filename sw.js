const CACHE='campus-move-v26';
// Resolve every asset against the service worker's own scope, so the app works at / and at a subpath such as /pace-site/.
const SCOPE=self.registration.scope;
const ASSETS=['./','index.html','style.css','document.css','classroom.css','core.js','app.js','cloud-upload.js','cloud-live.js','mode.js','tiles.js','review.html','review.js','handout.html','guide.html','icon.svg','manifest.webmanifest','assets/classroom-hero.jpg','assets/classroom-connection.jpg','vendor/leaflet.js','vendor/leaflet.css'];
const ASSET_URLS=new Set(ASSETS.map(p=>new URL(p,SCOPE).href));
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll([...ASSET_URLS])).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('campus-move-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==self.location.origin||!ASSET_URLS.has(u.origin+u.pathname))return;e.respondWith(fetch(e.request).then(r=>{if(r.ok&&!r.redirected){const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));}return r;}).catch(()=>caches.match(e.request)));});
