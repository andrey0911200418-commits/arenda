const C="avtodogovor-v3";
const SHELL=["./","./index.html","./contract.js","./ocr.js","./manifest.webmanifest","./icon-192.png","./icon-512.png","./apple-touch-icon.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
// Свои файлы: сначала сеть (чтобы обновления приходили), офлайн — из кэша. Библиотеки и шрифты с CDN: из кэша.
self.addEventListener("fetch",e=>{
  const r=e.request; if(r.method!=="GET")return;
  const own=new URL(r.url).origin===self.location.origin;
  if(own){e.respondWith(fetch(r).then(res=>{const cp=res.clone();caches.open(C).then(c=>c.put(r,cp));return res;}).catch(()=>caches.match(r).then(h=>h||caches.match("./index.html"))));return;}
  e.respondWith(caches.match(r).then(h=>h||fetch(r).then(res=>{if(res.ok||res.type==="opaque"){const cp=res.clone();caches.open(C).then(c=>c.put(r,cp));}return res;})));
});
