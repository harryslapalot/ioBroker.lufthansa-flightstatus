'use strict';

const utils = require('@iobroker/adapter-core');

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
        this.summaryTimer = null;
        this.summaryData = null;
        this.inFlightWithEta = false;
        this.sourceWatchTimer = null;
        this.lastObservedFlightNumber = null;
        this.lastObservedFlightDate = null;
        this.preflightTimer = null;
        this.lastPreflightRequestAt = 0;
        this.nextFlight = { number: '', date: '', scheduledOffBlock: '', departureUtc: '', scheduledDepartureUtc: '', cityPair: '' };
        this.lastObservedNextKey = null;

        this.on('ready', () => this.onReady());
        this.on('stateChange', (id, state) => {
            if (id === this.flightNumberStateId()) this.observeFlightNumber(state?.val).catch((error) => this.log.warn(error.message));
            if (id === this.flightDateStateId()) this.observeFlightDate(state?.val).catch((error) => this.log.warn(error.message));
            if ([this.nextFlightNumberStateId(), this.nextFlightDateStateId(), this.nextScheduledOffBlockStateId()].includes(id)) {
                this.watchNextFlight().catch((error) => this.log.warn(error.message));
            }
        });
        this.on('unload', (callback) => this.onUnload(callback));
    }

    async onReady() {
        await this.createStates();
        await this.restoreTerminalRetention();
        await this.subscribeForeignStatesAsync(this.flightNumberStateId());
        if (this.flightDateStateId()) await this.subscribeForeignStatesAsync(this.flightDateStateId());
        for (const id of [this.nextFlightNumberStateId(), this.nextFlightDateStateId(), this.nextScheduledOffBlockStateId()].filter(Boolean)) {
            await this.subscribeForeignStatesAsync(id);
        }
        await this.setStateAsync('info.connection', false, true);
        await this.watchSourceStates(true);
        await this.watchNextFlight(true);
        this.sourceWatchTimer = this.setInterval(() => this.watchSourceStates().catch((error) => this.log.warn(error.message)), 10_000);
        this.summaryTimer = this.setInterval(() => this.updateSummaryFromCache().catch((error) => this.log.warn(error.message)), 60_000);
    }

    onUnload(callback) {
        if (this.timer) this.clearTimeout(this.timer);
        if (this.terminalTimer) this.clearTimeout(this.terminalTimer);
        if (this.summaryTimer) this.clearInterval(this.summaryTimer);
        if (this.sourceWatchTimer) this.clearInterval(this.sourceWatchTimer);
        if (this.preflightTimer) this.clearTimeout(this.preflightTimer);
        callback();
    }

    async createStates() {
        const states = {
            'info.connection': ['boolean', 'info.connection', 'Verbindung zur Lufthansa Open API'],
            'info.status': ['string', 'info.status', 'Abrufstatus'],
            'info.lastRefresh': ['string', 'value.time', 'Letzte erfolgreiche Aktualisierung'],
            'info.monitoring': ['boolean', 'indicator', 'Flugüberwachung aktiv'],
            'info.nextRefresh': ['string', 'value.time', 'Nächste geplante Abfrage'],
            'info.activePollIntervalSec': ['number', 'value.interval', 'Aktuelles Lufthansa-Abfrageintervall', 's'],
            'info.retentionUntil': ['string', 'value.time', 'Anzeige des beendeten Flugs bis'],
            'info.phase': ['string', 'text', 'Aktuelle Flugphase (idle, preflight, flight, postflight)'],
            'next.number': ['string', 'text', 'Nächste Flugnummer'],
            'next.cityPair': ['string', 'text', 'Citypair des nächsten Flugs'],
            'next.departure.estimatedUtc': ['string', 'value.time', 'Geschätzter Abflug des nächsten Flugs UTC'],
            'next.departure.status': ['string', 'text', 'Abflugstatus des nächsten Flugs (on time oder delayed)'],
            'next.countdownMinutes': ['number', 'value', 'Verbleibende Minuten bis Abflug'],
            'next.summary': ['string', 'text', 'Kurzstatus des nächsten Flugs für Anzeige'],
            'next.visible': ['boolean', 'indicator', 'Nächsten Flug auf AWTRIX anzeigen'],
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

    defaultPollingIntervalMs() {
        return Math.min(Math.max(Number(this.config.pollIntervalSec) || 300, 60), 3600) * 1000;
    }

    pollingIntervalMs() {
        if (!this.inFlightWithEta) return this.defaultPollingIntervalMs();
        return Math.min(Math.max(Number(this.config.inFlightPollIntervalSec) || 600, 600), 900) * 1000;
    }

    terminalRetentionMs() {
        const configured = Number(this.config.terminalRetentionMinutes);
        const minutes = Number.isFinite(configured) ? configured : 30;
        return Math.min(Math.max(minutes, 0), 1440) * 60_000;
    }

    flightNumberStateId() {
        return String(this.config.flightNumberState || '').trim();
    }

    flightDateStateId() {
        return String(this.config.flightDateState || '').trim();
    }

    nextFlightNumberStateId() {
        return String(this.config.nextFlightNumberState || 'openairlog.0.next.flightNumber').trim();
    }

    nextFlightDateStateId() {
        return String(this.config.nextFlightDateState || 'openairlog.0.next.date').trim();
    }

    nextScheduledOffBlockStateId() {
        return String(this.config.nextScheduledOffBlockState || 'openairlog.0.next.scheduledOffBlock').trim();
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

    async stateValue(id) {
        if (!id) return '';
        return (await this.getForeignStateAsync(id))?.val ?? '';
    }

    async watchNextFlight(force = false) {
        const number = this.normalizeFlightNumber(await this.stateValue(this.nextFlightNumberStateId()));
        const date = String(await this.stateValue(this.nextFlightDateStateId()) || '').trim();
        const scheduledOffBlock = String(await this.stateValue(this.nextScheduledOffBlockStateId()) || '').trim();
        const key = `${number}|${date}|${scheduledOffBlock}`;
        if (!force && key === this.lastObservedNextKey) return;
        this.lastObservedNextKey = key;

        this.nextFlight = { number, date, scheduledOffBlock, departureUtc: '', scheduledDepartureUtc: '', cityPair: '' };
        if (!number || !date) {
            this.clearPreflightTimer();
            await this.clearNextFlight();
            return;
        }
        await this.setPreflightPhase();
        this.requestPreflightRefresh(0);
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

        if ((this.monitoring || this.terminalTimer) && flightNumber === this.trackedFlightNumber) return;
        this.clearTerminalRetention();
        this.trackedFlightNumber = flightNumber;
        this.trackedDepartureDate = await this.readDepartureDate();
        this.trackedCityPair = '';
        this.summaryData = null;
        this.inFlightWithEta = false;
        this.monitoring = true;
        await this.setStateAsync('next.visible', false, true);
        await this.setStateAsync('info.phase', 'flight', true);
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
        await this.setStateAsync('info.connection', true, true);
        await this.setStateAsync('info.monitoring', false, true);
        await this.setStateAsync('info.nextRefresh', '', true);
        await this.setStateAsync('info.status', status, true);
        if (!this.terminalTimer) await this.updatePreflightDisplay();
    }

    clearTerminalRetention() {
        if (this.terminalTimer) this.clearTimeout(this.terminalTimer);
        this.terminalTimer = null;
        this.setStateAsync('info.retentionUntil', '', true).catch(() => undefined);
    }

    async restoreTerminalRetention() {
        const phase = String((await this.getStateAsync('info.phase'))?.val || '');
        if (phase !== 'postflight') return;

        const retentionUntil = new Date(String((await this.getStateAsync('info.retentionUntil'))?.val || ''));
        if (Number.isNaN(retentionUntil.getTime()) || retentionUntil.getTime() <= Date.now()) {
            await this.clearFinishedFlight();
            return;
        }

        this.trackedFlightNumber = String((await this.getStateAsync('flight.number'))?.val || '').trim();
        this.monitoring = false;
        const remainingMs = retentionUntil.getTime() - Date.now();
        const remainingMinutes = Math.ceil(remainingMs / 60_000);
        await this.setStateAsync('info.connection', true, true);
        await this.setStateAsync('info.monitoring', false, true);
        await this.setStateAsync('info.nextRefresh', '', true);
        await this.setStateAsync('info.status', `Beendeter Flug bleibt noch ${remainingMinutes} Minuten sichtbar`, true);
        this.terminalTimer = this.setTimeout(() => this.clearFinishedFlight(), remainingMs);
    }

    async finishFlight(statusCode, flightNumber) {
        const retentionMs = this.terminalRetentionMs();
        const retentionMinutes = retentionMs / 60_000;
        const retentionText = retentionMinutes > 0 ? `Anzeige bleibt noch ${retentionMinutes} Minuten bestehen` : 'Anzeige wird jetzt geleert';
        await this.stopMonitoring(statusCode === 'LD' ? `Flug gelandet – ${retentionText}` : `Flug annulliert – ${retentionText}`);
        await this.setStateAsync('flight.summary', `${this.summaryPrefix(flightNumber)} ${statusCode === 'LD' ? 'gelandet' : 'cancelled'}`, true);
        if (!retentionMs) {
            await this.clearFinishedFlight();
            return;
        }
        const retentionUntil = new Date(Date.now() + retentionMs);
        await this.setStateAsync('info.phase', 'postflight', true);
        await this.setStateAsync('info.retentionUntil', retentionUntil.toISOString(), true);
        this.terminalTimer = this.setTimeout(() => this.clearFinishedFlight(), retentionMs);
    }

    async clearFinishedFlight() {
        this.terminalTimer = null;
        this.trackedFlightNumber = '';
        this.trackedDepartureDate = '';
        this.trackedCityPair = '';
        this.summaryData = null;
        this.inFlightWithEta = false;
        const fieldsToClear = [
            'flight.number', 'flight.summary', 'flight.departureDate',
            'flight.status.code', 'flight.status.text',
            'flight.origin.airport', 'flight.origin.terminal', 'flight.origin.gate',
            'flight.departure.timeStatus.code', 'flight.departure.timeStatus.text',
            'flight.destination.airport', 'flight.destination.terminal', 'flight.destination.gate',
            'flight.arrival.timeStatus.code', 'flight.arrival.timeStatus.text',
            'flight.aircraft',
            'flight.departure.scheduledUtc', 'flight.departure.estimatedUtc', 'flight.departure.actualUtc',
            'flight.arrival.scheduledUtc', 'flight.arrival.estimatedUtc', 'flight.arrival.actualUtc',
            'flight.arrival.etaBerlin', 'flight.raw'
        ];
        for (const id of fieldsToClear) await this.setStateAsync(id, '', true);
        await this.setStateAsync('flight.progress', 0, true);
        await this.setStateAsync('info.activePollIntervalSec', 0, true);
        await this.setStateAsync('info.retentionUntil', '', true);
        await this.setStateAsync('info.status', 'Warte auf Flugnummer im konfigurierten Objekt', true);
        await this.updatePreflightDisplay();
        if (!this.monitoring && !this.nextFlight.number) await this.setStateAsync('info.phase', 'idle', true);
        this.requestPreflightRefresh(0);
    }

    requestRefresh() {
        if (!this.monitoring) return;
        const intervalMs = this.pollingIntervalMs();
        const dueAt = Math.max(Date.now(), this.lastStatusRequestAt + intervalMs);
        this.setStateAsync('info.activePollIntervalSec', intervalMs / 1000, true).catch(() => undefined);
        this.setStateAsync('info.nextRefresh', new Date(dueAt).toISOString(), true).catch(() => undefined);
        this.queueRefresh(Math.max(0, dueAt - Date.now()));
    }

    preflightPollingIntervalMs() {
        const scheduledDeparture = this.parseUtc(this.nextFlight.scheduledDepartureUtc) || this.preflightScheduledOffBlockDate();
        if (scheduledDeparture && Date.now() >= scheduledDeparture.getTime()) return 2 * 60_000;
        return Math.min(Math.max(Number(this.config.preflightPollIntervalSec) || 900, 300), 3600) * 1000;
    }

    preflightDisplayLeadMs() {
        return Math.min(Math.max(Number(this.config.preflightDisplayMinutes) || 30, 0), 240) * 60_000;
    }

    clearPreflightTimer() {
        if (this.preflightTimer) this.clearTimeout(this.preflightTimer);
        this.preflightTimer = null;
    }

    requestPreflightRefresh(delayMs) {
        if (this.monitoring || !this.nextFlight.number || !this.nextFlight.date) return;
        this.clearPreflightTimer();
        const intervalMs = this.preflightPollingIntervalMs();
        const dueAt = Math.max(Date.now() + delayMs, this.lastPreflightRequestAt + intervalMs);
        this.setStateAsync('info.activePollIntervalSec', intervalMs / 1000, true).catch(() => undefined);
        this.setStateAsync('info.nextRefresh', new Date(dueAt).toISOString(), true).catch(() => undefined);
        this.preflightTimer = this.setTimeout(() => this.refreshPreflight(), Math.max(0, dueAt - Date.now()));
    }

    async refreshPreflight() {
        if (this.monitoring) return;
        if (!this.nextFlight.number || !this.nextFlight.date) return;
        try {
            this.lastPreflightRequestAt = Date.now();
            const response = await this.getFlightStatus(this.nextFlight.number, this.nextFlight.date);
            const flight = this.firstFlight(response);
            if (!flight) throw new Error(`Kein Vorflugstatus für ${this.nextFlight.number} am ${this.nextFlight.date} gefunden`);

            const departure = flight.Departure || {};
            const arrival = flight.Arrival || {};
            const actualDeparture = this.time(departure, 'Actual');
            const statusCode = flight.FlightStatus?.Code || '';
            this.nextFlight.departureUtc = this.time(departure, 'Estimated') || this.time(departure, 'Scheduled') || '';
            this.nextFlight.scheduledDepartureUtc = this.time(departure, 'Scheduled') || '';
            this.nextFlight.cityPair = this.cityPair(departure.AirportCode, arrival.AirportCode);
            await this.setStateAsync('next.number', this.nextFlight.number, true);
            await this.setStateAsync('next.cityPair', this.nextFlight.cityPair, true);
            await this.setStateAsync('next.departure.estimatedUtc', this.nextFlight.departureUtc, true);
            await this.setStateAsync('next.departure.status', this.nextFlightDepartureStatus(), true);
            await this.setStateAsync('info.connection', true, true);
            await this.updatePreflightDisplay();
            if (actualDeparture || statusCode === 'DP') await this.adoptNextFlight();
        } catch (error) {
            this.log.debug(`Lufthansa Preflight: ${error?.message || error}`);
            await this.updatePreflightDisplay();
        } finally {
            this.requestPreflightRefresh(0);
        }
    }

    preflightDepartureDate() {
        const apiTime = this.parseUtc(this.nextFlight.departureUtc);
        if (apiTime) return apiTime;
        const date = this.nextFlight.date;
        const time = this.nextFlight.scheduledOffBlock;
        if (time.includes('T')) return this.parseUtc(time);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) return null;
        const local = new Date(`${date}T${time}`);
        return Number.isNaN(local.getTime()) ? null : local;
    }

    nextFlightDepartureStatus() {
        const estimated = this.parseUtc(this.nextFlight.departureUtc);
        const scheduled = this.parseUtc(this.nextFlight.scheduledDepartureUtc) || this.preflightScheduledOffBlockDate();
        if (!estimated || !scheduled) return '';
        return estimated.getTime() - scheduled.getTime() > 5 * 60_000 ? 'delayed' : 'on time';
    }

    preflightScheduledOffBlockDate() {
        const date = this.nextFlight.date;
        const time = this.nextFlight.scheduledOffBlock;
        if (time.includes('T')) return this.parseUtc(time);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) return null;
        const local = new Date(`${date}T${time}`);
        return Number.isNaN(local.getTime()) ? null : local;
    }

    preflightPlannedDepartureDate() {
        return this.parseUtc(this.nextFlight.scheduledDepartureUtc) || this.preflightScheduledOffBlockDate();
    }

    async updatePreflightDisplay() {
        const departure = this.preflightDepartureDate();
        if (!this.nextFlight.number || !departure) {
            await this.setStateAsync('next.visible', false, true);
            await this.setPreflightPhase();
            return;
        }
        const remainingMinutes = Math.max(0, Math.ceil((departure.getTime() - Date.now()) / 60_000));
        const departureTimeReached = departure.getTime() <= Date.now();
        const visible = !this.monitoring && !this.terminalTimer && (departureTimeReached || departure.getTime() - Date.now() <= this.preflightDisplayLeadMs());
        const prefix = [this.nextFlight.number, this.nextFlight.cityPair].filter(Boolean).join(' ');
        await this.setStateAsync('next.countdownMinutes', remainingMinutes, true);
        await this.setStateAsync('next.summary', departureTimeReached ? `${prefix} – wartet auf Abflug` : `${prefix} – ${this.formatDuration(remainingMinutes)} bis Abflug`, true);
        await this.setStateAsync('next.visible', visible, true);
        await this.setPreflightPhase();
    }

    async adoptNextFlight() {
        if (this.monitoring || !this.nextFlight.number || !this.nextFlight.date) return;
        this.clearPreflightTimer();
        this.clearTerminalRetention();
        this.trackedFlightNumber = this.nextFlight.number;
        this.trackedDepartureDate = this.nextFlight.date;
        this.trackedCityPair = this.nextFlight.cityPair;
        this.summaryData = null;
        this.inFlightWithEta = false;
        this.monitoring = true;
        await this.setStateAsync('next.visible', false, true);
        await this.setStateAsync('info.phase', 'flight', true);
        await this.setStateAsync('info.monitoring', true, true);
        await this.setStateAsync('info.status', `Nächsten Flug ${this.trackedFlightNumber} als aktuellen Flug übernommen`, true);
        this.requestRefresh();
    }

    async setPreflightPhase() {
        if (!this.nextFlight.number || this.monitoring || this.terminalTimer) return;
        const plannedDeparture = this.preflightPlannedDepartureDate();
        const withinPreflightWindow = plannedDeparture && plannedDeparture.getTime() - Date.now() <= 60 * 60_000;
        if (withinPreflightWindow) {
            await this.setStateAsync('info.phase', 'preflight', true);
            await this.setStateAsync('flight.progress', 0, true);
        } else {
            await this.setStateAsync('info.phase', 'idle', true);
        }
    }

    async clearNextFlight() {
        for (const id of ['next.number', 'next.cityPair', 'next.departure.estimatedUtc', 'next.departure.status', 'next.summary']) {
            await this.setStateAsync(id, '', true);
        }
        await this.setStateAsync('next.countdownMinutes', 0, true);
        await this.setStateAsync('next.visible', false, true);
        if (!this.monitoring && !this.terminalTimer) await this.setStateAsync('info.phase', 'idle', true);
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
        if (actualDeparture && estimatedArrival && !['LD', 'CD'].includes(statusCode)) this.inFlightWithEta = true;
        this.summaryData = { flightNumber, statusCode, etaDate };

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

    formatDuration(totalMinutes) {
        const minutes = Math.max(0, Math.ceil(Number(totalMinutes) || 0));
        if (minutes < 60) return `${minutes} Minuten`;
        return `${Math.floor(minutes / 60)} Std. ${minutes % 60} Minuten`;
    }

    summary(flightNumber, statusCode, etaDate) {
        const prefix = this.summaryPrefix(flightNumber);
        if (statusCode === 'LD') return `${prefix} gelandet`;
        if (statusCode === 'CD') return `${prefix} cancelled`;
        if (!etaDate) return `${prefix} ETA --:--, Restflugzeit unbekannt`;
        const eta = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false }).format(etaDate);
        const minutes = Math.max(0, Math.ceil((etaDate.getTime() - Date.now()) / 60_000));
        return `${prefix} ETA ${eta}, ${this.formatDuration(minutes)} Restflugzeit`;
    }

    async updateSummaryFromCache() {
        if (this.summaryData && !['LD', 'CD'].includes(this.summaryData.statusCode)) {
            await this.setStateAsync('flight.summary', this.summary(this.summaryData.flightNumber, this.summaryData.statusCode, this.summaryData.etaDate), true);
        }
        await this.updatePreflightDisplay();
    }
}

if (require.main === module) new LufthansaFlightStatus();
module.exports = (options) => new LufthansaFlightStatus(options);
