/* ==================================================
   LIVE-DATEN: MQTT, WEBSOCKET, REST, CHART
   --------------------------------------------------
   MQTT       direkt vom Browser zum HiveMQ-Broker (WSS),
              braucht den Raspberry Pi nicht.
   WebSocket  Node-RED auf dem Pi (z. B. per localhost.run).
   REST       Node-RED + Datenbank (Verlauf, Durchschnitt).
   Fehlt eine Quelle, bleibt die App mit Demo-/Browserdaten
   benutzbar.
   ================================================== */

(() => {
  'use strict';

  const TOPIC_ROOT = '/bbk-lf7';
  const SUBSCRIPTION = `${TOPIC_ROOT}/+/power-house/vibration`;
  const TOPIC_PATTERN = /^\/bbk-lf7\/([^/]+)\/power-house\/vibration$/;
  const HISTORY_MS = 5 * 60 * 1000;
  const STALE_MS = 10 * 1000;
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

    return config;
  }

  function saveConfig() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (error) {
      /* Speicher gesperrt: Konfiguration gilt nur bis zum Reload */
    }
  }

  const config = loadConfig();

  const state = {
    conn: {
      mqtt: { state: 'off', text: 'nicht gestartet' },
      ws: { state: 'off', text: 'nicht konfiguriert' },
      api: { state: 'off', text: 'nicht konfiguriert' }
    },
    last: { mqtt: null, ws: null },
    buffer: [],
    foreign: new Map(),
    history: { points: [], source: 'local', avg: null, count: 0 }
  };

  const demoText = $('vibration-value').textContent.trim();

  let mqttClient = null;
  let socket = null;
  let socketTimer = null;
  let chart = null;
  let lastDraw = 0;

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

  function describeFormat(sample, text) {
    if (!sample) return 'nicht auswertbar';
    if (sample.keys.length === 0) return 'Klartext-Zahl';

    return `JSON (${sample.keys.join(', ')})`;
  }

  /* ==================================================
     NEUER MESSWERT
     ================================================== */

  function onSample(source, sample) {
    const now = Date.now();
    const wsFresh = state.last.ws && now - state.last.ws.recv < STALE_MS / 2;

    state.last[source] = { ...sample, recv: now };

    /* WebSocket und MQTT liefern denselben Wert: nur einmal puffern */
    if (source === 'ws' || !wsFresh) {
      const ts = Math.abs(sample.ts - now) < 30000 ? sample.ts : now;

      state.buffer.push({ ts, value: sample.value });
    }

    state.buffer = state.buffer.filter((point) => now - point.ts <= HISTORY_MS);

    renderLive();

    if (isPanelOpen() && state.history.source === 'local' && now - lastDraw > 1000) {
      drawHistory();
    }
  }

  function latestSample() {
    const { mqtt, ws } = state.last;

    if (mqtt && ws) return mqtt.recv > ws.recv ? { ...mqtt, via: 'MQTT' } : { ...ws, via: 'WebSocket' };
    if (mqtt) return { ...mqtt, via: 'MQTT' };
    if (ws) return { ...ws, via: 'WebSocket' };

    return null;
  }

  /* ==================================================
     ANZEIGE: STATION, TOP-BAR, PANEL
     ================================================== */

  function setLevelClass(element, level, prefix) {
    element.classList.remove(`${prefix}ok`, `${prefix}warn`, `${prefix}alarm`);

    if (level) element.classList.add(`${prefix}${level}`);
  }

  function renderLive() {
    const sample = latestSample();
    const stationValue = $('vibration-value');
    const stationTag = $('vibration-tag');
    const bigValue = $('live-value');
    const meta = $('live-meta');

    if (!sample) {
      stationValue.textContent = demoText;
      setLevelClass(stationValue, null, 'lv-');
      stationTag.textContent = 'Demo';
      stationTag.dataset.state = 'demo';
      bigValue.textContent = '—';
      setLevelClass(bigValue, null, 'lv-');
      meta.textContent = config.kiste
        ? `Warte auf Daten von Kiste ${config.kiste} …`
        : 'Keine Kiste gewählt: Nummer eintragen oder unten „als Quelle“ klicken.';

      return;
    }

    const age = Date.now() - sample.recv;
    const stale = age > STALE_MS;
    const unit = sample.unit || 'mm/s';
    const level = stale ? null : levelOf(sample.value, sample.limits);
    const text = `${formatValue(sample.value)} ${unit}`;

    stationValue.textContent = text;
    setLevelClass(stationValue, level, 'lv-');
    stationTag.textContent = stale ? 'veraltet' : 'Live';
    stationTag.dataset.state = stale ? 'stale' : 'live';

    bigValue.textContent = text;
    setLevelClass(bigValue, level, 'lv-');
    meta.textContent =
      `Kiste ${config.kiste} · via ${sample.via} · ${formatTime(sample.recv)} (vor ${Math.round(age / 1000)} s)`;
  }

  function renderSummary() {
    const indicator = $('connection-indicator');
    const text = $('connection-text');
    const sample = latestSample();
    const fresh = sample && Date.now() - sample.recv < STALE_MS;
    const connected = state.conn.mqtt.state === 'ok' || state.conn.ws.state === 'ok';

    if (fresh) {
      indicator.dataset.state = 'live';
      text.textContent = `Live · ${sample.via}`;
    } else if (connected) {
      indicator.dataset.state = 'wait';
      text.textContent = config.kiste ? 'Verbunden · warte auf Daten' : 'Verbunden · Kiste wählen';
    } else {
      indicator.dataset.state = 'off';
      text.textContent = 'Offline · Demodaten';
    }
  }

  function setConn(name, connState, text) {
    state.conn[name] = { state: connState, text };

    const row = document.querySelector(`[data-conn="${name}"]`);

    if (row) {
      row.querySelector('.dot').dataset.state = connState;
      row.querySelector('.conn-text').textContent = text;
    }

    renderSummary();
  }

  /* ==================================================
     MQTT (Aufgaben 3, 3.1, 4)
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

  function handleMqtt(topic, text) {
    const match = TOPIC_PATTERN.exec(topic);

    if (!match) return;

    const crate = match[1];
    const sample = parsePayload(text);

    trackForeign(crate, sample, text);

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
     FREMDE TOPICS (Aufgabe 3.1)
     ================================================== */

  function trackForeign(crate, sample, text) {
    const now = Date.now();
    const entry = state.foreign.get(crate) || { crate, arrivals: [] };

    entry.arrivals.push(now);
    entry.arrivals = entry.arrivals.filter((t) => now - t <= 60000);
    entry.sample = sample;
    entry.format = describeFormat(sample, text);
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
     WEBSOCKET (Aufgabe 2)
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
     REST + VERLAUFS-CHART (Aufgaben 5, 7, 8)
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
    const limits = state.last.mqtt?.limits || state.last.ws?.limits || DEFAULT_LIMITS;
    const unit = (latestSample() || {}).unit || 'mm/s';

    $('avg-value').textContent = avg === null
      ? 'Ø letzte 5 Minuten: noch keine Daten'
      : `Ø letzte 5 Minuten: ${formatValue(avg)} ${unit} (${count} Werte)`;

    $('history-source').textContent = source === 'rest'
      ? 'Quelle: REST-Endpunkt /api/vibration/last5min und /avg5min (Datenbank auf dem Pi)'
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
    fillForm();
    renderLive();
    renderForeign();
    refreshHistory();
  }

  function closePanel() {
    $('data-panel').classList.remove('visible');
  }

  function fillForm() {
    $('cfg-kiste').value = config.kiste;
    $('cfg-ws').value = config.wsUrl;
    $('cfg-api').value = config.apiUrl;
    $('topic-own').textContent = config.kiste
      ? `${TOPIC_ROOT}/${config.kiste}/power-house/vibration`
      : `${TOPIC_ROOT}/<kistennummer>/power-house/vibration`;
  }

  function setCrate(crate) {
    if (crate === config.kiste) return;

    config.kiste = crate;
    state.last = { mqtt: null, ws: null };
    state.buffer = [];
    $('mqtt-raw').textContent = 'Warte auf die nächste Nachricht …';

    saveConfig();
    fillForm();
    renderLive();
    renderForeign();
    renderSummary();
    refreshHistory();
  }

  function applyForm(event) {
    event.preventDefault();

    const wsChanged = $('cfg-ws').value.trim() !== config.wsUrl;

    config.wsUrl = $('cfg-ws').value.trim();
    config.apiUrl = $('cfg-api').value.trim();
    saveConfig();

    if (wsChanged) connectWebSocket();

    const crate = cleanCrate($('cfg-kiste').value);

    if (crate !== config.kiste) {
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
  $('connection-status').addEventListener('click', openPanel);

  $('foreign-body').addEventListener('click', (event) => {
    const crate = event.target.dataset?.crate;

    if (crate) setCrate(crate);
  });

  setInterval(() => {
    renderLive();
    renderSummary();

    if (isPanelOpen()) renderForeign();
  }, 1000);

  setInterval(() => {
    if (isPanelOpen() && state.history.source === 'rest') refreshHistory();
  }, 5000);

  fillForm();
  renderLive();
  renderSummary();
  connectMqtt();
  connectWebSocket();

  /* Zugriff für die Seite und zum Testen in der Konsole */
  window.LiveData = {
    open: openPanel,
    close: closePanel,
    config,
    state,
    feedMqtt: handleMqtt
  };
})();
