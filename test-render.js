// Headless regression tests for the render layer of script.js.
// Loads the real class against a stub DOM, then checks that every list still
// renders its data AND that hostile values from imported emails cannot inject markup.
// Run with: node test-render.js

const fs = require('fs');
const path = require('path');

// ─── Minimal DOM stub ──────────────────────────────────────────────────────────

function makeElement(id) {
    const el = {
        id: id || '',
        innerHTML: '',
        innerText: '',
        textContent: '',
        value: '',
        className: '',
        checked: false,
        disabled: false,
        open: false,
        min: '',
        max: '',
        dataset: {},
        style: { cssText: '', setProperty() {} },
        children: [],
        classList: {
            _set: new Set(),
            add(...c) { c.forEach(x => this._set.add(x)); },
            remove(...c) { c.forEach(x => this._set.delete(x)); },
            toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); },
            contains(c) { return this._set.has(c); }
        },
        addEventListener() {},
        removeEventListener() {},
        appendChild(child) { this.children.push(child); this.innerHTML += child.innerHTML || ''; return child; },
        removeChild() {},
        remove() {},
        insertAdjacentHTML(_pos, html) { this.innerHTML += html; },
        setAttribute() {},
        getAttribute() { return null; },
        removeAttribute() {},
        scrollIntoView() {},
        focus() {},
        reset() {},
        showModal() { this.open = true; },
        close() { this.open = false; },
        click() {},
        querySelector() { return makeElement(); },
        querySelectorAll() { return []; },
        closest() { return makeElement(); }
    };
    return el;
}

const elements = new Map();
const documentStub = {
    title: 'test',
    head: makeElement('head'),
    body: makeElement('body'),
    getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement(id));
        return elements.get(id);
    },
    createElement() { return makeElement(); },
    querySelector() { return makeElement(); },
    querySelectorAll() { return []; },
    addEventListener() {},
    documentElement: makeElement('html')
};

const windowStub = {
    location: { hash: '', search: '', pathname: '/', origin: 'http://localhost:8000', href: 'http://localhost:8000/' },
    history: { replaceState() {} },
    addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} })
};

const localStorageStub = {
    _data: new Map(),
    getItem(k) { return this._data.has(k) ? this._data.get(k) : null; },
    setItem(k, v) { this._data.set(k, String(v)); },
    removeItem(k) { this._data.delete(k); }
};

const credentialManagerStub = {
    async init() {},
    async migrateFromLocalStorage() { return 0; },
    async get() { return null; },
    async set() {},
    async remove() {}
};

// Auth returns no session, so init() stops before touching the network.
const supabaseStub = {
    createClient() {
        return {
            auth: {
                async getSession() { return { data: { session: null }, error: null }; },
                onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; }
            },
            from() { throw new Error('No DB access expected in render tests'); }
        };
    }
};

// ─── Load the real application class ───────────────────────────────────────────

const source = fs.readFileSync(path.join(__dirname, 'script.js'), 'utf8')
    .replace(/const app = new OrangeContractApp\(\);\s*$/, '');

const OrangeContractApp = new Function(
    'document', 'window', 'navigator', 'localStorage', 'credentialManager', 'supabase',
    `${source}\nreturn OrangeContractApp;`
)(documentStub, windowStub, { serviceWorker: undefined }, localStorageStub, credentialManagerStub, supabaseStub);

// ─── Test helpers ──────────────────────────────────────────────────────────────

let passed = 0;
const failures = [];

function check(name, condition, detail) {
    if (condition) { passed++; return; }
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const XSS = `<img src=x onerror="alert(1)">`;
const XSS_ATTR = `" onmouseover="alert(1)`;

function assertClean(name, html) {
    // A live handler needs a real quote; the escaped payload renders as onerror=&quot;
    check(`${name}: no raw tag injected`, !html.includes('<img src=x'), html.slice(0, 200));
    check(`${name}: no live inline handler injected`, !/on(?:error|mouseover)\s*=\s*["']/.test(html), html.slice(0, 200));
    check(`${name}: hostile value is escaped`, html.includes('&lt;img') || !html.includes('img src'), html.slice(0, 200));
}

function html(id) { return documentStub.getElementById(id).innerHTML; }

const app = new OrangeContractApp();
app.useSupabase = false;

// ─── 1. Escaping helpers ───────────────────────────────────────────────────────

check('escapeHtml escapes all five characters',
    app.escapeHtml(`<>&"'`) === '&lt;&gt;&amp;&quot;&#39;');
check('escapeHtml handles null/undefined', app.escapeHtml(null) === '' && app.escapeHtml(undefined) === '');
check('escapeHtml leaves plain text untouched', app.escapeHtml('Bristol → Glasgow') === 'Bristol → Glasgow');
check('escapeFareWatchHtml still delegates correctly', app.escapeFareWatchHtml('<b>') === '&lt;b&gt;');

// ─── 2. Bookings ───────────────────────────────────────────────────────────────

app.bookings = [
    {
        id: 'b1', flightNumber: 'EZY6021', route: 'Bristol → Glasgow', date: '2099-01-15',
        departureTime: '07:10', arrivalTime: '08:30', pricePaid: 84.99,
        bookingRef: 'K3M9QP2', seat: '12A', notes: "Flex Pass not used"
    },
    {
        id: 'b2', flightNumber: XSS, route: XSS, date: '2000-03-01',
        departureTime: '', arrivalTime: '', pricePaid: 10, bookingRef: '', seat: '', notes: XSS
    }
];
app.renderBookings();
const bookingsHtml = html('bookings-list');
check('bookings: flight number rendered', bookingsHtml.includes('EZY6021'));
check('bookings: route rendered', bookingsHtml.includes('Bristol → Glasgow'));
check('bookings: UK date formatting kept', bookingsHtml.includes('15-01-2099'));
check('bookings: reference rendered', bookingsHtml.includes('K3M9QP2'));
check('bookings: seat rendered', bookingsHtml.includes('12A'));
check('bookings: times rendered', bookingsHtml.includes('07:10') && bookingsHtml.includes('08:30'));
check('bookings: price rendered', /84\.99/.test(bookingsHtml));
check('bookings: edit handler intact', bookingsHtml.includes("app.showBookingForm(app.bookings.find(b=>b.id==='b1'))"));
check('bookings: delete handler intact', bookingsHtml.includes("app.deleteBooking('b1')"));
check('bookings: past booking separated', bookingsHtml.includes('previous-bookings-section'));
check('bookings: past class applied', bookingsHtml.includes('booking-item past'));
assertClean('bookings', bookingsHtml);

app.bookings = [];
app.renderBookings();
check('bookings: empty state preserved', html('bookings-list').includes('No bookings yet'));

// ─── 3. Parking ────────────────────────────────────────────────────────────────

app.parkingBookings = [
    {
        id: 'p1', carParkName: 'Silver Zone', arrivalDate: '2099-02-01', arrivalTime: '05:30',
        returnDate: '2099-02-05', returnTime: '22:00', bookingRef: 'BRS12345',
        carRegistration: 'AB12 CDE', bookingStatus: 'Confirmed', notes: 'Level 2', pricePaid: 42.5, used: false
    },
    {
        id: 'p2', carParkName: XSS, arrivalDate: '2000-01-01', returnDate: '2000-01-02',
        bookingRef: XSS, carRegistration: XSS, bookingStatus: XSS, notes: XSS, pricePaid: 1, used: false
    }
];
app.renderParking();
const parkingHtml = html('parking-list');
check('parking: name rendered', parkingHtml.includes('Silver Zone'));
check('parking: registration rendered', parkingHtml.includes('AB12 CDE'));
check('parking: status class intact', parkingHtml.includes('booking-status confirmed'));
check('parking: dates rendered', parkingHtml.includes('01-02-2099') && parkingHtml.includes('05-02-2099'));
check('parking: handlers intact', parkingHtml.includes("app.deleteParking('p1')"));
assertClean('parking', parkingHtml);

// ─── 4. Accommodation & transport ──────────────────────────────────────────────

app.accommodationBookings = [
    { id: 'a1', name: 'Premier Inn', fromDate: '2099-03-01', toDate: '2099-03-04', pricePerNight: 60, breakfastIncluded: true, notes: 'Late checkout' },
    { id: 'a2', name: XSS, fromDate: '2099-03-01', toDate: '2099-03-02', pricePerNight: 1, breakfastIncluded: false, notes: XSS }
];
app.renderAccommodation();
const accHtml = html('accommodation-list');
check('accommodation: name rendered', accHtml.includes('Premier Inn'));
check('accommodation: nights calculated', accHtml.includes('3 nights'));
check('accommodation: breakfast flag kept', accHtml.includes('Breakfast included'));
check('accommodation: handlers intact', accHtml.includes("app.deleteAccommodation('a1')"));
assertClean('accommodation', accHtml);

app.transportBookings = [
    { id: 't1', name: 'Enterprise hire car', fromDate: '2099-04-01', toDate: '2099-04-05', totalCost: 200, notes: 'Diesel' },
    { id: 't2', name: XSS, fromDate: '2099-04-01', toDate: '2099-04-02', totalCost: 5, notes: XSS }
];
app.renderTransport();
const transHtml = html('transport-list');
check('transport: name rendered', transHtml.includes('Enterprise hire car'));
check('transport: day count rendered', /day/.test(transHtml));
check('transport: handlers intact', transHtml.includes("app.deleteTransport('t1')"));
assertClean('transport', transHtml);

// ─── 5. Schedule grid and details dialog ───────────────────────────────────────

app.bookings = [{
    id: 'b1', flightNumber: 'EZY6021', route: 'Bristol → Glasgow', date: app.formatDate(new Date()),
    departureTime: '07:10', arrivalTime: '08:30', pricePaid: 84.99, bookingRef: 'K3M9QP2', seat: '12A', notes: XSS
}];
app.expenses = { [app.formatDate(new Date())]: { ...app.getDefaultExpenses(), location: XSS } };
app.renderSchedule();
const schedHtml = html('schedule-calendar');
check('schedule: day cells rendered', schedHtml.includes('schedule-day'));
check('schedule: flight item rendered', schedHtml.includes('EZY6021'));
check('schedule: today highlighted', schedHtml.includes('schedule-day today'));
check('schedule: data-id attribute intact', schedHtml.includes('data-id="b1"'));
assertClean('schedule', schedHtml);

app.showScheduleDetails('flight', 'b1');
const detailsHtml = html('schedule-details-body');
check('details: rows rendered', detailsHtml.includes('schedule-detail-row'));
check('details: reference shown', detailsHtml.includes('K3M9QP2'));
assertClean('details', detailsHtml);

app.bookings = [{
    id: 'b2', flightNumber: 'EZY1234', route: 'Glasgow → Bristol', date: app.formatDate(new Date()),
    departureTime: '18:00', arrivalTime: '19:20', pricePaid: 55, bookingRef: 'XYZ987', seat: '4B', notes: 'Flex Pass not used'
}];
app.renderSchedule();
const flexHtml = html('schedule-calendar');
check('schedule: flex pass badge shown', flexHtml.includes('flex-pass-badge'));
check('schedule: flex pass badge labelled', flexHtml.includes('title="Flex pass not used"'));

// ─── 6. Week and month tables ──────────────────────────────────────────────────

app.locations = ['Glasgow', XSS_ATTR];
app.expenses = {};
app.renderWeekTable();
const weekHtml = html('week-tbody');
check('week table: rows rendered', weekHtml.includes('location-dropdown'));
check('week table: options rendered', weekHtml.includes('>Glasgow</option>'));
check('week table: option attribute injection escaped', !weekHtml.includes('" onmouseover="'), weekHtml.slice(0, 200));
check('week table: edit buttons intact', weekHtml.includes('app.editDay('));

app.renderMonthTable();
const monthHtml = html('month-tbody');
check('month table: rows rendered', monthHtml.includes('location-dropdown'));
check('month table: option attribute injection escaped', !monthHtml.includes('" onmouseover="'));

app.expenses = { '2099-05-01': { ...app.getDefaultExpenses(), location: 'Glasgow' } };
app.renderWeekTable();
check('week table: selected location still marked', html('week-tbody').includes('location-dropdown'));

// Negative (refunded) amounts must show; zero must stay a dash.
const todayKey = app.formatDate(new Date());
app.currentWeekStart = app.getWeekStart(new Date());
app.bookings = [];
app.parkingBookings = [];
app.accommodationBookings = [];
app.transportBookings = [];
app.expenses = { [todayKey]: { ...app.getDefaultExpenses(), location: 'Glasgow', flight: -50, food: 0 } };
app.renderWeekTable();
const signedHtml = html('week-tbody');
check('week table: refunds are displayed, not hidden', signedHtml.includes('£-50.00'), signedHtml.slice(0, 400));
check('week table: zero amounts still show a dash', signedHtml.includes('<td class="expense-amount">-</td>'));
check('week table: no NaN leaks into cells', !signedHtml.includes('NaN'));

app.renderMonthTable();
check('month table: no NaN leaks into cells', !html('month-tbody').includes('NaN'));

// ─── 7. Gmail import previews ──────────────────────────────────────────────────

app._lastSearchExtracted = true;
app.renderGmailResults([
    { details: { flightNumber: 'EZY6021', route: 'Bristol → Glasgow', date: '2099-01-15', seat: '12A', pricePaid: '84.99', bookingRef: 'K3M9QP2' } },
    { details: { flightNumber: XSS, route: XSS, date: '2099-01-16', seat: XSS, pricePaid: XSS, bookingRef: XSS } }
]);
const gmailHtml = html('gmail-results');
check('gmail flights: details rendered', gmailHtml.includes('EZY6021') && gmailHtml.includes('K3M9QP2'));
check('gmail flights: import button intact', gmailHtml.includes('app.importGmailBooking(0)'));
check('gmail flights: always-skip button intact', gmailHtml.includes('app.alwaysSkipGmailBooking(1)'));
check('gmail flights: found list stored for import', app._gmailFound && app._gmailFound.length === 2);
assertClean('gmail flights', gmailHtml);

app.skippedParkingBookings = [];
app.parkingBookings = [];
app.renderGmailParkingResults([
    { details: { carParkName: 'Silver Zone', arrivalDate: '2099-02-01', arrivalTime: '05:30', returnDate: '2099-02-05', returnTime: '22:00', pricePaid: '42.50', bookingRef: 'BRS12345', carRegistration: 'AB12 CDE', bookingStatus: 'Confirmed' } },
    { details: { carParkName: XSS, arrivalDate: '2099-02-02', returnDate: '2099-02-03', pricePaid: XSS, bookingRef: XSS, carRegistration: XSS, bookingStatus: XSS } }
]);
const gmailParkHtml = html('gmail-results');
check('gmail parking: details rendered', gmailParkHtml.includes('Silver Zone') && gmailParkHtml.includes('BRS12345'));
check('gmail parking: import button intact', gmailParkHtml.includes('app.importGmailParkingBooking(0)'));
assertClean('gmail parking', gmailParkHtml);

// ─── 8. Pasted-email parse previews ────────────────────────────────────────────

app.displayParsedFlight({ flightNumber: 'LM0046', date: '2099-06-14', departure: 'Bristol', arrival: 'Aberdeen', departureTime: '19:55', arrivalTime: '21:25', bookingRef: 'AJLPPR', cost: '120.00' });
let parsedHtml = html('parsed-flight');
check('parsed single: flight rendered', parsedHtml.includes('LM0046'));
check('parsed single: route rendered', parsedHtml.includes('Bristol → Aberdeen'));
check('parsed single: add button present', parsedHtml.includes('add-parsed-booking'));

app.displayParsedFlight({ flightNumber: XSS, date: XSS, departure: XSS, arrival: XSS, departureTime: XSS, arrivalTime: XSS, bookingRef: XSS, cost: XSS });
assertClean('parsed single', html('parsed-flight'));

app.displayMultipleParsedFlights([
    { flightNumber: 'LM0046', date: '2099-06-14', departure: 'Bristol', arrival: 'Aberdeen', departureTime: '19:55', arrivalTime: '21:25', bookingRef: 'AJLPPR', seat: '11F', cost: '120.00' },
    { flightNumber: XSS, date: XSS, departure: XSS, arrival: XSS, departureTime: XSS, arrivalTime: XSS, bookingRef: XSS, seat: XSS, cost: XSS }
]);
parsedHtml = html('parsed-flight');
check('parsed multi: both segments rendered', parsedHtml.includes('LM0046') && parsedHtml.includes('Extracted Flights (2)'));
check('parsed multi: import handler intact', parsedHtml.includes('app.importSegment(0)'));
check('parsed multi: segments stored', app._parsedSegments.length === 2);
assertClean('parsed multi', parsedHtml);

app.displayGeminiParsedBookings([
    { flightNumber: 'EZY6021', route: 'Bristol → Glasgow', date: '2099-01-15', departureTime: '07:10', arrivalTime: '08:30', bookingRef: 'K3M9QP2', seat: '12A', pricePaid: '84.99', notes: 'Flex Pass not used' },
    { flightNumber: XSS, route: XSS, date: XSS, departureTime: XSS, arrivalTime: XSS, bookingRef: XSS, seat: XSS, pricePaid: XSS, notes: XSS }
]);
parsedHtml = html('parsed-flight');
check('parsed gemini: data rendered', parsedHtml.includes('EZY6021') && parsedHtml.includes('Flex Pass not used'));
check('parsed gemini: import handler intact', parsedHtml.includes('app.importSegment(1)'));
assertClean('parsed gemini', parsedHtml);

// ─── 9. FreeAgent list ─────────────────────────────────────────────────────────

app.linkedFreeAgentExpenses = [];
app.renderFreeAgentExpenses([
    { dated_on: '2099-01-05', description: 'Train to Glasgow', value: '-42.30', category: 'Travel', url: 'https://api.freeagent.com/v2/expenses/1' },
    { dated_on: '2099-01-06', description: XSS, value: '-1', category: XSS_ATTR, url: XSS }
]);
const faHtml = html('freeagent-expenses-list');
check('freeagent: description rendered', faHtml.includes('Train to Glasgow'));
check('freeagent: amount rendered', faHtml.includes('42.30'));
check('freeagent: checkbox handler intact', faHtml.includes('app.toggleFreeAgentExpense(this)'));
check('freeagent: attribute injection escaped', !faHtml.includes('" onmouseover="'), faHtml.slice(0, 300));
assertClean('freeagent', faHtml);

// ─── 10. Fare watch cards (existing escaping still wired) ──────────────────────

app.plannedFlights = [{
    id: 'f1', origin: 'BRS', destination: 'GLA', outbound_date: '2099-07-01', outbound_time: '07:10:00',
    return_date: '2099-07-05', return_time: '18:00:00', status: 'watching', recommendation: 'watch',
    direct_only: true, target_price: 100, latest_total_price: 120, snapshots: [], events: [], event_sources: []
}];
app.fareWatchAlerts = [{ id: 'al1', title: XSS, message: XSS }];
app.renderFareWatch();
assertClean('fare watch cards', html('planned-flights-list'));
assertClean('fare watch alerts', html('fare-watch-alerts'));
check('fare watch: card rendered', html('planned-flights-list').includes('planned-flight-card'));

// ─── 11. Service worker logic ──────────────────────────────────────────────────

const swSource = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
const listeners = {};
const cacheAdds = [];
const swSelf = {
    location: { origin: 'https://app.example.com' },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting() {},
    clients: { claim() {} }
};
const cachesStub = {
    async open() { return { async add(url) { cacheAdds.push(url); }, async put() {} }; },
    async match() { return { body: 'cached' }; },
    async keys() { return []; },
    async delete() {}
};
new Function('self', 'caches', 'fetch', 'URL', swSource)(
    swSelf, cachesStub, async () => ({ status: 200 }), URL
);

check('sw: install and fetch listeners registered', typeof listeners.install === 'function' && typeof listeners.fetch === 'function');

let responded = false;
listeners.fetch({
    request: { method: 'POST', url: 'https://app.example.com/api' },
    respondWith() { responded = true; }
});
check('sw: POST requests are not intercepted', responded === false);

listeners.fetch({
    request: { method: 'GET', url: 'https://app.example.com/script.js?v=43' },
    respondWith() { responded = true; }
});
check('sw: GET requests are still served from cache', responded === true);

let bypassed = true;
listeners.fetch({
    request: { method: 'GET', url: 'https://jqfnlcdcxcydqwufgwpm.supabase.co/rest/v1/bookings' },
    respondWith() { bypassed = false; }
});
check('sw: Supabase requests still bypass the cache', bypassed === true);

check('sw: versioned asset URLs are precached',
    swSource.includes("'./script.js?v=43'") && swSource.includes("'./styles.css?v=43'"));
check('sw: credentials.js is precached', swSource.includes("'./credentials.js'"));

// ─── 12. index.html sanity ─────────────────────────────────────────────────────

const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
check('index: script and styles still referenced', indexHtml.includes('script.js?v=43') && indexHtml.includes('styles.css?v=43'));
check('index: font stylesheet still loaded', indexHtml.includes('fonts.googleapis.com/css2'));
check('index: preconnect hints added', indexHtml.includes('rel="preconnect" href="https://fonts.gstatic.com"'));
check('index: every _blank link has noopener',
    (indexHtml.match(/target="_blank"/g) || []).length === (indexHtml.match(/target="_blank" rel="noopener"/g) || []).length);

// ─── Report ────────────────────────────────────────────────────────────────────

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  ✗ ${f}`));
    process.exitCode = 1;
} else {
    console.log('All render, escaping, service-worker and markup checks passed.');
}
