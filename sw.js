// Service worker minimale: esiste solo per far uscire l'app aggiunta alla Home (iOS/iPadOS)
// dalla cache "statica" del WebView standalone, che altrimenti puo' restare bloccata sulla
// versione salvata al primo avvio e non ricontrollare mai il server. Nessun caching qui:
// ogni richiesta passa sempre dalla rete, cosi' gli aggiornamenti si vedono al lancio successivo.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request, { cache: "no-store" }));
});
