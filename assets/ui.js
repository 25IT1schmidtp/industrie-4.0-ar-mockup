/* ==================================================
   OBERFLÄCHE: KARTE AM MARKER, STATUS, VERLAUF
   --------------------------------------------------
   Zustände (body[data-ar]):
     searching  Kamera läuft, Hinweis "Marker suchen"
     tracking   Marker erkannt, Karte hängt am Marker
     docked     Vorführung ohne Marker, Karte unten mittig
   ================================================== */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const LOST_DELAY_MS = 1500;
  const ANCHOR_TIMEOUT_MS = 400;
  const SPARK_WINDOW_MS = 60 * 1000;
  const COLORS = { ok: '#35d06f', warn: '#ffc107', alarm: '#ff3b30', none: '#6b7580' };
  const LEVEL_TEXT = { ok: 'Normal', warn: 'Erhöht', alarm: 'Kritisch' };

  const scene = document.querySelector('a-scene');
  const marker = $('hiro-marker');
  const card = $('ar-card');
  const spark = $('card-spark');

  const numberFormat = new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  let mode = 'searching';
  let lostTimer = null;
  let anchorSeenAt = 0;
  let cardSize = { w: 300, h: 300 };
  let smooth = null;

  /* ==================================================
     ZUSTAND
     ================================================== */

  function setMode(next) {
    mode = next;
    document.body.dataset.ar = next;
    smooth = null;
    measureCard();
    render();
  }

  function measureCard() {
    cardSize = { w: card.offsetWidth || 300, h: card.offsetHeight || 300 };
  }

  marker.addEventListener('markerFound', () => {
    clearTimeout(lostTimer);
    setMode('tracking');
  });

  marker.addEventListener('markerLost', () => {
    clearTimeout(lostTimer);
    lostTimer = setTimeout(() => {
      if (mode === 'tracking') setMode('searching');
    }, LOST_DELAY_MS);
  });

  $('demo-button').addEventListener('click', () => setMode('docked'));
  $('card-close').addEventListener('click', (event) => {
    event.stopPropagation();
    setMode('searching');
  });

  for (const id of ['details-button', 'connection-status', 'card-more']) {
    $(id).addEventListener('click', (event) => {
      event.stopPropagation();
      LiveData.open();
    });
  }

  card.addEventListener('click', () => LiveData.open());

  /* ==================================================
     KARTE AM MARKER POSITIONIEREN
     Der Marker wird mit der Kamera-Matrix in Bildschirm-
     koordinaten umgerechnet. Die Karte sitzt über der
     oberen Markerkante (oder darunter, wenn oben kein Platz
     ist), eine Linie führt zur Markermitte.
     ================================================== */

  const THREE = AFRAME.THREE;
  const probe = new THREE.Vector3();

  function project(rect, camera, x, z) {
    probe.set(x, 0, z).applyMatrix4(marker.object3D.matrixWorld).project(camera);

    return {
      x: rect.left + ((probe.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - probe.y) / 2) * rect.height,
      depth: probe.z
    };
  }

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  function placeCard() {
    const camera = scene.camera;
    const canvas = scene.renderer && scene.renderer.domElement;

    if (!camera || !canvas || !marker.object3D.visible) return;

    /*
     * Die Kamera-Projektion gilt für das ganze Kamerabild. Dessen Fläche
     * (AR.js legt es mit "cover" über den Bildschirm) dient als Bezug.
     */
    const source = document.getElementById('arjs-video') || canvas;
    const rect = source.getBoundingClientRect();
    const center = project(rect, camera, 0, 0);
    const top = project(rect, camera, 0, -0.5);
    const bottom = project(rect, camera, 0, 0.5);
    const left = project(rect, camera, -0.5, 0);
    const right = project(rect, camera, 0.5, 0);
    const values = [center, top, bottom, left, right].flatMap((p) => [p.x, p.y]);

    if (!values.every(Number.isFinite) || center.depth > 1) return;

    anchorSeenAt = performance.now();

    const markerPx = Math.hypot(right.x - left.x, right.y - left.y);
    const scale = clamp(markerPx / 160, 0.8, 1);
    const width = cardSize.w * scale;
    const height = cardSize.h * scale;
    const topLimit = $('topbar').offsetHeight + 12;
    const gap = 16;

    const above = top.y - gap - height >= topLimit;
    const cardTop = above ? top.y - gap - height : bottom.y + gap;
    const x = clamp(center.x, width / 2 + 8, window.innerWidth - width / 2 - 8);
    const y = clamp(cardTop, topLimit, window.innerHeight - height - 8);

    const next = { x, y, scale, mx: center.x, my: center.y, fx: x, fy: above ? y + height : y };

    if (!smooth) {
      smooth = next;
    } else {
      for (const key of Object.keys(next)) {
        smooth[key] += (next[key] - smooth[key]) * 0.4;
      }
    }

    card.classList.remove('unplaced');
    card.style.transform =
      `translate(${smooth.x - cardSize.w / 2}px, ${smooth.y}px) scale(${smooth.scale})`;
    card.style.transformOrigin = '50% 0';

    const line = $('ar-link-line');
    const dot = $('ar-link-dot');

    line.setAttribute('x1', smooth.fx);
    line.setAttribute('y1', smooth.fy);
    line.setAttribute('x2', smooth.mx);
    line.setAttribute('y2', smooth.my);
    dot.setAttribute('cx', smooth.mx);
    dot.setAttribute('cy', smooth.my);

  }

  function frame() {
    if (mode === 'tracking') {
      placeCard();

      /* Marker per Testfunktion "gefunden", aber keine Kameramatrix: Karte mittig zeigen */
      const unanchored = performance.now() - anchorSeenAt > ANCHOR_TIMEOUT_MS;

      card.classList.toggle('unplaced', unanchored);
      document.body.classList.toggle('no-link', unanchored);

      if (unanchored) card.style.transform = '';
    } else {
      card.classList.remove('unplaced');
      document.body.classList.remove('no-link');
      card.style.transform = '';
    }

    requestAnimationFrame(frame);
  }

  /* ==================================================
     DARSTELLUNG
     ================================================== */

  function drawSpark(view, buffer) {
    const dpr = window.devicePixelRatio || 1;
    const width = spark.clientWidth;
    const height = spark.clientHeight;

    if (!width || !height) return;

    if (spark.width !== Math.round(width * dpr) || spark.height !== Math.round(height * dpr)) {
      spark.width = Math.round(width * dpr);
      spark.height = Math.round(height * dpr);
    }

    const ctx = spark.getContext('2d');
    const now = Date.now();
    const points = buffer.filter((p) => now - p.ts <= SPARK_WINDOW_MS);
    const limits = view ? view.limits : { high: 4.5, highHigh: 7.1 };
    const yMax = Math.max(8, limits.highHigh * 1.15, ...points.map((p) => p.value));
    const color = COLORS[(view && view.level) || 'none'];

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const px = (ts) => ((ts - (now - SPARK_WINDOW_MS)) / SPARK_WINDOW_MS) * width;
    const py = (value) => height - 4 - (value / yMax) * (height - 8);

    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    for (const [value, line] of [[limits.high, COLORS.warn], [limits.highHigh, COLORS.alarm]]) {
      ctx.strokeStyle = line;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(0, py(value));
      ctx.lineTo(width, py(value));
      ctx.stroke();
    }

    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    if (points.length < 2) return;

    const path = new Path2D();

    points.forEach((point, index) => {
      if (index === 0) path.moveTo(px(point.ts), py(point.value));
      else path.lineTo(px(point.ts), py(point.value));
    });

    const area = new Path2D(path);
    const first = points[0];
    const last = points[points.length - 1];

    area.lineTo(px(last.ts), height);
    area.lineTo(px(first.ts), height);
    area.closePath();

    const gradient = ctx.createLinearGradient(0, 0, 0, height);

    gradient.addColorStop(0, `${color}55`);
    gradient.addColorStop(1, `${color}00`);

    ctx.fillStyle = gradient;
    ctx.fill(area);

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke(path);

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px(last.ts), py(last.value), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  function render() {
    const { sample, buffer, summary, crate, crateAuto } = LiveData.snapshot();

    /* Status oben links */
    $('connection-indicator').dataset.state = summary.state;
    $('connection-text').textContent = summary.text;

    if (mode === 'searching') return;

    /* Karte */
    const level = sample ? sample.level : null;

    card.dataset.level = level || (sample ? 'stale' : 'none');

    $('card-value').textContent = sample ? numberFormat.format(sample.value) : '—';
    $('card-unit').textContent = sample ? sample.unit : 'mm/s';
    $('card-badge').textContent = !sample ? 'Warte …' : sample.stale ? 'Veraltet' : LEVEL_TEXT[level];

    const tag = $('card-tag');

    tag.dataset.state = !sample ? 'none' : sample.stale ? 'stale' : sample.demo ? 'demo' : 'live';
    tag.textContent = !sample ? 'Keine Daten' : sample.stale ? 'Veraltet' : sample.demo ? 'Demo-Daten' : 'Live';

    const source = sample && !sample.demo && crate
      ? `Kiste ${crate}${crateAuto ? ' (auto)' : ''} · `
      : '';

    $('card-age').textContent = sample ? `${source}vor ${Math.round(sample.age / 1000)} s` : '';

    const limits = sample ? sample.limits : { high: 4.5, highHigh: 7.1 };

    $('card-limits').textContent =
      `Warnung ab ${numberFormat.format(limits.high)} · Alarm ab ${numberFormat.format(limits.highHigh)}`;

    drawSpark(sample, buffer);
  }

  LiveData.onUpdate(render);

  /* Testfunktionen: Marker ohne Kamera auslösen */
  window.fireEventMarkerFound = () => marker.dispatchEvent(new CustomEvent('markerFound'));
  window.fireEventMarkerLost = () => marker.dispatchEvent(new CustomEvent('markerLost'));

  window.addEventListener('resize', () => {
    measureCard();
    render();
  });

  /*
   * AR.js schreibt Kamerafehler als Rohtext in #error-popup.
   * Stattdessen eine verständliche Meldung zeigen.
   */
  function friendlyCameraError(popup) {
    popup.textContent =
      'Kamera nicht verfügbar. Zugriff erlauben und die Seite über https oder localhost öffnen. '
      + 'Ohne Kamera geht „Ohne Marker ansehen“.';
  }

  new MutationObserver(() => {
    const popup = $('error-popup');

    if (popup && !popup.dataset.friendly) {
      popup.dataset.friendly = '1';
      friendlyCameraError(popup);
    }
  }).observe(document.body, { childList: true, subtree: true });

  measureCard();
  render();
  requestAnimationFrame(frame);
})();
