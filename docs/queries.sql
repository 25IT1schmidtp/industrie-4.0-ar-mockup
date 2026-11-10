-- Durchschnitt der letzten 5 Minuten  ->  GET /api/vibration/avg5min
SELECT AVG(value) AS avg, COUNT(*) AS count
FROM measurement
WHERE sensor_id = 1
  AND ts >= (CAST(strftime('%s', 'now') AS INTEGER) - 300) * 1000;

-- Rohdaten der letzten 5 Minuten  ->  GET /api/vibration/last5min
SELECT ts, value
FROM measurement
WHERE sensor_id = 1
  AND ts >= (CAST(strftime('%s', 'now') AS INTEGER) - 300) * 1000
ORDER BY ts;

-- Einfügen eines Messwerts (aus Node-RED)
INSERT INTO measurement (sensor_id, ts, value) VALUES (1, 1793707895402, 2.023);

-- Aufgabe 9: Anzahl Messwerte pro Tag
SELECT date(ts / 1000, 'unixepoch') AS tag, COUNT(*) AS messwerte
FROM measurement
GROUP BY tag
ORDER BY tag;

-- Aufgabe 9.1: Reduktion, Minutenmittel statt Rohdaten
SELECT ts / 60000 * 60000 AS minute_ts,
       AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max, COUNT(*) AS n
FROM measurement
WHERE sensor_id = 1
GROUP BY minute_ts
ORDER BY minute_ts;

-- Aufgabe 9.1: Alte Rohdaten löschen (Aufbewahrung 24 h)
DELETE FROM measurement
WHERE ts < (CAST(strftime('%s', 'now') AS INTEGER) - 86400) * 1000;

-- Letzter Wert  ->  GET /api/vibration/latest
SELECT ts, value
FROM measurement
WHERE sensor_id = 1
ORDER BY ts DESC
LIMIT 1;
