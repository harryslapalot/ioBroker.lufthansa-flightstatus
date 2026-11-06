# ioBroker Lufthansa Flight Status

Dieser Adapter fragt den Status eines einzelnen Fluges über die offizielle Lufthansa Open API ab.

## Einstellungen

- **Lufthansa Client ID / Client Secret:** Werte deiner Anwendung im Lufthansa Developer Portal. Das Secret wird als verschlüsselte Adaptereinstellung abgelegt.
- **ioBroker-Objekt mit Flugnummer:** beispielsweise `openairlog.0.today.currentFlightNumber`. Erwartet wird eine IATA-Flugnummer wie `LH780`.
- **Optionales Objekt mit Abflugdatum:** ein State mit `YYYY-MM-DD`, etwa `0_userdata.0.flight.departureDate`. Die Lufthansa API benötigt das Datum am Abflugort. Ohne diesen State nutzt der Adapter das heutige Datum in Berlin.
- **Abfrageintervall:** Voreinstellung 300 Sekunden. Die Lufthansa API-Quote beachten.

## Überwachungslogik und API-Quote

- Sind Flugnummer oder optionales Abflugdatum leer, bleibt der Adapter ohne API-Aufruf im Wartezustand.
- Sobald sich der konfigurierte Flugnummer-State auf eine gültige Flugnummer ändert, startet die Überwachung sofort.
- Wird dieser State während einer laufenden Überwachung leer, verfolgt der Adapter den bereits gemerkten Flug weiter. Erst eine neue Flugnummer oder der Status `LD`/`CD` ersetzt beziehungsweise beendet die Überwachung.
- Zwischen zwei Flight-Status-Anfragen liegt immer mindestens das konfigurierte Abfrageintervall (mindestens 60 Sekunden).
- Bei Status `LD` (gelandet) oder `CD` (annulliert) endet die API-Abfrage automatisch. Die letzten Flugdaten einschließlich `flight.number` und Kurzstatus bleiben danach noch 30 Minuten sichtbar und werden erst anschließend geleert.
- `info.monitoring` zeigt die aktive Überwachung; `info.nextRefresh` zeigt den nächsten geplanten Abruf.
- `info.retentionUntil` zeigt, bis wann die Daten eines beendeten Flugs sichtbar bleiben.

## Verfügbare Datenpunkte

- `flight.status.*`: Flugstatus (zum Beispiel DP, LD, CD) und Klartext.
- `flight.departure.*` / `flight.arrival.*`: geplante, geschätzte und tatsächliche Zeiten in UTC.
- `flight.arrival.etaBerlin`: aktuell beste Ankunftszeit in der Zeitzone Berlin.
- `flight.progress`: Fortschritt von tatsächlichem Abflug (falls vorhanden), sonst geschätztem/geplantem Abflug, bis zur ETA.
- `flight.raw`: vollständige JSON-Antwort für spätere Erweiterungen.
- `flight.summary`: zum Beispiel `LH780 ETA 10:14, 120 Minuten Restflugzeit`, `LH780 gelandet` oder `LH780 cancelled`.
- `info.monitoring` / `info.nextRefresh`: Status und Zeitpunkt der aktiven Überwachung.

## Installation aus GitHub

Nach dem Hochladen auf GitHub lässt sich der Adapter im ioBroker-Admin über
**Adapter → GitHub-Symbol → Benutzerdefinierte URL** installieren. Als URL wird
die Repository-Adresse verwendet, zum Beispiel:

`https://github.com/DEIN-BENUTZER/ioBroker.lufthansa-flightstatus`

Danach die Instanz hinzufügen und die Zugangsdaten eintragen.

### Privates Repository

Ein privates GitHub-Repository funktioniert ebenfalls, aber der ioBroker-Admin
kann es nicht über eine normale, anonyme HTTPS-URL lesen. Hinterlege deshalb
auf dem ioBroker-Host einen **nur lesenden Deploy Key** für dieses Repository
und klone es einmal per SSH. Anschließend kann der Adapter über die lokale
Quelle im ioBroker-Admin installiert werden. Updates erfolgen durch `git pull`
im geklonten Ordner und eine erneute Installation aus lokaler Quelle.

Lege keinen GitHub-Personal-Access-Token in einer Repository-URL, im Adapter
oder in einem ioBroker-State ab.

## Installation als lokale Entwicklungsinstanz

1. Den Ordner in den ioBroker-Ordner `node_modules` kopieren oder dort verlinken.
2. In diesem Ordner `npm install` ausführen.
3. Die Instanz im ioBroker-Admin hinzufügen und die Einstellungen eintragen.

Der API-Endpunkt ist `GET /operations/flightstatus/{flightNumber}/{date}`. Das Datum ist laut Lufthansa die lokale Abflugzeit; die API akzeptiert nur einen begrenzten Zeitraum um den heutigen Tag.
