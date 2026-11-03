-- Relationsschema Vibrationsdaten (SQLite, läuft auf dem Raspberry Pi)
-- 1 Sensor : n Messwerte

CREATE TABLE IF NOT EXISTS sensor (
  id      INTEGER PRIMARY KEY,
  node_id TEXT    NOT NULL UNIQUE,   -- OPC-UA-NodeId
  name    TEXT    NOT NULL,
  unit    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS measurement (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  sensor_id INTEGER NOT NULL REFERENCES sensor(id),
  ts        INTEGER NOT NULL,        -- Unix-Zeit in Millisekunden (UTC)
  value     REAL    NOT NULL
);

-- Beide Abfragen filtern nach Sensor + Zeitfenster
CREATE INDEX IF NOT EXISTS idx_measurement_sensor_ts ON measurement(sensor_id, ts);

INSERT OR IGNORE INTO sensor (id, node_id, name, unit)
VALUES (1, 'ns=2;s=Demo.Alarms.Plant.PowerHouse.P-101.Vibration', 'P-101 Vibration', 'mm/s');
