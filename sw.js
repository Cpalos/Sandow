// Sandow — Service Worker v3
// Gère le cache offline + les vérifications météo en arrière-plan
const CACHE_NAME = 'sandow-v3';
const MARINE_CACHE = 'sandow-data-v3';

const STATIC_ASSETS = [
  './',
  './index.html',
  './icon_192.png',
  './icon_512.png',
  './manifest.json',
];

// ── INSTALL ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME && k !== MARINE_CACHE)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH (cache strategy) ──
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.hostname.includes('open-meteo.com')) {
    // Météo : stale-while-revalidate (30 min TTL)
    e.respondWith(
      caches.open(MARINE_CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          const fetched = fetch(e.request).then(res => {
            if (res.ok) cache.put(e.request, res.clone());
            return res;
          }).catch(() => cached);
          // Serve cache si < 30min, sinon réseau
          if (cached) {
            const cachedDate = new Date(cached.headers.get('date') || 0);
            if (Date.now() - cachedDate < 30 * 60 * 1000) return cached;
          }
          return fetched;
        })
      )
    );
    return;
  }
  // App shell : cache-first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── PERIODIC BACKGROUND SYNC ──
// Vérifie les conditions météo en arrière-plan même app fermée
self.addEventListener('periodicsync', e => {
  if (e.tag === 'sandow-check') {
    e.waitUntil(checkConditionsAndNotify());
  }
});

// ── MESSAGE depuis l'app (pour sauvegarder les prefs dans le SW) ──
self.addEventListener('message', e => {
  if (e.data?.type === 'SAVE_SCHEDULE') {
    // Stocker le schedule dans le SW via IndexedDB-like approach
    saveScheduleToSW(e.data.schedule, e.data.prefs);
  }
  if (e.data?.type === 'CHECK_NOW') {
    checkConditionsAndNotify();
  }
});

// ── Stockage simple dans le cache pour les préférences ──
async function saveScheduleToSW(schedule, prefs) {
  const cache = await caches.open('sandow-config');
  const data = JSON.stringify({ schedule, prefs, savedAt: Date.now() });
  await cache.put('/sw-config', new Response(data, {
    headers: { 'Content-Type': 'application/json' }
  }));
}

async function loadScheduleFromSW() {
  try {
    const cache = await caches.open('sandow-config');
    const res = await cache.match('/sw-config');
    if (!res) return null;
    return await res.json();
  } catch { return null; }
}

// ── Vérification météo + notification si conditions bonnes ──
async function checkConditionsAndNotify() {
  const config = await loadScheduleFromSW();
  if (!config) return;

  const { schedule, prefs } = config;
  if (!schedule?.slots?.length) return;

  // Fetch météo
  let weather, marine;
  try {
    const [wRes, mRes] = await Promise.all([
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${prefs.lat}&longitude=${prefs.lon}&hourly=wind_speed_10m,precipitation&timezone=Europe%2FParis&forecast_days=3`),
      fetch(`https://marine-api.open-meteo.com/v1/marine?latitude=${prefs.lat}&longitude=${prefs.lon}&hourly=wave_height&timezone=Europe%2FParis&forecast_days=3`)
    ]);
    weather = await wRes.json();
    marine = await mRes.json();
  } catch { return; }

  const now = new Date();
  const times = weather.hourly?.time || [];
  const winds = weather.hourly?.wind_speed_10m || [];
  const precips = weather.hourly?.precipitation || [];
  const waves = marine.hourly?.wave_height || [];

  const slotMap = {
    matin: [6,7,8,9], midi: [11,12,13,14],
    aprem: [15,16,17], soir: [18,19,20,21]
  };
  const slotLabels = {
    matin:'Matin', midi:'Midi', aprem:'Après-midi', soir:'Soir'
  };

  // Fenêtres candidates (J et J+1)
  const candidates = [];
  times.forEach((t, i) => {
    const dt = new Date(t);
    if (dt <= now) return;
    const daysAhead = Math.floor((dt - now) / 86400000);
    if (daysAhead > 2) return;

    const h = dt.getHours();
    const dow = dt.getDay();
    if (!schedule.days?.includes(dow)) return;

    for (const slot of schedule.slots) {
      if (!slotMap[slot]?.includes(h)) continue;
      const wind = Math.round(winds[i] || 10);
      const wave = parseFloat((waves[i] || 0.5).toFixed(1));
      const precip = precips.slice(Math.max(0,i-24),i).reduce((a,b)=>a+(b||0),0);
      const score = computeScoreSW(wind, wave, precip, prefs);
      if (score >= (schedule.scoreMin || 65)) {
        candidates.push({ dt, score, wind, wave, slot, daysAhead });
      }
    }
  });

  if (!candidates.length) return;

  // Trier par score
  candidates.sort((a,b) => b.score - a.score);
  const best = candidates[0];

  // Vérifier si on a déjà notifié pour ce créneau
  const notifKey = `notified-${best.dt.toISOString().slice(0,13)}`;
  const cache = await caches.open('sandow-config');
  const alreadyNotified = await cache.match('/' + notifKey);
  if (alreadyNotified) return;

  // Marquer comme notifié
  await cache.put('/' + notifKey, new Response('1'));

  const dayLabel = best.daysAhead === 0 ? "aujourd'hui"
    : best.daysAhead === 1 ? 'demain'
    : `dans ${best.daysAhead} jours`;

  const title = `🎯 Sandow — Sortie ${dayLabel} !`;
  const body = `${slotLabels[best.slot]} ${best.dt.getHours()}h · Score ${best.score}/100\nVent ${best.wind} km/h · Houle ${best.wave} m`;

  await self.registration.showNotification(title, {
    body,
    icon: './icon_192.png',
    badge: './icon_192.png',
    tag: 'sandow-alert',
    renotify: true,
    requireInteraction: false,
    data: { url: './' }
  });
}

// Score simplifié pour le SW (pas accès aux prefs complètes)
function computeScoreSW(wind, wave, precip, prefs) {
  let penalties = 0, bonuses = 0;
  const windMax = prefs?.windMax || 15;
  const waveMax = prefs?.waveMax || 0.6;

  if (wind > 40) penalties += 75;
  else if (wind > 30) penalties += 60;
  else if (wind > 20) penalties += 42;
  else if (wind > 15) penalties += 28;
  else if (wind > windMax) penalties += 16;
  else if (wind <= 8) bonuses += 5;

  if (wave > 1.5) penalties += 50;
  else if (wave > 1.0) penalties += 35;
  else if (wave > 0.6) penalties += 20;
  else if (wave > waveMax) penalties += 10;
  else if (wave <= 0.3) bonuses += 5;

  if (precip > 20) penalties += 38;
  else if (precip > 10) penalties += 22;
  else if (precip > 3) penalties += 10;

  return Math.max(0, Math.min(95, Math.round(88 - penalties + Math.min(bonuses, 12))));
}

// ── NOTIFICATION CLICK → ouvrir l'app ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      return clients.openWindow('./');
    })
  );
});
