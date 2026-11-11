# ioBroker Lufthansa Flight Status

Dieser Adapter fragt den Status eines einzelnen Fluges über die offizielle Lufthansa Open API ab.

## Einstellungen

- **Lufthansa Client ID / Client Secret:** Werte deiner Anwendung im Lufthansa Developer Portal. Das Secret wird als verschlüsselte Adaptereinstellung abgelegt.
- **ioBroker-Objekt mit Flugnummer:** beispielsweise `openairlog.0.today.currentFlightNumber`. Erwartet wird eine IATA-Flugnummer wie `LH780`.
- **Optionales Objekt mit Abflugdatum:** ein State mit `YYYY-MM-DD`, etwa `0_userdata.0.flight.departureDate`. Die Lufthansa API benötigt das Datum am Abflugort. Ohne diesen State nutzt der Adapter das heutige Datum in Berlin.
- **Abfrageintervall:** Voreinstellung 300 Sekunden. Die Lufthansa API-Quote beachten.
- **Intervall in der Luft nach erster ETA:** 600–900 Sekunden. Sobald ein tatsächlicher Abflug und eine geschätzte Ankunft vorliegen, verwendet der Adapter dieses längere Intervall.
- **Anzeigezeit nach Landung oder Annullierung:** Dauer in Minuten, für die die letzten Flugdaten noch sichtbar bleiben. `0` leert die Daten sofort.
- **Objekte des nächsten Flugs:** Standardmäßig `openairlog.0.next.flightNumber`, `openairlog.0.next.date` und `openairlog.0.next.scheduledOffBlock`.
- **Anzeigezeit vor Abflug:** Start der Vorflug-Anzeige vor der geschätzten Lufthansa-Abflugzeit; der OpenAirLog-Offblock dient als Fallback.
- **Vorflug-Abfrageintervall:** Standard 900 Sekunden. Der Countdown wird zwischen den API-Abfragen lokal minütlich fortgeschrieben.

## Überwachungslogik und API-Quote

- Sind Flugnummer oder optionales Abflugdatum leer, bleibt der Adapter ohne API-Aufruf im Wartezustand.
- Sobald sich der konfigurierte Flugnummer-State auf eine gültige Flugnummer ändert, startet die Überwachung sofort.
- Zusätzlich prüft der Adapter die beiden konfigurierten ioBroker-States alle 10 Sekunden lokal. Das fängt verpasste State-Events ab und verbraucht keine Lufthansa-API-Aufrufe.
- Wird dieser State während einer laufenden Überwachung leer, verfolgt der Adapter den bereits gemerkten Flug weiter. Erst eine neue Flugnummer oder der Status `LD`/`CD` ersetzt beziehungsweise beendet die Überwachung.
- Zwischen zwei Flight-Status-Anfragen liegt immer mindestens das konfigurierte Abfrageintervall (mindestens 60 Sekunden).
- Nach dem ersten In-Flight-ETA verwendet der Adapter das separate, längere In-Flight-Intervall. Die Restflugzeit in `flight.summary` wird trotzdem jede Minute aus der letzten ETA neu berechnet; dafür wird keine Lufthansa-API abgefragt.
- Der nächste Flug wird getrennt über `next.*` geführt. Sobald die Vorflug-Anzeige beginnt, ist `info.phase` gleich `preflight`; beim aktiven Flug `flight`; während der Nachlaufzeit nach Landung oder Annullierung `postflight`; sonst `idle`.
- Bei Status `LD` (gelandet) oder `CD` (annulliert) endet die API-Abfrage automatisch. Die letzten Flugdaten bleiben für die konfigurierte Nachlaufzeit sichtbar und werden danach vollständig geleert; `flight.progress` wird dabei auf `0` gesetzt.
- `info.monitoring` zeigt die aktive Überwachung; `info.nextRefresh` zeigt den nächsten geplanten Abruf.
- `info.retentionUntil` zeigt, bis wann die Daten eines beendeten Flugs sichtbar bleiben.

## Verfügbare Datenpunkte

- `flight.status.*`: Flugstatus (zum Beispiel DP, LD, CD) und Klartext.
- `flight.departure.*` / `flight.arrival.*`: geplante, geschätzte und tatsächliche Zeiten in UTC.
- `flight.departure.timeStatus.*` / `flight.arrival.timeStatus.*`: Zeitstatus-Code und Klartext, etwa `OT` (pünktlich) oder `DL` (verspätet).
- `flight.arrival.etaBerlin`: aktuell beste Ankunftszeit in der Zeitzone Berlin.
- `flight.progress`: Fortschritt von tatsächlichem Abflug (falls vorhanden), sonst geschätztem/geplantem Abflug, bis zur ETA.
- `flight.raw`: vollständige JSON-Antwort für spätere Erweiterungen.
- `flight.summary`: zum Beispiel `LH780 FRA-SIN ETA 10:14, 2 Std. 0 Min. Restflugzeit`, `LH780 FRA-SIN gelandet` oder `LH780 FRA-SIN cancelled`.
- `info.monitoring` / `info.nextRefresh`: Status und Zeitpunkt der aktiven Überwachung.
- `next.summary` / `next.visible`: Countdown und Anzeigefreigabe für den nächsten Flug.
- `info.phase`: `idle`, `preflight`, `flight` oder `postflight` zur eindeutigen Anzeige-Steuerung.

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
