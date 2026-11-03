# Industrie 4.0 AR Mockup

Contains a simple template for starting with an AR featured Web-APP using AFrame and AR.js.

## Marker used

- https://de.wikiversity.org/wiki/Datei:Hiro_marker_ARjs.png

## Live-Daten

`index-test.html` ist die Vorführ-App: Kamera auf den Hiro-Marker richten, die Karte mit den Messwerten der Pumpe P-101
erscheint am Marker (Vibration live per MQTT, WebSocket oder REST, Ampel, Verlauf der letzten Minute).
„Ohne Marker ansehen“ zeigt die Karte ohne Kamera, „Details“ öffnet die Technik-Ansicht mit Chart, MQTT-Text und Einstellungen.
Ohne Netz laufen simulierte Demo-Daten. Start: `python3 -m http.server 8765`, dann `http://localhost:8765/index-test.html` öffnen (Kamera geht nur über localhost oder https).
Anleitung, Node-RED-Flow, SQL-Schema und Antworten zu den Arbeitsaufträgen: [docs/ARBEITSAUFTRAEGE.md](docs/ARBEITSAUFTRAEGE.md).
Der Flow zum Import liegt in `nodered/vibration-flow.json`.
