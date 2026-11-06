'use strict';

const utils = require('@iobroker/adapter-core');
const TERMINAL_RETENTION_MS = 30 * 60 * 1000;

class LufthansaFlightStatus extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'lufthansa-flightstatus' });
        this.accessToken = null;
        this.accessTokenExpiresAt = 0;
        this.timer = null;
        this.running = false;
        this.monitoring = false;
        this.lastStatusRequestAt = 0;
        this.trackedFlightNumber = '';
        this.trackedDepartureDate = '';
        this.trackedCityPair = '';
        this.terminalTimer = null;
        this.sourceWatchTimer = null;
        this.lastObservedFlightNumber = null;
        this.lastObservedFlightDate = null;

        this.on('ready', () => this.onReady());
        this.on('stateChange', (id, state) => {
            if (id === this.flightNumberStateId()) this.observeFlightNumber(state?.val).catch((error) => this.log.warn(error.message));
            if (id === this.flightDateStateId()) this.observeFlightDate(state?.val).catch((error) => this.log.warn(error.message));
        });
        this.on('unload', (callback) => this.onUnload(callback));
    }

    async onReady() {
        await this.createStates();
        await this.subscribeForeignStatesAsync(this.flightNumberStateId());
        if (this.flightDateStateId()) await this.subscribeForeignStatesAsync(this.flightDateStateId());
        await this.setStateAsync('info.connection', false, true);
        await this.watchSourceStates(true);
        this.sourceWatchTimer = this.setInterval(() => this.watchSourceStates().catch((error) => this.log.warn(error.message)), 10_000);
    }

    onUnload(callback) {
        if (this.timer) this.clearTimeout(this.timer);
        if (this.terminalTimer) this.clearTimeout(this.terminalTimer);
        if (this.sourceWatchTimer) this.clearInterval(this.sourceWatchTimer);
        callback();
    }

    async createStates() {
        const states = {
            'info.connection': ['boolean', 'info.connection', 'Verbindung zur Lufthansa Open API'],
            'info.status': ['string', 'info.status', 'Abrufstatus'],
            'info.lastRefresh': ['string', 'value.time', 'Letzte erfolgreiche Aktualisierung'],
            'info.monitoring': ['boolean', 'indicator', 'Flugüberwachung aktiv'],
            'info.nextRefresh': ['string', 'value.time', 'Nächste geplante Abfrage'],
            'info.retentionUntil': ['string', 'value.time', 'Anzeige des beendeten Flugs bis'],
            'flight.number': ['string', 'text', 'Abgerufene Flugnummer'],
            'flight.summary': ['string', 'text', 'Kurzstatus für Anzeige'],
            'flight.departureDate': ['string', 'text', 'Abflugdatum der Abfrage'],
            'flight.status.code': ['string', 'text', 'Flugstatus-Code'],
            'flight.status.text': ['string', 'text', 'Flugstatus-Text'],
            'flight.origin.airport': ['string', 'text', 'Abflugflughafen (IATA)'],
            'flight.origin.terminal': ['string', 'text', 'Abflugterminal'],
            'flight.origin.gate': ['string', 'text', 'Abfluggate'],
            'flight.departure.timeStatus.code': ['string', 'text', 'Abflug-Zeitstatus-Code'],
            'flight.departure.timeStatus.text': ['string', 'text', 'Abflug-Zeitstatus-Text'],
            'flight.destination.airport': ['string', 'text', 'Zielflughafen (IATA)'],
            'flight.destination.terminal': ['string', 'text', 'Ankunftsterminal'],
            'flight.destination.gate': ['string', 'text', 'Ankunftsgate'],
            'flight.arrival.timeStatus.code': ['string', 'text', 'Ankunft-Zeitstatus-Code'],
            'flight.arrival.timeStatus.text': ['string', 'text', 'Ankunft-Zeitstatus-Text'],
            'flight.aircraft': ['string', 'text', 'Flugzeugtyp'],
            'flight.departure.scheduledUtc': ['string', 'value.time', 'Plan-Abflug UTC'],
            'flight.departure.estimatedUtc': ['string', 'value.time', 'Geschätzter Abflug UTC'],
            'flight.departure.actualUtc': ['string', 'value.time', 'Tatsächlicher Abflug UTC'],
            'flight.arrival.scheduledUtc': ['string', 'value.time', 'Plan-Ankunft UTC'],
            'flight.arrival.estimatedUtc': ['string', 'value.time', 'Geschätzte Ankunft UTC'],
            'flight.arrival.actualUtc': ['string', 'value.time', 'Tatsächliche Ankunft UTC'],
            'flight.arrival.etaBerlin': ['string', 'text', 'ETA in Zeitzone Berlin (HH:MM)'],
            'flight.progress': ['number', 'value.percent', 'Flugfortschritt', '%'],
            'flight.raw': ['string', 'json', 'Rohantwort der Lufthansa API (JSON)']
        };
        for (const [id, definition] of Object.entries(states)) {
            const [type, role, name, unit] = definition;
            await this.setObjectNotExistsAsync(id, {
                type: 'state',
                common: { name, type, role, read: true, write: false, ...(unit ? { unit } : {}) },
                native: {}
            });
        }
    }

    queueRefresh(delayMs) {
        if (this.timer) this.clearTimeout(this.timer);
        this.timer = this.setTimeout(() => this.refresh(), delayMs);
    }

    pollingIntervalMs() {
        return Math.min(Math.max(Number(this.config.pollIntervalSec) || 300, 60), 3600) * 1000;
    }

    flightNumberStateId() {
        return String(this.config.flightNumberState || '').trim();
    }

    flightDateStateId() {
        return String(this.config.flightDateState || '').trim();
    }

    normalizeFlightNumber(value) {
        const flightNumber = String(value || '').toUpperCase().replace(/\s+/g, '');
        if (flightNumber && !/^[A-Z0-9]{3,8}$/.test(flightNumber)) throw new Error(`Ungültige Flugnummer: ${flightNumber}`);
        return flightNumber;
    }

    async watchSourceStates(force = false) {
        const numberState = await this.getForeignStateAsync(this.flightNumberStateId());
        await this.observeFlightNumber(numberState?.val, force);
        const dateId = this.flightDateStateId();
        if (dateId) {
            const dateState = await this.getForeignStateAsync(dateId);
            await this.observeFlightDate(dateState?.val, force);
        }
    }

    async observeFlightNumber(value, force = false) {
        const flightNumber = this.normalizeFlightNumber(value);
        if (!force && flightNumber === this.lastObservedFlightNumber) return;
        this.lastObservedFlightNumber = flightNumber;
        this.log.debug(`Flugnummer-State geändert: ${flightNumber || '(leer)'}`);
        await this.onFlightNumberChanged(flightNumber);
    }

    async onFlightNumberChanged(flightNumber) {
        if (!flightNumber) {
            if (this.trackedFlightNumber && (this.monitoring || this.terminalTimer)) {
                const message = this.monitoring
                    ? `Überwachung für ${this.trackedFlightNumber} läuft weiter, obwohl der Flugnummer-State leer ist`
                    : `Beendeter Flug ${this.trackedFlightNumber} bleibt noch 30 Minuten sichtbar`;
                await this.setStateAsync('info.status', message, true);
                return;
            }
            await this.stopMonitoring('Warte auf Flugnummer im konfigurierten Objekt');
            return;
        }

        if (this.monitoring && flightNumber === this.trackedFlightNumber) return;
        this.clearTerminalRetention();
        this.trackedFlightNumber = flightNumber;
        this.trackedDepartureDate = await this.readDepartureDate();
        this.trackedCityPair = '';
        this.monitoring = true;
        await this.setStateAsync('info.monitoring', true, true);
        await this.setStateAsync('info.status', `Überwachung für ${flightNumber} gestartet`, true);
        this.requestRefresh();
    }

    async observeFlightDate(value, force = false) {
        const date = String(value || '').trim();
        if (!force && date === this.lastObservedFlightDate) return;
        this.lastObservedFlightDate = date;
        await this.onFlightDateChanged(date);
    }

    async onFlightDateChanged(date) {
        if (!this.monitoring) return;
        if (!date) return;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Ungültiges Abflugdatum: ${date}`);
        if (date === this.trackedDepartureDate) return;
        this.trackedDepartureDate = date;
        await this.setStateAsync('info.status', `Abflugdatum für ${this.trackedFlightNumber} aktualisiert`, true);
        this.requestRefresh();
    }

    async stopMonitoring(status) {
        this.monitoring = false;
        if (this.timer) this.clearTimeout(this.timer);
        this.timer = null;
        await this.setStateAsync('info.monitoring', false, true);
        await this.setStateAsync('info.nextRefresh', '', true);
        await this.setStateAsync('info.status', status, true);
    }

    clearTerminalRetention() {
        if (this.terminalTimer) this.clearTimeout(this.terminalTimer);
        this.terminalTimer = null;
        this.setStateAsync('info.retentionUntil', '', true).catch(() => undefined);
    }

    async finishFlight(statusCode, flightNumber) {
        await this.stopMonitoring(statusCode === 'LD' ? 'Flug gelandet – Anzeige bleibt noch 30 Minuten bestehen' : 'Flug annulliert – Anzeige bleibt noch 30 Minuten bestehen');
        await this.setStateAsync('flight.summary', `${this.summaryPrefix(flightNumber)} ${statusCode === 'LD' ? 'gelandet' : 'cancelled'}`, true);
        const retentionUntil = new Date(Date.now() + TERMINAL_RETENTION_MS);
        await this.setStateAsync('info.retentionUntil', retentionUntil.toISOString(), true);
        this.terminalTimer = this.setTimeout(() => this.clearFinishedFlight(), TERMINAL_RETENTION_MS);
    }

    async clearFinishedFlight() {
        this.terminalTimer = null;
        this.trackedFlightNumber = '';
        this.trackedDepartureDate = '';
        this.trackedCityPair = '';
        await this.setStateAsync('flight.number', '', true);
        await this.setStateAsync('flight.departureDate', '', true);
        await this.setStateAsync('flight.summary', '', true);
        await this.setStateAsync('info.retentionUntil', '', true);
        await this.setStateAsync('info.status', 'Warte auf Flugnummer im konfigurierten Objekt', true);
    }

    requestRefresh() {
        if (!this.monitoring) return;
        const dueAt = Math.max(Date.now(), this.lastStatusRequestAt + this.pollingIntervalMs());
        this.setStateAsync('info.nextRefresh', new Date(dueAt).toISOString(), true).catch(() => undefined);
        this.queueRefresh(Math.max(0, dueAt - Date.now()));
    }

    async refresh() {
        if (this.running || !this.monitoring) return;
        this.running = true;
        try {
            const flightNumber = this.trackedFlightNumber;
            const departureDate = this.trackedDepartureDate || await this.readDepartureDate();
            if (!flightNumber) {
                await this.stopMonitoring('Warte auf Flugnummer im konfigurierten Objekt');
                return;
            }

            this.lastStatusRequestAt = Date.now();
            const response = await this.getFlightStatus(flightNumber, departureDate);
            const flight = this.firstFlight(response);
            if (!flight) throw new Error(`Kein Flugstatus für ${flightNumber} am ${departureDate} gefunden`);

            await this.publishFlight(flightNumber, departureDate, flight, response);
            await this.setStateAsync('info.connection', true, true);
            const statusCode = flight.FlightStatus?.Code || 'NA';
            await this.setStateAsync('info.status', `ok (${statusCode})`, true);
            await this.setStateAsync('info.lastRefresh', new Date().toISOString(), true);
            if (['LD', 'CD'].includes(statusCode)) {
                await this.finishFlight(statusCode, flightNumber);
            }
        } catch (error) {
            const message = error?.message || String(error);
            await this.setStateAsync('info.connection', false, true);
            await this.setStateAsync('info.status', `Fehler: ${message}`, true);
            this.log.warn(`Lufthansa Flight Status: ${message}`);
        } finally {
            this.running = false;
            this.requestRefresh();
        }
    }

    async readFlightNumber() {
        const id = this.flightNumberStateId();
        if (!id) throw new Error('Kein Objekt für die Flugnummer konfiguriert');
        const state = await this.getForeignStateAsync(id);
        return this.normalizeFlightNumber(state?.val);
    }

    async readDepartureDate() {
        const id = this.flightDateStateId();
        if (id) {
            const state = await this.getForeignStateAsync(id);
            const date = String(state?.val || '').trim();
            if (date) {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Ungültiges Abflugdatum im Objekt ${id}: ${date}`);
                return date;
            }
        }
        return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
    }

    async getAccessToken() {
        if (this.accessToken && Date.now() < this.accessTokenExpiresAt) return this.accessToken;
        const clientId = String(this.config.clientId || '').trim();
        const clientSecret = String(this.config.clientSecret || '').trim();
        if (!clientId || !clientSecret) throw new Error('Lufthansa Client ID oder Client Secret fehlt');

        const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' });
        const result = await fetch(`${this.apiBase()}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body
        });
        const json = await this.readJson(result);
        if (!result.ok || !json?.access_token) throw new Error(`OAuth-Token konnte nicht abgerufen werden (${result.status}): ${this.errorText(json)}`);
        this.accessToken = json.access_token;
        this.accessTokenExpiresAt = Date.now() + Math.max((Number(json.expires_in) || 300) - 60, 30) * 1000;
        return this.accessToken;
    }

    async getFlightStatus(flightNumber, departureDate) {
        const token = await this.getAccessToken();
        const response = await fetch(`${this.apiBase()}/operations/flightstatus/${encodeURIComponent(flightNumber)}/${departureDate}`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
        });
        const json = await this.readJson(response);
        if (response.status === 401) {
            this.accessToken = null;
            this.accessTokenExpiresAt = 0;
        }
        if (!response.ok) throw new Error(`Flight-Status-Abruf fehlgeschlagen (${response.status}): ${this.errorText(json)}`);
        return json;
    }

    apiBase() {
        return String(this.config.apiBase || 'https://api.lufthansa.com/v1').replace(/\/$/, '');
    }

    async readJson(response) {
        const text = await response.text();
        try { return text ? JSON.parse(text) : {}; } catch { return { message: text }; }
    }

    errorText(json) {
        return json?.Message || json?.message || json?.Error || JSON.stringify(json || {});
    }

    firstFlight(response) {
        const item = response?.FlightStatusResource?.Flights?.Flight;
        return Array.isArray(item) ? item[0] : item;
    }

    time(part, kind) {
        return part?.[`${kind}TimeUTC`]?.DateTime || '';
    }

    async publishFlight(flightNumber, departureDate, flight, raw) {
        const departure = flight.Departure || {};
        const arrival = flight.Arrival || {};
        const actualDeparture = this.time(departure, 'Actual');
        const estimatedDeparture = this.time(departure, 'Estimated');
        const scheduledDeparture = this.time(departure, 'Scheduled');
        const actualArrival = this.time(arrival, 'Actual');
        const estimatedArrival = this.time(arrival, 'Estimated');
        const scheduledArrival = this.time(arrival, 'Scheduled');
        const etaUtc = actualArrival || estimatedArrival || scheduledArrival;
        const startUtc = actualDeparture || estimatedDeparture || scheduledDeparture;
        const etaDate = this.parseUtc(etaUtc);
        const statusCode = flight.FlightStatus?.Code || 'NA';
        this.trackedCityPair = this.cityPair(departure.AirportCode, arrival.AirportCode);

        const values = {
            'flight.number': flightNumber,
            'flight.departureDate': departureDate,
            'flight.status.code': statusCode,
            'flight.status.text': flight.FlightStatus?.Definition || '',
            'flight.origin.airport': departure.AirportCode || '',
            'flight.origin.terminal': departure.Terminal?.Name || '',
            'flight.origin.gate': departure.Terminal?.Gate || '',
            'flight.departure.timeStatus.code': departure.TimeStatus?.Code || '',
            'flight.departure.timeStatus.text': departure.TimeStatus?.Definition || '',
            'flight.destination.airport': arrival.AirportCode || '',
            'flight.destination.terminal': arrival.Terminal?.Name || '',
            'flight.destination.gate': arrival.Terminal?.Gate || '',
            'flight.arrival.timeStatus.code': arrival.TimeStatus?.Code || '',
            'flight.arrival.timeStatus.text': arrival.TimeStatus?.Definition || '',
            'flight.aircraft': flight.Equipment?.AircraftCode || '',
            'flight.departure.scheduledUtc': scheduledDeparture,
            'flight.departure.estimatedUtc': estimatedDeparture,
            'flight.departure.actualUtc': actualDeparture,
            'flight.arrival.scheduledUtc': scheduledArrival,
            'flight.arrival.estimatedUtc': estimatedArrival,
            'flight.arrival.actualUtc': actualArrival,
            'flight.arrival.etaBerlin': etaDate ? new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false }).format(etaDate) : '',
            'flight.progress': this.progress(startUtc, etaUtc),
            'flight.summary': this.summary(flightNumber, statusCode, etaDate),
            'flight.raw': JSON.stringify(raw)
        };
        for (const [id, value] of Object.entries(values)) await this.setStateAsync(id, value, true);
    }

    parseUtc(value) {
        if (!value) return null;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    progress(startUtc, endUtc) {
        const start = this.parseUtc(startUtc)?.getTime();
        const end = this.parseUtc(endUtc)?.getTime();
        if (!start || !end || end <= start) return 0;
        return Math.max(0, Math.min(100, Math.round(((Date.now() - start) / (end - start)) * 100)));
    }

    cityPair(origin, destination) {
        return origin && destination ? `${origin}-${destination}` : '';
    }

    summaryPrefix(flightNumber) {
        return [flightNumber, this.trackedCityPair].filter(Boolean).join(' ');
    }

    summary(flightNumber, statusCode, etaDate) {
        const prefix = this.summaryPrefix(flightNumber);
        if (statusCode === 'LD') return `${prefix} gelandet`;
        if (statusCode === 'CD') return `${prefix} cancelled`;
        if (!etaDate) return `${prefix} ETA --:--, Restflugzeit unbekannt`;
        const eta = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false }).format(etaDate);
        const minutes = Math.max(0, Math.ceil((etaDate.getTime() - Date.now()) / 60_000));
        const remaining = minutes < 60
            ? `${minutes} Minuten`
            : `${Math.floor(minutes / 60)} Std. ${minutes % 60} Min.`;
        return `${prefix} ETA ${eta}, ${remaining} Restflugzeit`;
    }
}

if (require.main === module) new LufthansaFlightStatus();
module.exports = (options) => new LufthansaFlightStatus(options);
