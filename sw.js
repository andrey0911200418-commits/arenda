const C="avtodogovor-v5";
const SHELL=["./","./index.html","./contract.js","./ocr.js","./paddle.js","./manifest.webmanifest","./icon-192.png","./icon-512.png","./apple-touch-icon.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
function fromCacheFirst(r){return caches.match(r).then(h=>h||fetch(r).then(res=>{if(res.ok||res.type==="opaque"){const cp=res.clone();caches.open(C).then(c=>c.put(r,cp));}return res;}));}
self.addEventListener("fetch",e=>{
  const r=e.request; if(r.method!=="GET")return;
  const u=new URL(r.url), own=u.origin===self.location.origin;
  // модели нейросети (~10 МБ) и библиотеки с CDN: один раз скачали — дальше из памяти телефона
  if(own&&u.pathname.indexOf("/models/")>=0){e.respondWith(fromCacheFirst(r));return;}
  // vault.json — всегда свежий из сети
  if(own&&u.pathname.endsWith("/vault.json")){e.respondWith(fetch(r).catch(()=>caches.match(r)));return;}
  // свои файлы приложения: сначала сеть (обновления), без сети — из кэша
  if(own){e.respondWith(fetch(r).then(res=>{const cp=res.clone();caches.open(C).then(c=>c.put(r,cp));return res;}).catch(()=>caches.match(r).then(h=>h||caches.match("./index.html"))));return;}
  e.respondWith(fromCacheFirst(r));
});
