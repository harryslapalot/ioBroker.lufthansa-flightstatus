'use strict';

const utils = require('@iobroker/adapter-core');

class LufthansaFlightStatus extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'lufthansa-flightstatus' });
        this.accessToken = null;
        this.accessTokenExpiresAt = 0;
        this.timer = null;
        this.running = false;

        this.on('ready', () => this.onReady());
        this.on('stateChange', (id) => {
            if (id === this.config.flightNumberState || id === this.config.flightDateState) this.queueRefresh(0);
        });
        this.on('unload', (callback) => this.onUnload(callback));
    }

    async onReady() {
        await this.createStates();
        await this.subscribeForeignStatesAsync(this.config.flightNumberState);
        if (this.config.flightDateState) await this.subscribeForeignStatesAsync(this.config.flightDateState);
        await this.setStateAsync('info.connection', false, true);
        this.queueRefresh(0);
    }

    onUnload(callback) {
        if (this.timer) this.clearTimeout(this.timer);
        callback();
    }

    async createStates() {
        const states = {
            'info.connection': ['boolean', 'info.connection', 'Verbindung zur Lufthansa Open API'],
            'info.status': ['string', 'info.status', 'Abrufstatus'],
            'info.lastRefresh': ['string', 'value.time', 'Letzte erfolgreiche Aktualisierung'],
            'flight.number': ['string', 'text', 'Abgerufene Flugnummer'],
            'flight.departureDate': ['string', 'text', 'Abflugdatum der Abfrage'],
            'flight.status.code': ['string', 'text', 'Flugstatus-Code'],
            'flight.status.text': ['string', 'text', 'Flugstatus-Text'],
            'flight.origin.airport': ['string', 'text', 'Abflugflughafen (IATA)'],
            'flight.origin.terminal': ['string', 'text', 'Abflugterminal'],
            'flight.origin.gate': ['string', 'text', 'Abfluggate'],
            'flight.destination.airport': ['string', 'text', 'Zielflughafen (IATA)'],
            'flight.destination.terminal': ['string', 'text', 'Ankunftsterminal'],
            'flight.destination.gate': ['string', 'text', 'Ankunftsgate'],
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

    async refresh() {
        if (this.running) return;
        this.running = true;
        try {
            const flightNumber = await this.readFlightNumber();
            const departureDate = await this.readDepartureDate();
            if (!flightNumber) {
                await this.setStateAsync('info.connection', true, true);
                await this.setStateAsync('info.status', 'Warte auf Flugnummer im konfigurierten Objekt', true);
                return;
            }

            const response = await this.getFlightStatus(flightNumber, departureDate);
            const flight = this.firstFlight(response);
            if (!flight) throw new Error(`Kein Flugstatus für ${flightNumber} am ${departureDate} gefunden`);

            await this.publishFlight(flightNumber, departureDate, flight, response);
            await this.setStateAsync('info.connection', true, true);
            await this.setStateAsync('info.status', 'ok', true);
            await this.setStateAsync('info.lastRefresh', new Date().toISOString(), true);
        } catch (error) {
            const message = error?.message || String(error);
            await this.setStateAsync('info.connection', false, true);
            await this.setStateAsync('info.status', `Fehler: ${message}`, true);
            this.log.warn(`Lufthansa Flight Status: ${message}`);
        } finally {
            this.running = false;
            const seconds = Math.min(Math.max(Number(this.config.pollIntervalSec) || 300, 60), 3600);
            this.queueRefresh(seconds * 1000);
        }
    }

    async readFlightNumber() {
        const id = String(this.config.flightNumberState || '').trim();
        if (!id) throw new Error('Kein Objekt für die Flugnummer konfiguriert');
        const state = await this.getForeignStateAsync(id);
        const value = String(state?.val || '').toUpperCase().replace(/\s+/g, '');
        if (value && !/^[A-Z0-9]{3,8}$/.test(value)) throw new Error(`Ungültige Flugnummer im Objekt ${id}: ${value}`);
        return value;
    }

    async readDepartureDate() {
        const id = String(this.config.flightDateState || '').trim();
        if (id) {
            const state = await this.getForeignStateAsync(id);
            const date = String(state?.val || '').trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Ungültiges Abflugdatum im Objekt ${id}: ${date}`);
            return date;
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

        const values = {
            'flight.number': flightNumber,
            'flight.departureDate': departureDate,
            'flight.status.code': flight.FlightStatus?.Code || '',
            'flight.status.text': flight.FlightStatus?.Definition || '',
            'flight.origin.airport': departure.AirportCode || '',
            'flight.origin.terminal': departure.Terminal?.Name || '',
            'flight.origin.gate': departure.Terminal?.Gate || '',
            'flight.destination.airport': arrival.AirportCode || '',
            'flight.destination.terminal': arrival.Terminal?.Name || '',
            'flight.destination.gate': arrival.Terminal?.Gate || '',
            'flight.aircraft': flight.Equipment?.AircraftCode || '',
            'flight.departure.scheduledUtc': scheduledDeparture,
            'flight.departure.estimatedUtc': estimatedDeparture,
            'flight.departure.actualUtc': actualDeparture,
            'flight.arrival.scheduledUtc': scheduledArrival,
            'flight.arrival.estimatedUtc': estimatedArrival,
            'flight.arrival.actualUtc': actualArrival,
            'flight.arrival.etaBerlin': etaDate ? new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false }).format(etaDate) : '',
            'flight.progress': this.progress(startUtc, etaUtc),
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
}

if (require.main === module) new LufthansaFlightStatus();
module.exports = (options) => new LufthansaFlightStatus(options);
