/* ==================================================
   LIVE-DATEN: MQTT, WEBSOCKET, REST, DEMO
   --------------------------------------------------
   MQTT       direkt vom Browser zum HiveMQ-Broker (WSS),
              braucht den Raspberry Pi nicht.
   WebSocket  Node-RED auf dem Pi (z. B. per localhost.run).
   REST       Node-RED + Datenbank (Verlauf, Durchschnitt).
   Demo       simulierte Werte, solange keine echte Quelle
              liefert (z. B. ohne WLAN bei der Vorführung).

   Die Oberfläche (ui.js) liest nur LiveData.snapshot() und
   reagiert auf das Ereignis "update".
   ================================================== */

(() => {
  'use strict';

  const TOPIC_ROOT = '/bbk-lf7';
  const SUBSCRIPTION = `${TOPIC_ROOT}/+/power-house/vibration`;
  const TOPIC_PATTERN = /^\/bbk-lf7\/([^/]+)\/power-house\/vibration$/;
  const HISTORY_MS = 5 * 60 * 1000;
  const STALE_MS = 10 * 1000;
  const DEMO_DELAY_MS = 8 * 1000;
  const REST_TIMEOUT_MS = 4000;
  const DEFAULT_LIMITS = { high: 4.5, highHigh: 7.1 };
  const STORAGE_KEY = 'ar-mockup-live-config';

  const DEFAULTS = {
    mqttUrl: 'wss://broker.hivemq.com:8884/mqtt',
    kiste: '',
    wsUrl: '',
    apiUrl: ''
  };

  const $ = (id) => document.getElementById(id);

  /* ==================================================
     KONFIGURATION (localStorage, per URL überschreibbar)
     z. B. ?kiste=7&wsUrl=wss://xyz.lhr.life/ws/vibration
     ================================================== */

  function loadConfig() {
    let stored = {};

    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch (error) {
      stored = {};
    }

    const config = { ...DEFAULTS, ...stored };
    const params = new URLSearchParams(location.search);

    for (const key of Object.keys(DEFAULTS)) {
      if (params.has(key)) {
        config[key] = params.get(key);
      }
    }

    /* automatisch gewählte Kiste (siehe autoPickCrate), nie gespeichert */
    config.auto = false;

    return config;
  }

  function saveConfig() {
    const { auto, ...persistent } = config;

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persistent));
    } catch (error) {
      /* Speicher gesperrt: Konfiguration gilt nur bis zum Reload */
    }
  }

  const config = loadConfig();
  const startedAt = Date.now();
  const listeners = [];

  const state = {
    conn: {
      mqtt: { state: 'off', text: 'nicht gestartet' },
      ws: { state: 'off', text: 'nicht konfiguriert' },
      api: { state: 'off', text: 'nicht konfiguriert' }
    },
    last: { mqtt: null, ws: null, demo: null },
    buffer: [],
    foreign: new Map(),
    history: { points: [], source: 'local', avg: null, count: 0 }
  };

  let mqttClient = null;
  let socket = null;
  let socketTimer = null;
  let chart = null;
  let lastDraw = 0;
  let demoStep = 0;

  /* ==================================================
     EREIGNISSE
     ================================================== */

  function emit() {
    for (const listener of listeners) listener();
  }

  /* ==================================================
     HILFSFUNKTIONEN
     ================================================== */

  const numberFormat = new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  const formatValue = (value) => numberFormat.format(value);

  const formatTime = (ms) =>
    new Date(ms).toLocaleTimeString('de-DE', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

  function toMs(value) {
    if (typeof value === 'number') {
      return value < 1e11 ? value * 1000 : value;
    }

    const parsed = Date.parse(value);

    return Number.isNaN(parsed) ? Date.now() : parsed;
  }

  function levelOf(value, limits) {
    const { high, highHigh } = limits || DEFAULT_LIMITS;

    if (value >= highHigh) return 'alarm';
    if (value >= high) return 'warn';

    return 'ok';
  }

  function cleanCrate(text) {
    return String(text || '').trim().replace(/[^\w-]/g, '');
  }

  function wsEndpoint(text) {
    const url = String(text || '').trim();

    if (!url) return '';

    return url.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
  }

  /* ==================================================
     NUTZLAST AUSWERTEN
     Die Gruppen senden unterschiedliche Formate (siehe
     Tabelle "Fremde Topics"): Klartext-Zahl oder JSON mit
     unterschiedlichen Feldnamen.
     ================================================== */

  function parsePayload(text) {
    let data;

    try {
      data = JSON.parse(text);
    } catch (error) {
      return null;
    }

    if (typeof data === 'number' && Number.isFinite(data)) {
      return { value: data, unit: '', ts: Date.now(), limits: null, keys: [] };
    }

    if (data && typeof data === 'object') {
      const value = Number(data.value ?? data.v);

      if (!Number.isFinite(value)) return null;

      const limits = data.limits && Number.isFinite(Number(data.limits.high))
        ? { high: Number(data.limits.high), highHigh: Number(data.limits.highHigh) }
        : null;

      return {
        value,
        unit: typeof data.unit === 'string' ? data.unit : '',
        ts: toMs(data.timestamp ?? data.sourceTimestamp ?? data.ts ?? Date.now()),
        limits,
        keys: Object.keys(data)
      };
    }

    return null;
  }

  function describeFormat(sample) {
    if (!sample) return 'nicht auswertbar';
    if (sample.keys.length === 0) return 'Klartext-Zahl';

    return `JSON (${sample.keys.join(', ')})`;
  }

  /* ==================================================
     NEUER MESSWERT
     ================================================== */

  const isFresh = (sample, now) => Boolean(sample) && now - sample.recv < STALE_MS;

  function onSample(source, sample) {
    const now = Date.now();
    const wsFresh = state.last.ws && now - state.last.ws.recv < STALE_MS / 2;

    state.last[source] = { ...sample, recv: now };

    /* echte Werte verdrängen die Demo-Werte im Verlauf */
    if (source !== 'demo') {
      state.buffer = state.buffer.filter((point) => !point.demo);
    }

    /* WebSocket und MQTT liefern denselben Wert: nur einmal puffern */
    if (source !== 'mqtt' || !wsFresh) {
      const ts = Math.abs(sample.ts - now) < 30000 ? sample.ts : now;

      state.buffer.push({ ts, value: sample.value, demo: source === 'demo' });
    }

    state.buffer = state.buffer.filter((point) => now - point.ts <= HISTORY_MS);

    renderLive();
    emit();

    if (isPanelOpen() && state.history.source === 'local' && now - lastDraw > 1000) {
      drawHistory();
    }
  }

  const VIA = { mqtt: 'MQTT', ws: 'WebSocket', demo: 'Demo' };

  function latestSample() {
    let best = null;

    for (const source of ['mqtt', 'ws', 'demo']) {
      const sample = state.last[source];

      if (sample && (!best || sample.recv > best.recv)) {
        best = { ...sample, via: VIA[source], demo: source === 'demo' };
      }
    }

    return best;
  }

  /* ==================================================
     DEMO-DATEN
     Langsamer Zyklus (90 s) mit Warn- und Alarmphase,
     damit sich bei der Vorführung die Ampel zeigen lässt.
     ================================================== */

  function demoWanted() {
    const now = Date.now();

    return now - startedAt > DEMO_DELAY_MS
      && !isFresh(state.last.mqtt, now)
      && !isFresh(state.last.ws, now);
  }

  function demoTick() {
    if (!demoWanted()) return;

    demoStep += 1;

    const phase = demoStep % 90;
    const bump = phase >= 40 && phase <= 80
      ? 5.4 * Math.sin(((phase - 40) / 40) * Math.PI)
      : 0;
    const value = 2 + 0.2 * Math.sin(demoStep / 5) + (Math.random() - 0.5) * 0.12 + bump;

    onSample('demo', {
      value: Math.round(value * 100) / 100,
      unit: 'mm/s',
      ts: Date.now(),
      limits: null,
      keys: []
    });
  }

  /* ==================================================
     ZUSAMMENFASSUNG FÜR DIE OBERFLÄCHE
     ================================================== */

  function summary() {
    const sample = latestSample();
    const now = Date.now();
    const fresh = isFresh(sample, now);
    const connected = state.conn.mqtt.state === 'ok' || state.conn.ws.state === 'ok';

    if (fresh && !sample.demo) {
      return { state: 'live', text: `Live · ${sample.via}` };
    }

    if (fresh && sample.demo) {
      return { state: 'demo', text: 'Demo-Daten' };
    }

    if (connected) {
      return { state: 'wait', text: config.kiste ? 'Warte auf Daten' : 'Verbunden' };
    }

    if (state.conn.mqtt.state === 'connecting') {
      return { state: 'wait', text: 'Verbinde …' };
    }

    return { state: 'off', text: 'Offline' };
  }

  function snapshot() {
    const sample = latestSample();
    const now = Date.now();
    const fresh = isFresh(sample, now);

    return {
      sample: sample && {
        ...sample,
        age: now - sample.recv,
        stale: !fresh,
        level: fresh ? levelOf(sample.value, sample.limits) : null,
        limits: sample.limits || DEFAULT_LIMITS,
        unit: sample.unit || 'mm/s'
      },
      buffer: state.buffer.map((point) => ({ ...point })),
      summary: summary(),
      crate: config.kiste,
      crateAuto: config.auto
    };
  }

  /* ==================================================
     ANZEIGE IM TECHNIK-PANEL
     ================================================== */

  function setLevelClass(element, level) {
    element.classList.remove('lv-ok', 'lv-warn', 'lv-alarm');

    if (level) element.classList.add(`lv-${level}`);
  }

  function renderLive() {
    const view = snapshot().sample;
    const bigValue = $('live-value');
    const meta = $('live-meta');

    if (!view) {
      bigValue.textContent = '—';
      setLevelClass(bigValue, null);
      meta.textContent = 'Warte auf Daten …';

      return;
    }

    bigValue.textContent = `${formatValue(view.value)} ${view.unit}`;
    setLevelClass(bigValue, view.level);

    const crate = config.kiste
      ? `Kiste ${config.kiste}${config.auto ? ' (automatisch gewählt)' : ''} · `
      : '';

    meta.textContent =
      `${crate}via ${view.via} · ${formatTime(view.recv)} (vor ${Math.round(view.age / 1000)} s)`;
  }

  function setConn(name, connState, text) {
    state.conn[name] = { state: connState, text };

    const row = document.querySelector(`[data-conn="${name}"]`);

    if (row) {
      row.querySelector('.dot').dataset.state = connState;
      row.querySelector('.conn-text').textContent = text;
    }

    emit();
  }

  /* ==================================================
     MQTT
     ================================================== */

  function connectMqtt() {
    if (typeof mqtt === 'undefined') {
      setConn('mqtt', 'error', 'mqtt.js konnte nicht geladen werden');

      return;
    }

    if (mqttClient) mqttClient.end(true);

    setConn('mqtt', 'connecting', `verbinde mit ${config.mqttUrl} …`);

    mqttClient = mqtt.connect(config.mqttUrl, {
      clientId: `ar-mockup-${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 3000,
      connectTimeout: 8000,
      clean: true
    });

    mqttClient.on('connect', () => {
      setConn('mqtt', 'ok', `verbunden, abonniert: ${SUBSCRIPTION}`);
      mqttClient.subscribe(SUBSCRIPTION, { qos: 0 });
    });

    mqttClient.on('reconnect', () => setConn('mqtt', 'connecting', 'verbinde erneut …'));
    mqttClient.on('offline', () => setConn('mqtt', 'error', 'offline'));
    mqttClient.on('error', (error) => setConn('mqtt', 'error', error.message));
    mqttClient.on('message', (topic, payload) => handleMqtt(topic, payload.toString()));
  }

  /*
   * Ohne eingetragene Kiste nimmt die App die erste Kiste, die
   * auswertbare Werte sendet. So zeigt die Vorführung sofort Daten.
   * Die eigene Kiste lässt sich jederzeit im Technik-Panel setzen.
   */
  let firstMessageAt = 0;

  function autoPickCrate(crate, sample) {
    if (config.kiste || !sample) return;

    /* 3 s sammeln, damit eine Kiste mit Einheit und Grenzwerten bevorzugt wird */
    firstMessageAt ||= Date.now();

    if (!sample.limits && Date.now() - firstMessageAt < 3000) return;

    config.kiste = crate;
    config.auto = true;

    fillForm();
    renderForeign();
  }

  function handleMqtt(topic, text) {
    const match = TOPIC_PATTERN.exec(topic);

    if (!match) return;

    const crate = match[1];
    const sample = parsePayload(text);

    trackForeign(crate, sample, text);
    autoPickCrate(crate, sample);

    if (crate !== config.kiste) return;

    showRaw(topic, text, sample);

    if (sample) onSample('mqtt', sample);
  }

  function showRaw(topic, text, sample) {
    let pretty = text;

    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch (error) {
      /* Klartext bleibt Klartext */
    }

    const value = sample ? `${formatValue(sample.value)} ${sample.unit || 'mm/s'}` : 'nicht auswertbar';

    $('mqtt-raw').textContent =
      `Topic:      ${topic}\nEmpfangen:  ${formatTime(Date.now())}\nVibration:  ${value}\n\n${pretty}`;
  }

  /* ==================================================
     FREMDE TOPICS
     ================================================== */

  function trackForeign(crate, sample, text) {
    const now = Date.now();
    const entry = state.foreign.get(crate) || { crate, arrivals: [] };

    entry.arrivals.push(now);
    entry.arrivals = entry.arrivals.filter((t) => now - t <= 60000);
    entry.sample = sample;
    entry.format = describeFormat(sample);
    entry.bytes = new TextEncoder().encode(text).length;
    entry.lastSeen = now;

    state.foreign.set(crate, entry);
  }

  function renderForeign() {
    const body = $('foreign-body');
    const now = Date.now();
    const entries = [...state.foreign.values()].sort((a, b) =>
      a.crate.localeCompare(b.crate, 'de', { numeric: true })
    );

    body.replaceChildren();

    if (entries.length === 0) {
      const row = body.insertRow();
      const cell = row.insertCell();

      cell.colSpan = 6;
      cell.textContent = 'Noch keine Nachrichten empfangen.';

      return;
    }

    for (const entry of entries) {
      const row = body.insertRow();
      const own = entry.crate === config.kiste;
      const perMinute = entry.arrivals.filter((t) => now - t <= 60000).length;
      const sample = entry.sample;

      row.classList.toggle('own', own);
      row.insertCell().textContent = own ? `${entry.crate} ★` : entry.crate;
      row.insertCell().textContent = entry.format;
      row.insertCell().textContent = sample
        ? `${formatValue(sample.value)} ${sample.unit || ''}`.trim()
        : '—';
      row.insertCell().textContent = String(perMinute);
      row.insertCell().textContent = `${entry.bytes} B`;

      const action = row.insertCell();

      if (!own) {
        const button = document.createElement('button');

        button.type = 'button';
        button.className = 'small-button';
        button.textContent = 'als Quelle';
        button.dataset.crate = entry.crate;
        action.append(button);
      }
    }
  }

  /* ==================================================
     WEBSOCKET
     ================================================== */

  function connectWebSocket() {
    clearTimeout(socketTimer);

    if (socket) {
      socket.onclose = null;
      socket.close();
      socket = null;
    }

    const url = wsEndpoint(config.wsUrl);

    if (!url) {
      setConn('ws', 'off', 'nicht konfiguriert');

      return;
    }

    setConn('ws', 'connecting', `verbinde mit ${url} …`);

    try {
      socket = new WebSocket(url);
    } catch (error) {
      setConn('ws', 'error', error.message);

      return;
    }

    socket.onopen = () => setConn('ws', 'ok', `verbunden: ${url}`);

    socket.onmessage = (event) => {
      const sample = parsePayload(String(event.data));

      if (sample) onSample('ws', sample);
    };

    socket.onerror = () => setConn('ws', 'error', 'Fehler (Tunnel/URL prüfen)');

    socket.onclose = () => {
      setConn('ws', 'error', 'getrennt, neuer Versuch in 5 s');
      socketTimer = setTimeout(connectWebSocket, 5000);
    };
  }

  /* ==================================================
     REST + VERLAUFS-CHART
     ================================================== */

  async function getJson(path) {
    const base = config.apiUrl.trim().replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);

    try {
      const response = await fetch(base + path, { signal: controller.signal });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function useLocalHistory() {
    const values = state.buffer.map((point) => point.value);
    const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

    state.history = { points: [...state.buffer], source: 'local', avg, count: values.length };
  }

  async function refreshHistory() {
    if (!config.apiUrl.trim()) {
      setConn('api', 'off', 'nicht konfiguriert');
      useLocalHistory();
      drawHistory();

      return;
    }

    try {
      const [rows, average] = await Promise.all([
        getJson('/api/vibration/last5min'),
        getJson('/api/vibration/avg5min')
      ]);

      state.history = {
        points: rows.map((row) => ({ ts: toMs(row.ts), value: Number(row.value) })),
        source: 'rest',
        avg: average.avg === null ? null : Number(average.avg),
        count: Number(average.count ?? rows.length)
      };

      setConn('api', 'ok', `${rows.length} Werte aus der Datenbank`);
    } catch (error) {
      const reason = error.name === 'AbortError' ? 'Timeout' : error.message;

      setConn('api', 'error', `${reason}, nutze Browser-Puffer`);
      useLocalHistory();
    }

    drawHistory();
  }

  function ensureChart() {
    if (chart || typeof Chart === 'undefined') return chart;

    const line = (label, color, dashed) => ({
      label,
      data: [],
      borderColor: color,
      backgroundColor: color,
      borderWidth: dashed ? 1 : 2,
      borderDash: dashed ? [6, 4] : [],
      pointRadius: 0,
      tension: 0.25
    });

    chart = new Chart($('history-chart'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          line('Vibration (mm/s)', '#35d06f', false),
          line('Warnung', '#ffc107', true),
          line('Alarm', '#ff3b30', true)
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'nearest', intersect: false },
        scales: {
          x: { ticks: { color: '#aeb8c2', maxTicksLimit: 6 }, grid: { color: 'rgba(255,255,255,0.06)' } },
          y: { beginAtZero: true, ticks: { color: '#aeb8c2' }, grid: { color: 'rgba(255,255,255,0.06)' } }
        },
        plugins: { legend: { labels: { color: '#aeb8c2', boxWidth: 12 } } }
      }
    });

    return chart;
  }

  function drawHistory() {
    lastDraw = Date.now();

    const { points, source, avg, count } = state.history;
    const view = snapshot().sample;
    const limits = view ? view.limits : DEFAULT_LIMITS;
    const unit = view ? view.unit : 'mm/s';

    $('avg-value').textContent = avg === null
      ? 'Ø letzte 5 Minuten: noch keine Daten'
      : `Ø letzte 5 Minuten: ${formatValue(avg)} ${unit} (${count} Werte)`;

    $('history-source').textContent = source === 'rest'
      ? 'Quelle: Datenbank auf dem Pi (REST)'
      : 'Quelle: Browser-Puffer (REST nicht erreichbar oder nicht konfiguriert)';

    const target = ensureChart();

    if (!target) return;

    const step = Math.ceil(points.length / 400) || 1;
    const shown = points.filter((_, index) => index % step === 0);

    target.data.labels = shown.map((point) => formatTime(point.ts));
    target.data.datasets[0].data = shown.map((point) => point.value);
    target.data.datasets[1].data = shown.map(() => limits.high);
    target.data.datasets[2].data = shown.map(() => limits.highHigh);
    target.update('none');
  }

  /* ==================================================
     PANEL + EINSTELLUNGEN
     ================================================== */

  const isPanelOpen = () => $('data-panel').classList.contains('visible');

  function openPanel() {
    $('data-panel').classList.add('visible');
    document.body.classList.add('panel-open');
    fillForm();
    renderLive();
    renderForeign();
    refreshHistory();
  }

  function closePanel() {
    $('data-panel').classList.remove('visible');
    document.body.classList.remove('panel-open');
  }

  function fillForm() {
    $('cfg-kiste').value = config.kiste;
    $('cfg-ws').value = config.wsUrl;
    $('cfg-api').value = config.apiUrl;
    $('topic-own').textContent = config.kiste
      ? `${TOPIC_ROOT}/${config.kiste}/power-house/vibration`
      : `${TOPIC_ROOT}/<kistennummer>/power-house/vibration`;
  }

  function setCrate(crate, auto = false) {
    if (crate === config.kiste && auto === config.auto) return;

    config.kiste = crate;
    config.auto = auto;
    state.last = { mqtt: null, ws: null, demo: null };
    state.buffer = [];
    $('mqtt-raw').textContent = 'Warte auf die nächste Nachricht …';

    if (!auto) saveConfig();

    fillForm();
    renderLive();
    renderForeign();
    refreshHistory();
    emit();
  }

  function applyForm(event) {
    event.preventDefault();

    const wsChanged = $('cfg-ws').value.trim() !== config.wsUrl;

    config.wsUrl = $('cfg-ws').value.trim();
    config.apiUrl = $('cfg-api').value.trim();
    saveConfig();

    if (wsChanged) connectWebSocket();

    const crate = cleanCrate($('cfg-kiste').value);

    if (crate !== config.kiste || config.auto) {
      setCrate(crate);
    } else {
      fillForm();
      refreshHistory();
    }
  }

  /* ==================================================
     START
     ================================================== */

  $('data-close').addEventListener('click', closePanel);
  $('cfg-form').addEventListener('submit', applyForm);
  $('history-refresh').addEventListener('click', refreshHistory);

  $('foreign-body').addEventListener('click', (event) => {
    const crate = event.target.dataset?.crate;

    if (crate) setCrate(crate);
  });

  setInterval(() => {
    demoTick();
    renderLive();
    emit();

    if (isPanelOpen()) renderForeign();
  }, 1000);

  setInterval(() => {
    if (isPanelOpen() && state.history.source === 'rest') refreshHistory();
  }, 5000);

  fillForm();
  renderLive();
  connectMqtt();
  connectWebSocket();

  /* Zugriff für die Oberfläche und zum Testen in der Konsole */
  window.LiveData = {
    open: openPanel,
    close: closePanel,
    isOpen: isPanelOpen,
    snapshot,
    onUpdate: (listener) => listeners.push(listener),
    config,
    state,
    feedMqtt: handleMqtt
  };
})();
