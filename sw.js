const CACHE='tigers-probability-production-v4.0.1-20260923-1';
const CORE=['./','./index.html','./manifest.webmanifest','./icon.svg','./v10.css?v=production-v4.0.1-1','./rosters.js?v=production-20260923-1','./stats-v13.js?v=production-20260923-1','./app-v10.js?v=production-v4.0.1-1','./league-data-2026.mjs?v=production-20260923-1','./league-simulator-core.mjs?v=production-v4.0.0-1','./league-simulator-ui.mjs?v=production-20260923-1','./what-if-base-context.mjs','./what-if-scenario.mjs','./scenario-store.mjs','./what-if-simulator.mjs'];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)));
  self.skipWaiting();
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE&&(k.startsWith('tigers-probability-production-')||k==='tigers-probability-v2.0.2-trial')).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET') return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin) return;
  if(!CORE.some(asset=>new URL(asset,self.location.href).pathname===url.pathname)) return;
  if(event.request.mode==='navigate'){
    event.respondWith(
      fetch(event.request).then(r=>{
        const copy=r.clone(); caches.open(CACHE).then(c=>c.put('./index.html',copy)); return r;
      }).catch(()=>caches.match('./index.html'))
    );
    return;
  }
  event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request).then(r=>{
    const copy=r.clone(); caches.open(CACHE).then(c=>c.put(event.request,copy)); return r;
  })));
});
