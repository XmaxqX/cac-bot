/* campus a college Claim-Bot – Bookmarklet-Version.
   Läuft direkt im Tab der Artikelverwaltung, prüft alle 500 ms (einstellbar) auf neue Texte. */
(() => {
  const HOST = 'www.campus-a-college.at';
  if (window.__cacBot) { window.__cacBot.toggle(); return; }

  if (location.host !== HOST || !location.pathname.startsWith('/artikel') || location.pathname.startsWith('/artikel/')) {
    if (confirm('Der Bot läuft nur in der Artikelverwaltung von campus a college.\nJetzt dorthin wechseln? (Danach das Lesezeichen nochmal klicken.)')) {
      location.href = 'https://' + HOST + '/artikel';
    }
    return;
  }

  // ---------- Einstellungen & Zustand ----------
  const CFG_KEY = 'cacBotCfg', ST_KEY = 'cacBotState';
  const DEF = {
    v: 2, maxGoldstars: 0, allowedVersions: [1, 3, 5],
    blockedSchools: ['HTL Spengergasse'], blockedAuthors: [],
    // Honorar-Texte mit diesen Titeln nicht claimen (Teil-Treffer genügt)
    blockedHonorarTitles: [
      'IKB fragt dich: Wo würdest du in Innsbruck Solaranlagen bauen?',
      'IKB fragt dich: Wohin mit dem Strom, wenn ihn gerade niemand',
      'IKB fragt dich: Wer macht eigentlich unseren Strom?',
      'IKB fragt dich: Ein Tag ohne Strom – und dann?',
      'IKB fragt dich: Wie viel Wasserkraft braucht die Energiewende?',
    ],
    maxOpen: 1, stopAt100: false, intervalMs: 500,
  };
  const MIN_INTERVAL = 250;
  const interval = () => Math.max(MIN_INTERVAL, parseInt(cfg.intervalMs, 10) || DEF.intervalMs);
  const load = (k, d) => { try { return Object.assign({}, d, JSON.parse(localStorage.getItem(k) || '{}')); } catch (_) { return { ...d }; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };
  const month = () => new Date().toISOString().slice(0, 7);

  let cfg = load(CFG_KEY, DEF);
  // Migration alter gespeicherter Einstellungen: Version 5 + IKB-Sperre ergänzen
  {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch (_) {}
    if (stored && (stored.v || 1) < 2) {
      cfg.allowedVersions = [...new Set([...(cfg.allowedVersions || []), 5])].sort((a, b) => a - b);
      cfg.blockedHonorarTitles = DEF.blockedHonorarTitles.slice();
      cfg.v = DEF.v;
      save(CFG_KEY, cfg);
    }
  }
  let st = load(ST_KEY, { month: month(), count: 0, claimed: [], alerted100: false });
  if (st.month !== month()) st = { month: month(), count: 0, claimed: [], alerted100: false };

  let running = false, busy = false, timer = null;
  const open = [];               // { edit, title, win }
  const goldCache = new Map();
  const norm = (s) => (s || '').toLowerCase().replace(/[–—‐-]/g, '-').replace(/\s+/g, ' ').trim();

  // ---------- Seite lesen ----------
  function component() {
    const el = [...document.querySelectorAll('[x-data]')]
      .find((e) => (e.getAttribute('x-data') || '').includes('articleTableComponent'));
    return el && window.Alpine ? window.Alpine.$data(el) : null;
  }

  function rows() {
    return [...document.querySelectorAll('table tbody tr')].map((r) => {
      const c = r.cells, act = c[c.length - 1], au = c[5];
      const ver = (c[0]?.innerText || '').match(/Version\s*(\d+)/i);
      return {
        title: (c[0]?.querySelector('a')?.textContent || '').trim(),
        version: ver ? parseInt(ver[1], 10) : null,
        type: (c[1]?.innerText || '').trim(),
        status: (c[4]?.innerText || '').trim(),
        author: (au?.querySelector('span.font-bold')?.textContent || '').trim(),
        profile: au?.querySelector('a[href^="/profil/"]')?.getAttribute('href') || null,
        school: (c[6]?.innerText || '').trim(),
        edit: act?.querySelector('a[href^="/artikel/edit/"]')?.getAttribute('href') || null,
        locked: !!act?.querySelector('[data-tooltip-target]'),
      };
    }).filter((x) => x.edit && !x.locked && x.status === 'Ausstehend');
  }

  // Goldsterne ändern sich selten → Cache 6 h, auch über Neuladen hinweg
  const GOLD_KEY = 'cacBotGold', GOLD_TTL = 6 * 3600 * 1000;
  try {
    const saved = JSON.parse(localStorage.getItem(GOLD_KEY) || '{}');
    for (const [k, x] of Object.entries(saved)) if (Date.now() - x.t < GOLD_TTL) goldCache.set(k, x);
  } catch (_) {}
  const pending = new Map(); // laufende Profil-Abfragen, damit nichts doppelt geladen wird

  function goldstars(profile) {
    if (!profile) return Promise.resolve(null);
    const hit = goldCache.get(profile);
    if (hit && Date.now() - hit.t < GOLD_TTL) return Promise.resolve(hit.v);
    if (pending.has(profile)) return pending.get(profile);
    const p = (async () => {
      try {
        const doc = new DOMParser().parseFromString(await fetch(profile, { credentials: 'include' }).then((r) => r.text()), 'text/html');
        if (!doc.querySelector('[title="Sterne"]')) return null;
        const el = doc.querySelector('[title="Goldsterne"] span');
        const v = el ? parseInt(el.textContent.trim(), 10) || 0 : 0;
        goldCache.set(profile, { v, t: Date.now() });
        save(GOLD_KEY, Object.fromEntries(goldCache));
        return v;
      } catch (_) { return null; }
      finally { pending.delete(profile); }
    })();
    pending.set(profile, p);
    return p;
  }

  // ---------- Claimen ----------
  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(); o.frequency.value = 880; o.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.25);
    } catch (_) {}
  }

  async function claim(a) {
    let win = null;
    try { win = window.open(a.edit, '_blank'); } catch (_) {}
    if (!win) {
      // Pop-up blockiert: Bearbeiten-Seite im Hintergrund aufrufen, Link im Panel anzeigen
      try { await fetch(a.edit, { credentials: 'include' }); } catch (_) {}
    }
    open.push({ edit: a.edit, title: a.title, win });
    st.claimed.push(a.edit);
    st.count += 1;
    beep();
    document.title = '🔔 ' + a.title;
    log(`Geclaimt: ${a.title} (${a.author})` + (win ? '' : ' – Pop-up blockiert, Link unten'));
    if (st.count >= 100 && !st.alerted100) {
      st.alerted100 = true;
      log('⚠️ 100 Texte diesen Monat – kurze Meldung in die Gruppe schreiben!');
      if (cfg.stopAt100) stop();
    }
    save(ST_KEY, st);
    render();
  }

  async function tick() {
    if (!running || busy) return;
    busy = true;
    try {
      if (st.month !== month()) st = { month: month(), count: 0, claimed: [], alerted100: false };
      for (let i = open.length - 1; i >= 0; i--) if (open[i].win && open[i].win.closed) open.splice(i, 1);

      const d = component();
      if (d && typeof d.fetchRecords === 'function') {
        await d.fetchRecords();
        // Tabelle erst lesen, wenn Alpine sie neu gezeichnet hat
        if (window.Alpine && typeof window.Alpine.nextTick === 'function') await new Promise((r) => window.Alpine.nextTick(r));
      }
      setStatus(`Läuft · letzte Prüfung ${new Date().toLocaleTimeString('de-AT')}`);

      // Erst alle lokalen Regeln (kostet nichts), dann Profile parallel statt nacheinander prüfen
      const cands = rows().filter((a) =>
        !st.claimed.includes(a.edit) &&
        cfg.allowedVersions.includes(a.version) &&
        !(norm(a.type) === 'honorar' && cfg.blockedHonorarTitles.some((t) => t && norm(a.title).includes(norm(t)))) &&
        !cfg.blockedSchools.some((s) => s && norm(a.school).includes(norm(s))) &&
        !cfg.blockedAuthors.some((s) => s && norm(a.author) === norm(s)));
      const golds = await Promise.all(cands.map((a) => goldstars(a.profile)));

      for (let i = 0; i < cands.length; i++) {
        if (!running || open.length >= cfg.maxOpen) break;
        if (cfg.stopAt100 && st.count >= 100) break;
        if (golds[i] === null || golds[i] > cfg.maxGoldstars) continue;
        await claim(cands[i]);
      }
      render();
    } catch (e) {
      setStatus('Fehler: ' + e.message);
    } finally {
      busy = false;
    }
  }

  // Takt über einen Web Worker: wird in Hintergrund-Tabs nicht auf 1×/Minute gedrosselt wie setInterval
  let worker = null;
  function startTicker() {
    const ms = interval();
    const fallback = () => { if (worker) { worker.terminate(); worker = null; } if (!timer) timer = setInterval(tick, ms); };
    try {
      const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms});`], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = tick;
      worker.onerror = fallback; // z. B. wenn die Seite Worker per CSP verbietet
    } catch (_) { fallback(); }
  }
  function stopTicker() {
    if (worker) { worker.terminate(); worker = null; }
    clearInterval(timer); timer = null;
  }
  function start() { running = true; startTicker(); tick(); render(); }
  function stop() { running = false; stopTicker(); setStatus('Gestoppt'); render(); }

  // ---------- Panel ----------
  const box = document.createElement('div');
  box.id = 'cac-bot';
  box.innerHTML = `
<style>
#cac-bot{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:290px;background:#fff;border:2px solid #8e445f;border-radius:10px;
 box-shadow:0 6px 24px rgba(0,0,0,.25);font:13px system-ui,sans-serif;color:#222;padding:10px}
#cac-bot h3{margin:0 0 6px;font-size:14px;color:#8e445f;display:flex;justify-content:space-between}
#cac-bot button{border:0;border-radius:6px;padding:7px;font:inherit;font-weight:700;cursor:pointer;color:#fff}
#cac-bot .go{background:#2e7d32;width:100%}#cac-bot .go.on{background:#b3261e}
#cac-bot .x{background:none;color:#888;padding:0 4px}
#cac-bot label{display:block;font-weight:600;margin:6px 0 2px}
#cac-bot textarea,#cac-bot input[type=number],#cac-bot input[type=text]{width:100%;box-sizing:border-box;font:inherit}
#cac-bot textarea{height:38px}
#cac-bot .m{color:#666;font-size:11px}
#cac-bot #cac-log{max-height:90px;overflow:auto;font-size:11px;margin-top:6px;border-top:1px solid #eee;padding-top:4px}
#cac-bot #cac-open a{display:block;color:#8e445f;font-size:12px;margin:2px 0}
#cac-bot details{margin-top:6px}
</style>
<h3><span>Claim-Bot</span><button class="x" id="cac-hide" title="Ausblenden">✕</button></h3>
<div><b id="cac-count">0</b> <span class="m">diesen Monat · <span id="cac-n">0</span> offen</span></div>
<div class="m" id="cac-status">Gestoppt</div>
<button class="go" id="cac-go" style="margin-top:6px">Starten</button>
<div id="cac-open"></div>
<details><summary>Einstellungen</summary>
 <label>Max. Goldsterne der Autor:in</label><input type="number" id="cac-gold" min="0">
 <label>Erlaubte Versionen (z. B. 1, 3)</label><input type="text" id="cac-vers">
 <label>Prüf-Intervall in ms (min. 250)</label><input type="number" id="cac-int" min="250" step="50">
 <label>Max. gleichzeitig offen</label><input type="number" id="cac-max" min="1">
 <label>Gesperrte Schulen (pro Zeile)</label><textarea id="cac-schools"></textarea>
 <label>Gesperrte Autor:innen (pro Zeile)</label><textarea id="cac-authors"></textarea>
 <label>Gesperrte Honorar-Titel (pro Zeile)</label><textarea id="cac-titles"></textarea>
 <label><input type="checkbox" id="cac-100"> Bei 100 automatisch stoppen</label>
 <button class="go" id="cac-save" style="background:#8e445f;margin-top:6px">Speichern</button>
</details>
<div id="cac-log"></div>`;
  document.body.appendChild(box);
  const $ = (id) => box.querySelector('#' + id);
  const lines = (v) => v.split('\n').map((x) => x.trim()).filter(Boolean);

  function setStatus(t) { $('cac-status').textContent = t; }
  function log(t) {
    const p = document.createElement('div');
    p.textContent = new Date().toLocaleTimeString('de-AT') + ' ' + t;
    $('cac-log').prepend(p);
  }
  function render() {
    $('cac-count').textContent = st.count;
    $('cac-n').textContent = open.length;
    $('cac-go').textContent = running ? 'Stoppen' : 'Starten';
    $('cac-go').classList.toggle('on', running);
    const o = $('cac-open'); o.innerHTML = '';
    open.forEach((x, i) => {
      const a = document.createElement('a');
      a.href = x.edit; a.target = '_blank'; a.textContent = '✏️ ' + x.title;
      const done = document.createElement('a');
      done.href = '#'; done.textContent = '✓ fertig (Platz freigeben)';
      done.onclick = (e) => { e.preventDefault(); open.splice(i, 1); render(); };
      o.append(a, done);
    });
  }
  function fill() {
    $('cac-gold').value = cfg.maxGoldstars; $('cac-max').value = cfg.maxOpen;
    $('cac-vers').value = cfg.allowedVersions.join(', ');
    $('cac-int').value = interval();
    $('cac-titles').value = cfg.blockedHonorarTitles.join('\n');
    $('cac-schools').value = cfg.blockedSchools.join('\n'); $('cac-authors').value = cfg.blockedAuthors.join('\n');
    $('cac-100').checked = cfg.stopAt100;
  }

  $('cac-go').onclick = () => (running ? stop() : start());
  $('cac-hide').onclick = () => (box.style.display = 'none');
  $('cac-save').onclick = () => {
    cfg = {
      v: DEF.v,
      intervalMs: Math.max(MIN_INTERVAL, parseInt($('cac-int').value, 10) || DEF.intervalMs),
      blockedHonorarTitles: lines($('cac-titles').value),
      maxGoldstars: Math.max(0, parseInt($('cac-gold').value, 10) || 0),
      maxOpen: Math.max(1, parseInt($('cac-max').value, 10) || 1),
      allowedVersions: ($('cac-vers').value.match(/\d+/g) || []).map(Number),
      blockedSchools: lines($('cac-schools').value),
      blockedAuthors: lines($('cac-authors').value),
      stopAt100: $('cac-100').checked,
    };
    save(CFG_KEY, cfg); fill(); log('Einstellungen gespeichert');
    if (running) { stopTicker(); startTicker(); } // neues Intervall sofort übernehmen
  };

  window.__cacBot = { toggle: () => (box.style.display = box.style.display === 'none' ? '' : 'none') };
  fill(); render(); log('Bot geladen');
})();
