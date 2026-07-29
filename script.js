const SUPABASE_URL_DEFAULT = 'https://jqfnlcdcxcydqwufgwpm.supabase.co';
const SUPABASE_KEY_DEFAULT = 'sb_publishable_r-IYBk1NyA18HITtgz8MBw_zNfOPKj2';
const ALLOWED_ACCOUNT_EMAIL = 'jenpayneg@gmail.com';

class OrangeContractApp {
    constructor() {
        this.currentWeekStart = this.getWeekStart(new Date());
        this.scheduleWeekStart = this.getWeekStart(new Date());
        const now = new Date();
        this.currentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        this.expenses = {};
        this.bookings = [];
        this.parkingBookings = [];
        this.accommodationBookings = [];
        this.transportBookings = [];
        this.plannedFlights = [];
        this.fareWatchAlerts = [];
        this.skippedBookings = [];
        this.skippedParkingBookings = [];
        this.selectedDate = null;
        this.locations = ['Glasgow', 'Aberdeen', 'Southampton', 'Home'];
        this.db = null;
        this.useSupabase = false;
        this.googleAccessToken = null;
        this.googleTokenClient = null;
        this._gmailFound = null;
        this._gmailParkingFound = null;
        this._currentBookingDate = null;
        this.linkedFreeAgentExpenses = [];
        this.currentUser = null;
        this.init();
    }

    async init() {
        this.setupAuthEventListeners();

        try {
            // Initialize secure credential manager
            await credentialManager.init();
            
            // Migrate existing credentials from localStorage to secure storage
            const migrated = await credentialManager.migrateFromLocalStorage();
            if (migrated > 0) {
                console.log(`Migrated ${migrated} credentials to secure storage`);
            }

            await this.initSupabase();
            const authenticated = await this.initializeAuth();
            if (!authenticated) return;
        } catch (error) {
            console.error('Application initialization failed:', error);
            this.showAuthGate('Unable to connect securely. Please refresh and try again.');
            return;
        }

        await this.loadAllData();
        await this.loadLinkedFreeAgentExpenses();
        this.loadLocations();
        await this.setupEventListeners();
        this.updateWeekDisplay();
        this.renderWeekTable();
        this.updateDashboard();
        this.renderBookings();
        this.renderFareWatch();
        this.populateLocationDropdown();
        this.initializeFreeAgentDateRange();
        this.updateMonthDisplay();
        this.renderMonthTable();
        this.renderSchedule();
        await this.loadFreeAgentVisibility();

        // Register Service Worker for PWA
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('./sw.js?v=19')
                    .then(reg => console.log('Service Worker registered successfully:', reg.scope))
                    .catch(err => console.warn('Service Worker registration failed:', err));
            });
        }
    }

    // ─── Supabase ──────────────────────────────────────────────────────────────

    async initSupabase() {
        this.setSyncStatus('connecting');
        this.db = supabase.createClient(SUPABASE_URL_DEFAULT, SUPABASE_KEY_DEFAULT);
        this.useSupabase = true;
    }

    setupAuthEventListeners() {
        document.getElementById('google-sign-in').addEventListener('click', () => this.signInWithGoogle());
        document.getElementById('sign-out').addEventListener('click', () => this.signOut());
    }

    async initializeAuth() {
        let { data: { session }, error } = await this.db.auth.getSession();

        // OAuth callback tokens are in the URL hash; getSession does not parse them.
        if (!session && window.location.hash.includes('access_token=')) {
            const params = new URLSearchParams(window.location.hash.slice(1));
            const accessToken = params.get('access_token');
            const refreshToken = params.get('refresh_token');
            const { data: setData, error: setError } = await this.db.auth.setSession({
                access_token: accessToken,
                refresh_token: refreshToken
            });
            window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
            if (setError) throw setError;
            session = setData.session;
        }

        if (error) throw error;

        if (!session) {
            this.showAuthGate();
            return false;
        }

        const email = session.user.email?.toLowerCase();
        if (email !== ALLOWED_ACCOUNT_EMAIL) {
            await this.db.auth.signOut();
            this.showAuthGate(`Access is restricted to ${ALLOWED_ACCOUNT_EMAIL}.`);
            return false;
        }

        const { error: accessError } = await this.db.from('expenses').select('id').limit(1);
        if (accessError) throw accessError;

        this.currentUser = session.user;
        this.showAuthenticatedApp();
        this.setSyncStatus('connected');
        return true;
    }

    async signInWithGoogle() {
        const button = document.getElementById('google-sign-in');
        const errorElement = document.getElementById('auth-error');
        button.disabled = true;
        errorElement.textContent = '';

        const redirectUrl = window.location.origin;
        const { error } = await this.db.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: redirectUrl }
        });

        if (error) {
            errorElement.textContent = error.message;
            button.disabled = false;
        }
    }

    async signOut() {
        const { error } = await this.db.auth.signOut();
        if (error) {
            this.showErrorMessage(`Sign out failed: ${error.message}`);
            return;
        }

        this.currentUser = null;
        this.showAuthGate();
    }

    showAuthGate(message = '') {
        document.body.classList.remove('auth-pending', 'auth-ready');
        document.body.classList.add('auth-required');
        document.getElementById('auth-error').textContent = message;
        document.getElementById('google-sign-in').disabled = false;
        document.getElementById('account-controls').classList.add('hidden');
        this.setSyncStatus('auth');
    }

    showAuthenticatedApp() {
        document.body.classList.remove('auth-pending', 'auth-required');
        document.body.classList.add('auth-ready');
        const signOutButton = document.getElementById('sign-out');
        if (signOutButton && this.currentUser) {
            signOutButton.title = `Signed in as ${this.currentUser.email}`;
        }
        document.getElementById('account-controls').classList.remove('hidden');
    }

    async saveSettingToDB(key, value) {
        await credentialManager.set(key, value);
    }

    setSyncStatus(state) {
        const el = document.getElementById('sync-status');
        if (!el) return;
        const states = {
            connecting: { text: '⏳ Connecting...', cls: '' },
            connected:  { text: '🟢 Synced',        cls: 'connected' },
            offline:    { text: '🔴 Local only',     cls: 'offline' },
            saving:     { text: '💾 Saving...',      cls: '' },
            auth:       { text: '🔒 Sign in required', cls: 'offline' },
        };
        const s = states[state] || states.offline;
        el.textContent = s.text;
        el.className = `sync-status ${s.cls}`;
    }

    // ─── Data loading ──────────────────────────────────────────────────────────

    cleanRoute(route) {
        if (!route) return '';
        let cleaned = route.toString()
            .replace(/flex\s*pass\s*(?:not\s*)?used/gi, '')
            .replace(/flexi?\s*(?:pass)?/gi, '')
            .replace(/\b(?:ezy|u2)\s*\d{3,4}\b/gi, '')
            .replace(/\b(?:ezy|u2)\b/gi, '')
            .replace(/\b[a-z]\d{1,4}\b/gi, '')
            .replace(/passenger\s+details\s+\d+\s+of\s+\d+/gi, '')
            .replace(/\s+/g, ' ')
            .trim();

        // If there's an arrow, make sure we clean both sides
        if (cleaned.includes('→') || cleaned.includes('to')) {
            const parts = cleaned.split(/\s*(?:→|to)\s*/i);
            if (parts.length === 2) {
                const start = parts[0].replace(/[^a-zA-Z\s]/g, '').trim();
                const end = parts[1].replace(/[^a-zA-Z\s]/g, '').trim();
                if (start && end) {
                    return `${start} → ${end}`;
                }
            }
        }
        return cleaned;
    }

    async loadAllData() {
        if (this.useSupabase) {
            await Promise.all([
                this.loadExpensesFromDB(),
                this.loadBookingsFromDB(),
                this.loadSkippedBookingsFromDB(),
                this.loadParkingFromDB(),
                this.loadSkippedParkingFromDB(),
                this.loadAccommodationFromDB(),
                this.loadTransportFromDB(),
                this.loadFareWatchData()
            ]);
        } else {
            this.expenses = JSON.parse(localStorage.getItem('orange-contract-expenses') || '{}');
            this.bookings = JSON.parse(localStorage.getItem('orange-contract-bookings') || '[]');
            this.skippedBookings = JSON.parse(localStorage.getItem('orange-contract-skipped') || '[]');
            this.skippedParkingBookings = JSON.parse(localStorage.getItem('orange-contract-skipped-parking') || '[]');
            this.parkingBookings = JSON.parse(localStorage.getItem('orange-contract-parking') || '[]');
            this.accommodationBookings = JSON.parse(localStorage.getItem('orange-contract-accommodation') || '[]');
            this.transportBookings = JSON.parse(localStorage.getItem('orange-contract-transport') || '[]');
            this.renderTransport();
        }
    }

    async loadSkippedBookingsFromDB() {
        const { data, error } = await this.db.from('skipped_bookings').select('booking_ref, date');
        if (error) { console.error('Error loading skipped bookings:', error); return; }
        this.skippedBookings = data.map(row => ({
            bookingRef: row.booking_ref,
            date: row.date
        }));
    }

    async loadSkippedParkingFromDB() {
        const { data, error } = await this.db.from('skipped_parkings').select('booking_ref, date');
        if (error) { console.error('Error loading skipped parking:', error); return; }
        this.skippedParkingBookings = data.map(row => ({
            bookingRef: row.booking_ref,
            date: row.date
        }));
    }

    async addToSkippedBookings(bookingRef, date) {
        if (!bookingRef || !date) return;
        
        const isAlreadySkipped = this.skippedBookings.some(
            sb => sb.bookingRef === bookingRef && sb.date === date
        );
        if (isAlreadySkipped) return;

        this.skippedBookings.push({ bookingRef, date });

        if (this.useSupabase) {
            const { error } = await this.db.from('skipped_bookings').insert({
                booking_ref: bookingRef,
                date: date
            });
            if (error) console.error('Error saving skipped booking to Supabase:', error);
        } else {
            localStorage.setItem('orange-contract-skipped', JSON.stringify(this.skippedBookings));
        }
    }

    async loadExpensesFromDB() {
        const { data, error } = await this.db.from('expenses').select('*');
        if (error) { console.error(error); return; }
        this.expenses = {};
        data.forEach(row => {
            this.expenses[row.date] = {
                location: row.destination,
                flight: parseFloat(row.flight) || 0,
                parking: parseFloat(row.parking) || 0,
                accommodation: parseFloat(row.accommodation) || 0,
                transport: parseFloat(row.transport) || 0,
                food: parseFloat(row.food) || 0,
                _id: row.id
            };
        });
    }

    async loadBookingsFromDB() {
        const { data, error } = await this.db.from('bookings').select('*').order('date', { ascending: true });
        if (error) { console.error(error); return; }
        this.bookings = data.map(row => ({
            id: row.id,
            flightNumber: row.flight_number,
            route: row.route,
            date: row.date,
            departureTime: row.departure_time,
            arrivalTime: row.arrival_time,
            pricePaid: parseFloat(row.price_paid) || 0,
            bookingRef: row.booking_ref,
            notes: row.notes,
            used: row.used || false,
            bookingDate: row.booking_date || null,
            seat: row.seat || ''
        }));
    }

    async loadParkingFromDB() {
        const { data, error } = await this.db.from('car_park_bookings').select('*').order('arrival_date', { ascending: true });
        if (error) { console.error(error); return; }
        this.parkingBookings = data.map(row => ({
            id: row.id,
            carParkName: row.car_park_name,
            arrivalDate: row.arrival_date,
            arrivalTime: row.arrival_time,
            returnDate: row.return_date,
            returnTime: row.return_time,
            pricePaid: parseFloat(row.price_paid) || 0,
            bookingRef: row.booking_ref,
            carRegistration: row.car_registration,
            bookingDate: row.booking_date || null,
            bookingStatus: row.booking_status || 'Booking',
            notes: row.notes
        }));
        this.renderParking();
    }

    async loadAccommodationFromDB() {
        const { data, error } = await this.db.from('accommodation_bookings').select('*').order('from_date', { ascending: true });
        if (error) { console.error(error); return; }
        this.accommodationBookings = data.map(row => ({
            id: row.id,
            name: row.name,
            fromDate: row.from_date,
            toDate: row.to_date,
            pricePerNight: parseFloat(row.price_per_night) || 0,
            breakfastIncluded: row.breakfast_included || false,
            bookingDate: row.booking_date || null,
            notes: row.notes
        }));
        this.renderAccommodation();
    }

    async loadTransportFromDB() {
        const { data, error } = await this.db.from('transport_bookings').select('*').order('from_date', { ascending: true });
        if (error) { console.error(error); return; }
        this.transportBookings = data.map(row => ({
            id: row.id,
            name: row.name,
            fromDate: row.from_date,
            toDate: row.to_date,
            totalCost: parseFloat(row.total_cost) || 0,
            bookingDate: row.booking_date || null,
            notes: row.notes
        }));
        this.renderTransport();
    }

    async loadFareWatchData() {
        const [{ data: flights, error: flightsError }, { data: alerts, error: alertsError }] = await Promise.all([
            this.db.from('planned_flights').select('*, flight_price_snapshots(*)').order('outbound_date', { ascending: true }),
            this.db.from('flight_price_alerts').select('*').eq('is_read', false).order('created_at', { ascending: false }).limit(10)
        ]);
        if (flightsError) { console.error('Error loading planned flights:', flightsError); return; }
        if (alertsError) console.error('Error loading fare alerts:', alertsError);
        this.plannedFlights = (flights || []).map(flight => ({
            ...flight,
            flight_price_snapshots: (flight.flight_price_snapshots || []).sort((a, b) => new Date(a.observed_at) - new Date(b.observed_at))
        }));
        this.fareWatchAlerts = alerts || [];
        this.renderFareWatch();
        this.showFareWatchNotifications();
    }

    // ─── Persist expenses ──────────────────────────────────────────────────────

    async saveExpenseRow(dateStr, expenseData) {
        if (this.useSupabase) {
            this.setSyncStatus('saving');
            const existing = this.expenses[dateStr];
            const row = {
                date: dateStr,
                destination: expenseData.location,
                flight: expenseData.flight,
                parking: expenseData.parking,
                accommodation: expenseData.accommodation,
                transport: expenseData.transport,
                food: expenseData.food,
                updated_at: new Date().toISOString()
            };
            if (existing && existing._id) {
                const { error } = await this.db.from('expenses').update(row).eq('id', existing._id);
                if (error) { console.error(error); this.setSyncStatus('offline'); return; }
            } else {
                const { data, error } = await this.db.from('expenses').insert(row).select().single();
                if (error) { console.error(error); this.setSyncStatus('offline'); return; }
                expenseData._id = data.id;
            }
            this.setSyncStatus('connected');
        } else {
            this.expenses[dateStr] = expenseData;
            localStorage.setItem('orange-contract-expenses', JSON.stringify(this.expenses));
        }
    }

    async deleteExpenseRow(dateStr) {
        const existing = this.expenses[dateStr];
        if (this.useSupabase && existing && existing._id) {
            this.setSyncStatus('saving');
            const { error } = await this.db.from('expenses').delete().eq('id', existing._id);
            if (error) { console.error(error); }
            this.setSyncStatus('connected');
        } else {
            localStorage.setItem('orange-contract-expenses', JSON.stringify(this.expenses));
        }
    }

    // ─── Persist bookings ──────────────────────────────────────────────────────

    async saveBookingToDB(booking) {
        if (this.useSupabase) {
            this.setSyncStatus('saving');
            const row = {
                flight_number: booking.flightNumber,
                route: booking.route,
                date: booking.date,
                departure_time: booking.departureTime,
                arrival_time: booking.arrivalTime,
                price_paid: booking.pricePaid,
                booking_ref: booking.bookingRef,
                notes: booking.notes,
                used: booking.used || false,
                booking_date: booking.bookingDate || null,
                seat: booking.seat || '',
                updated_at: new Date().toISOString()
            };
            if (booking.id && typeof booking.id === 'string' && booking.id.length === 36) {
                const { error } = await this.db.from('bookings').update(row).eq('id', booking.id);
                if (error) { console.error(error); this.setSyncStatus('offline'); return null; }
                this.setSyncStatus('connected');
                return booking.id;
            } else {
                const { data, error } = await this.db.from('bookings').insert(row).select().single();
                if (error) { console.error(error); this.setSyncStatus('offline'); return null; }
                this.setSyncStatus('connected');
                return data.id;
            }
        } else {
            localStorage.setItem('orange-contract-bookings', JSON.stringify(this.bookings));
            return booking.id;
        }
    }

    async deleteBookingFromDB(bookingId) {
        if (this.useSupabase) {
            this.setSyncStatus('saving');
            const { error } = await this.db.from('bookings').delete().eq('id', bookingId);
            if (error) { console.error(error); }
            this.setSyncStatus('connected');
        } else {
            localStorage.setItem('orange-contract-bookings', JSON.stringify(this.bookings));
        }
    }

    getWeekStart(date) {
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day;
        return new Date(d.setDate(diff));
    }

    formatDate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    formatCurrency(amount) {
        return `£${parseFloat(amount).toFixed(2)}`;
    }

    async setupEventListeners() {
        // Navigation
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.switchSection(e.target.dataset.section));
        });

        // Dashboard
        document.getElementById('prev-week').addEventListener('click', () => this.changeWeek(-1));
        document.getElementById('next-week').addEventListener('click', () => this.changeWeek(1));
        document.getElementById('expense-form').addEventListener('submit', (e) => this.handleFormSubmit(e));
        document.getElementById('clear-form').addEventListener('click', () => this.clearForm());
        document.getElementById('export-csv').addEventListener('click', () => this.exportToCSV());
        document.getElementById('export-json').addEventListener('click', () => this.exportToJSON());

        document.getElementById('schedule-prev-week').addEventListener('click', () => this.changeScheduleWeek(-1));
        document.getElementById('schedule-next-week').addEventListener('click', () => this.changeScheduleWeek(1));
        document.getElementById('schedule-calendar').addEventListener('click', (e) => {
            const item = e.target.closest('.schedule-item');
            if (item) this.showScheduleDetails(item.dataset.type, item.dataset.id);
        });
        document.getElementById('schedule-details-close').addEventListener('click', () => this.closeScheduleDetails());
        document.getElementById('schedule-details-dialog').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) this.closeScheduleDetails();
        });

        // Monthly Dashboard
        document.getElementById('prev-month').addEventListener('click', () => this.changeMonth(-1));
        document.getElementById('next-month').addEventListener('click', () => this.changeMonth(1));

        // Bookings
        document.getElementById('add-booking-btn').addEventListener('click', () => this.showBookingForm());
        document.getElementById('booking-form').addEventListener('submit', (e) => this.handleBookingSubmit(e));
        document.getElementById('cancel-booking-btn').addEventListener('click', () => this.hideBookingForm());

        // Fare Watch
        document.getElementById('add-planned-flight-btn').addEventListener('click', () => this.showPlannedFlightForm());
        document.getElementById('cancel-planned-flight-btn').addEventListener('click', () => this.hidePlannedFlightForm());
        document.getElementById('planned-flight-form').addEventListener('submit', (e) => this.handlePlannedFlightSubmit(e));
        document.getElementById('check-all-fares-btn').addEventListener('click', (e) => this.checkFarePrices(null, e.currentTarget));
        document.getElementById('planned-flights-list').addEventListener('click', (e) => this.handleFareWatchAction(e));
        document.getElementById('fare-watch-alerts').addEventListener('click', (e) => {
            const button = e.target.closest('[data-alert-id]');
            if (button) this.dismissFareWatchAlert(button.dataset.alertId);
        });

        // Parking
        document.getElementById('add-parking-btn').addEventListener('click', () => this.showParkingBookingForm());
        document.getElementById('parking-form').addEventListener('submit', (e) => this.handleParkingSubmit(e));
        document.getElementById('cancel-parking-btn').addEventListener('click', () => this.hideParkingForm());

        // Accommodation
        document.getElementById('add-accommodation-btn').addEventListener('click', () => this.showAccommodationForm());
        document.getElementById('accommodation-form').addEventListener('submit', (e) => this.handleAccommodationSubmit(e));
        document.getElementById('cancel-accommodation-btn').addEventListener('click', () => this.hideAccommodationForm());

        // Transport
        document.getElementById('add-transport-btn').addEventListener('click', () => this.showTransportForm());
        document.getElementById('transport-form').addEventListener('submit', (e) => this.handleTransportSubmit(e));
        document.getElementById('cancel-transport-btn').addEventListener('click', () => this.hideTransportForm());

        // FreeAgent
        document.getElementById('fetch-freeagent-btn').addEventListener('click', () => this.fetchFreeAgentExpenses());

        // Email Import
        document.getElementById('parse-email').addEventListener('click', () => this.parseEmail());

        // Gmail
        document.getElementById('gmail-connect-btn').addEventListener('click', async () => await this.connectGmail());
        document.getElementById('gmail-search-btn').addEventListener('click', () => this.searchGmailBookings());
        document.getElementById('gmail-parking-search-btn').addEventListener('click', () => this.searchGmailParkingBookings());
        document.getElementById('gmail-disconnect-btn').addEventListener('click', () => this.disconnectGmail());

        // Settings
        document.getElementById('save-google-client-id').addEventListener('click', async () => await this.saveGoogleClientId());
        document.getElementById('save-supabase').addEventListener('click', async () => await this.saveSupabaseSettings());
        document.getElementById('test-supabase').addEventListener('click', async () => await this.testSupabaseSettings());
        document.getElementById('save-gemini-key').addEventListener('click', async () => await this.saveGeminiKey());
        document.getElementById('save-freeagent').addEventListener('click', async () => await this.saveFreeAgentKey());
        document.getElementById('show-freeagent-toggle').addEventListener('change', () => this.saveFreeAgentVisibility());
        document.getElementById('save-locations').addEventListener('click', () => this.saveLocations());

        // Credential backup/restore
        document.getElementById('export-credentials').addEventListener('click', () => this.exportCredentials());
        document.getElementById('import-credentials').addEventListener('click', () => this.importCredentials());
        document.getElementById('credential-file-input').addEventListener('change', (e) => this.handleCredentialFile(e));

        // PWA Installation
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            this.deferredInstallPrompt = e;
            const installBtn = document.getElementById('pwa-install-btn');
            if (installBtn) {
                installBtn.style.display = 'block';
                installBtn.addEventListener('click', () => this.installPWA());
            }
        });

        // Pre-fill settings fields from secure credential manager
        const savedUrl = await credentialManager.get('sb-url');
        const savedKey = await credentialManager.get('sb-key');
        const savedClientId = await credentialManager.get('google-client-id');
        const savedGeminiKey = await credentialManager.get('gemini-api-key');
        const savedFreeAgentToken = await credentialManager.get('freeagent-token');

        if (savedUrl) document.getElementById('supabase-url').value = savedUrl;
        if (savedKey) document.getElementById('supabase-key').value = savedKey;
        if (savedClientId) document.getElementById('google-client-id').value = savedClientId;
        if (savedGeminiKey) document.getElementById('gemini-api-key').value = savedGeminiKey;
        if (savedFreeAgentToken) document.getElementById('freeagent-token').value = savedFreeAgentToken;

        // Restore Gmail connected state if token still valid
        this.initGmailState();
    }

    switchSection(sectionName) {
        // Hide all sections
        document.querySelectorAll('.content-section').forEach(section => {
            section.classList.remove('active');
        });
        
        // Remove active class from all nav buttons
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        
        // Show selected section
        document.getElementById(`${sectionName}-section`).classList.add('active');
        
        // Add active class to clicked button
        document.querySelector(`[data-section="${sectionName}"]`).classList.add('active');

        if (sectionName === 'schedule') this.renderSchedule();
        if (sectionName === 'fare-watch') this.renderFareWatch();
    }

    changeWeek(direction) {
        const newDate = new Date(this.currentWeekStart);
        newDate.setDate(newDate.getDate() + (direction * 7));
        this.currentWeekStart = newDate;
        this.updateWeekDisplay();
        this.renderWeekTable();
        this.updateDashboard();
    }

    changeScheduleWeek(direction) {
        const newDate = new Date(this.scheduleWeekStart);
        newDate.setDate(newDate.getDate() + (direction * 7));
        this.scheduleWeekStart = newDate;
        this.renderSchedule();
    }

    getScheduleItemsForDate(dateStr) {
        const flights = this.bookings
            .filter(booking => booking.date === dateStr)
            .map(booking => ({
                type: 'flight',
                id: booking.id,
                time: booking.departureTime || '',
                title: booking.flightNumber || 'Flight',
                subtitle: booking.route || 'Route not recorded'
            }));

        const parking = this.parkingBookings.flatMap(booking => {
            const events = [];
            if (booking.arrivalDate === dateStr) {
                events.push({
                    type: 'parking',
                    id: booking.id,
                    time: booking.arrivalTime || '',
                    title: booking.carParkName || 'Parking',
                    subtitle: 'Parking arrival'
                });
            }
            if (booking.returnDate === dateStr) {
                events.push({
                    type: 'parking',
                    id: booking.id,
                    time: booking.returnTime || '',
                    title: booking.carParkName || 'Parking',
                    subtitle: 'Parking departure'
                });
            }
            return events;
        });

        const transport = this.transportBookings.flatMap(booking => {
            const events = [];
            if (booking.fromDate === dateStr) {
                events.push({
                    type: 'transport',
                    id: booking.id,
                    time: '',
                    title: booking.name || 'Transport',
                    subtitle: 'Transport starts'
                });
            }
            if (booking.toDate === dateStr) {
                events.push({
                    type: 'transport',
                    id: booking.id,
                    time: '',
                    title: booking.name || 'Transport',
                    subtitle: 'Transport ends'
                });
            }
            return events;
        });

        return [...flights, ...parking, ...transport].sort((a, b) => {
            if (a.time && b.time) return a.time.localeCompare(b.time);
            if (a.time) return -1;
            if (b.time) return 1;
            return a.type.localeCompare(b.type);
        });
    }

    getLocationColor(location) {
        const palette = ['#54a0ff', '#ff6b35', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57', '#ff9ff3', '#ff9f43', '#10ac84', '#5f27cd'];
        if (!location) return 'var(--muted)';
        let hash = 0;
        for (let i = 0; i < location.length; i++) hash = location.charCodeAt(i) + ((hash << 5) - hash);
        return palette[Math.abs(hash) % palette.length];
    }

    renderSchedule() {
        const calendar = document.getElementById('schedule-calendar');
        const display = document.getElementById('schedule-week-display');
        if (!calendar || !display) return;

        const weekEnd = new Date(this.scheduleWeekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        const dateOptions = { day: 'numeric', month: 'short' };
        display.textContent = `${this.scheduleWeekStart.toLocaleDateString('en-GB', dateOptions)} — ${weekEnd.toLocaleDateString('en-GB', { ...dateOptions, year: 'numeric' })}`;

        const today = this.formatDate(new Date());
        const days = [];
        for (let i = 0; i < 7; i++) {
            const date = new Date(this.scheduleWeekStart);
            date.setDate(date.getDate() + i);
            const dateStr = this.formatDate(date);
            const items = this.getScheduleItemsForDate(dateStr);
            const dayExpenses = this.expenses[dateStr] || this.getDefaultExpenses();
            const location = dayExpenses.location || '';
            const locationColor = this.getLocationColor(location);
            days.push(`
                <article class="schedule-day ${dateStr === today ? 'today' : ''}">
                    <div class="schedule-day-header">
                        <span>${date.toLocaleDateString('en-GB', { weekday: 'short' })}</span>
                        <strong>${date.getDate()}</strong>
                        <small>${date.toLocaleDateString('en-GB', { month: 'short' })}</small>
                    </div>
                    <div class="schedule-location" style="color:${locationColor};border-color:${locationColor}">
                        ${location || 'No location'}
                    </div>
                    <div class="schedule-day-items">
                        ${items.length ? items.map(item => `
                            <button class="schedule-item ${item.type}" type="button" data-type="${item.type}" data-id="${item.id}">
                                <span class="schedule-item-type">${item.type}</span>
                                <strong>${item.time ? `${item.time} · ` : ''}${item.title}</strong>
                                <small>${item.subtitle}</small>
                            </button>
                        `).join('') : '<span class="schedule-empty">No bookings</span>'}
                    </div>
                </article>
            `);
        }
        calendar.innerHTML = days.join('');
    }

    showScheduleDetails(type, id) {
        const dialog = document.getElementById('schedule-details-dialog');
        const typeEl = document.getElementById('schedule-details-type');
        const titleEl = document.getElementById('schedule-details-title');
        const bodyEl = document.getElementById('schedule-details-body');
        let item;
        let title;
        let rows = [];

        if (type === 'flight') {
            item = this.bookings.find(booking => String(booking.id) === String(id));
            if (!item) return;
            title = `${item.flightNumber || 'Flight'} · ${item.route || 'Route not recorded'}`;
            rows = [
                ['Date', this.formatDateUK(item.date)],
                ['Times', [item.departureTime, item.arrivalTime].filter(Boolean).join(' → ') || 'Not recorded'],
                ['Booking reference', item.bookingRef || 'Not recorded'],
                ['Seat', item.seat || 'Not recorded'],
                ['Price', this.formatCurrency(item.pricePaid || 0)],
                ['Notes', item.notes || 'None']
            ];
        } else if (type === 'parking') {
            item = this.parkingBookings.find(booking => String(booking.id) === String(id));
            if (!item) return;
            title = item.carParkName || 'Parking';
            rows = [
                ['Arrive', `${this.formatDateUK(item.arrivalDate)} ${item.arrivalTime || ''}`.trim()],
                ['Return', `${this.formatDateUK(item.returnDate)} ${item.returnTime || ''}`.trim()],
                ['Booking reference', item.bookingRef || 'Not recorded'],
                ['Registration', item.carRegistration || 'Not recorded'],
                ['Price', this.formatCurrency(item.pricePaid || 0)],
                ['Notes', item.notes || 'None']
            ];
        } else if (type === 'transport') {
            item = this.transportBookings.find(booking => String(booking.id) === String(id));
            if (!item) return;
            title = item.name || 'Transport';
            rows = [
                ['From', this.formatDateUK(item.fromDate)],
                ['To', this.formatDateUK(item.toDate)],
                ['Duration', `${this.calculateTransportDays(item.fromDate, item.toDate)} day(s)`],
                ['Total cost', this.formatCurrency(item.totalCost || 0)],
                ['Notes', item.notes || 'None']
            ];
        } else {
            return;
        }

        typeEl.textContent = type;
        typeEl.className = `schedule-details-type ${type}`;
        titleEl.textContent = title;
        bodyEl.innerHTML = rows.map(([label, value]) => `<div class="schedule-detail-row"><span>${label}</span><strong>${value}</strong></div>`).join('');
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
    }

    closeScheduleDetails() {
        const dialog = document.getElementById('schedule-details-dialog');
        if (dialog.open && typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
    }

    changeMonth(direction) {
        const newDate = new Date(this.currentMonth);
        newDate.setMonth(newDate.getMonth() + direction);
        newDate.setDate(1);
        this.currentMonth = newDate;
        this.updateMonthDisplay();
        this.renderMonthTable();
    }

    updateMonthDisplay() {
        const options = { month: 'long', year: 'numeric' };
        const monthStr = this.currentMonth.toLocaleDateString('en-US', options);
        document.getElementById('month-display').textContent = monthStr;

        const today = new Date();
        const monthDiff = (today.getFullYear() - this.currentMonth.getFullYear()) * 12 + (today.getMonth() - this.currentMonth.getMonth());
        let monthLabel = 'Current month';
        if (monthDiff !== 0) {
            const absDiff = Math.abs(monthDiff);
            const direction = monthDiff > 0 ? 'ago' : 'ahead';
            monthLabel = `${absDiff} month${absDiff > 1 ? 's' : ''} ${direction}`;
        }
        const currentMonthEl = document.getElementById('current-month');
        if (currentMonthEl) currentMonthEl.textContent = monthLabel;
    }

    renderMonthTable() {
        const tbody = document.getElementById('month-tbody');
        tbody.innerHTML = '';

        const year = this.currentMonth.getFullYear();
        const month = this.currentMonth.getMonth();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const dayColors = ['#54a0ff', '#ff6b35', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57', '#ff9ff3'];

        let totalFlight = 0;
        let totalParking = 0;
        let totalAccommodation = 0;
        let totalTransport = 0;
        let totalFood = 0;
        let totalDayRate = 0;
        let totalDailyTotal = 0;
        let daysWorked = 0;

        for (let day = 1; day <= daysInMonth; day++) {
            const currentDate = new Date(year, month, day);
            const dateStr = this.formatDate(currentDate);
            const dayOfWeek = currentDate.getDay();
            const dayExpenses = this.expenses[dateStr] || this.getDefaultExpenses();

            const flightCostFromBookings = this.getFlightCostFromBookings(dateStr);
            const parkingCostFromBookings = this.getParkingCostFromBookings(dateStr);
            const accommodationCostFromBookings = this.getAccommodationCostFromBookings(dateStr);
            const transportCostFromBookings = this.getTransportCostFromBookings(dateStr);

            const totalFlightCost = dayExpenses.flight + flightCostFromBookings;
            const totalParkingCost = dayExpenses.parking + parkingCostFromBookings;
            const totalAccommodationCost = dayExpenses.accommodation + accommodationCostFromBookings;
            const totalTransportCost = dayExpenses.transport + transportCostFromBookings;
            const totalFoodCost = dayExpenses.food;

            // Day Rate: Glasgow £850, Home/others £790, Leave £0
            let dayRate = 0;
            if (dayExpenses.location === 'Glasgow') {
                dayRate = 850;
            } else if (dayExpenses.location && dayExpenses.location !== 'Leave') {
                dayRate = 790;
            }

            if (dayRate > 0) {
                daysWorked++;
            }

            const dailyTotal = dayRate - totalFlightCost - totalParkingCost - totalAccommodationCost - totalTransportCost - totalFoodCost;

            totalFlight += totalFlightCost;
            totalParking += totalParkingCost;
            totalAccommodation += totalAccommodationCost;
            totalTransport += totalTransportCost;
            totalFood += totalFoodCost;
            totalDayRate += dayRate;
            totalDailyTotal += dailyTotal;

            const locationOptions = this.locations.map(loc => `<option value="${loc}" ${dayExpenses.location === loc ? 'selected' : ''}>${loc}</option>`).join('');
            const row = document.createElement('tr');
            row.innerHTML = `
                <td class="day-name" style="color: ${dayColors[dayOfWeek]}">${days[dayOfWeek]}</td>
                <td>${dateStr}</td>
                <td>
                    <select class="location-dropdown" data-date="${dateStr}" onchange="app.updateLocation('${dateStr}', this.value)">
                        <option value="">-</option>
                        ${locationOptions}
                    </select>
                </td>
                <td class="expense-amount">${totalFlightCost > 0 ? this.formatCurrency(totalFlightCost) : '-'}</td>
                <td class="expense-amount">${totalParkingCost > 0 ? this.formatCurrency(totalParkingCost) : '-'}</td>
                <td class="expense-amount">${totalAccommodationCost > 0 ? this.formatCurrency(totalAccommodationCost) : '-'}</td>
                <td class="expense-amount">${totalTransportCost > 0 ? this.formatCurrency(totalTransportCost) : '-'}</td>
                <td class="expense-amount">${totalFoodCost > 0 ? this.formatCurrency(totalFoodCost) : '-'}</td>
                <td class="expense-amount">${dayRate > 0 ? this.formatCurrency(dayRate) : '-'}</td>
                <td class="daily-total">${this.formatCurrency(dailyTotal)}</td>
            `;
            tbody.appendChild(row);
        }

        // Add totals row
        const totalRow = document.createElement('tr');
        totalRow.style.background = '#fff8f5';
        totalRow.style.fontWeight = '600';
        totalRow.innerHTML = `
            <td></td>
            <td></td>
            <td style="text-align: right; padding-right: 1rem;">Totals:</td>
            <td class="expense-amount">${totalFlight > 0 ? this.formatCurrency(totalFlight) : '-'}</td>
            <td class="expense-amount">${totalParking > 0 ? this.formatCurrency(totalParking) : '-'}</td>
            <td class="expense-amount">${totalAccommodation > 0 ? this.formatCurrency(totalAccommodation) : '-'}</td>
            <td class="expense-amount">${totalTransport > 0 ? this.formatCurrency(totalTransport) : '-'}</td>
            <td class="expense-amount">${totalFood > 0 ? this.formatCurrency(totalFood) : '-'}</td>
            <td class="expense-amount">${totalDayRate > 0 ? this.formatCurrency(totalDayRate) : '-'}</td>
            <td class="daily-total">${this.formatCurrency(totalDailyTotal)}</td>
        `;
        tbody.appendChild(totalRow);

        // Add net profit row
        const profitRow = document.createElement('tr');
        profitRow.style.background = totalDailyTotal >= 0 ? '#d4edda' : '#f8d7da';
        profitRow.style.fontWeight = '600';
        profitRow.innerHTML = `
            <td></td>
            <td></td>
            <td style="text-align: right; padding-right: 1rem;">Net Profit:</td>
            <td colspan="7" style="text-align: center; color: ${totalDailyTotal >= 0 ? '#155724' : '#721c24'}; font-size: 1.1rem;">${this.formatCurrency(totalDailyTotal)}</td>
        `;
        tbody.appendChild(profitRow);

        // Add real day rate row
        const realDayRate = daysWorked > 0 ? totalDailyTotal / daysWorked : 0;
        const realDayRateRow = document.createElement('tr');
        realDayRateRow.style.background = '#fff8f5';
        realDayRateRow.style.fontWeight = '600';
        realDayRateRow.innerHTML = `
            <td></td>
            <td></td>
            <td style="text-align: right; padding-right: 1rem;">Real Day Rate (${daysWorked} day${daysWorked !== 1 ? 's' : ''}):</td>
            <td colspan="7" style="text-align: center; font-size: 1.1rem;">${this.formatCurrency(realDayRate)}</td>
        `;
        tbody.appendChild(realDayRateRow);

        // Update monthly dashboard cards
        const monthNetProfitEl = document.getElementById('month-net-profit');
        const monthActualDayRateEl = document.getElementById('month-actual-day-rate');
        if (monthNetProfitEl) monthNetProfitEl.textContent = this.formatCurrency(totalDailyTotal);
        if (monthActualDayRateEl) monthActualDayRateEl.textContent = this.formatCurrency(realDayRate);
    }

    updateWeekDisplay() {
        const weekEnd = new Date(this.currentWeekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        
        const options = { month: 'short', day: 'numeric' };
        const startStr = this.currentWeekStart.toLocaleDateString('en-US', options);
        const endStr = weekEnd.toLocaleDateString('en-US', options);
        
        document.getElementById('week-display').textContent = `Week of ${startStr} - ${endStr}`;
        
        const today = new Date();
        if (today >= this.currentWeekStart && today <= weekEnd) {
            document.getElementById('current-week').textContent = 'Current Week';
        } else {
            const weekDiff = Math.floor((today - this.currentWeekStart) / (7 * 24 * 60 * 60 * 1000));
            document.getElementById('current-week').textContent = weekDiff === 0 ? 'Current Week' : 
                weekDiff > 0 ? `${weekDiff} week${weekDiff > 1 ? 's' : ''} ago` : 
                `${Math.abs(weekDiff)} week${Math.abs(weekDiff) > 1 ? 's' : ''} ahead`;
        }
    }

    renderWeekTable() {
        const tbody = document.getElementById('week-tbody');
        tbody.innerHTML = '';
        
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const dayColors = ['#54a0ff', '#ff6b35', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57', '#ff9ff3'];
        
        for (let i = 0; i < 7; i++) {
            const currentDate = new Date(this.currentWeekStart);
            currentDate.setDate(currentDate.getDate() + i);
            const dateStr = this.formatDate(currentDate);
            const dayExpenses = this.expenses[dateStr] || this.getDefaultExpenses();
            const flightCostFromBookings = this.getFlightCostFromBookings(dateStr);
            const parkingCostFromBookings = this.getParkingCostFromBookings(dateStr);
            const accommodationCostFromBookings = this.getAccommodationCostFromBookings(dateStr);
            const transportCostFromBookings = this.getTransportCostFromBookings(dateStr);
            const totalFlightCost = dayExpenses.flight + flightCostFromBookings;
            const totalParkingCost = dayExpenses.parking + parkingCostFromBookings;
            const totalAccommodationCost = dayExpenses.accommodation + accommodationCostFromBookings;
            const totalTransportCost = dayExpenses.transport + transportCostFromBookings;

            const row = document.createElement('tr');
            const locationOptions = this.locations.map(loc => `<option value="${loc}" ${dayExpenses.location === loc ? 'selected' : ''}>${loc}</option>`).join('');
            row.innerHTML = `
                <td class="day-name" style="color: ${dayColors[i]}">${days[i]}</td>
                <td>
                    <select class="location-dropdown" data-date="${dateStr}" onchange="app.updateLocation('${dateStr}', this.value)">
                        <option value="">-</option>
                        ${locationOptions}
                    </select>
                </td>
                <td class="expense-amount">${totalFlightCost > 0 ? this.formatCurrency(totalFlightCost) : '-'}</td>
                <td class="expense-amount">${totalParkingCost > 0 ? this.formatCurrency(totalParkingCost) : '-'}</td>
                <td class="expense-amount">${totalAccommodationCost > 0 ? this.formatCurrency(totalAccommodationCost) : '-'}</td>
                <td class="expense-amount">${totalTransportCost > 0 ? this.formatCurrency(totalTransportCost) : '-'}</td>
                <td class="expense-amount">${dayExpenses.food > 0 ? this.formatCurrency(dayExpenses.food) : '-'}</td>
                <td class="daily-total">${this.formatCurrency(this.calculateDailyTotal(dayExpenses) + flightCostFromBookings + parkingCostFromBookings + accommodationCostFromBookings + transportCostFromBookings)}</td>
                <td>
                    <button class="edit-btn" onclick="app.editDay('${dateStr}')">Edit</button>
                    <button class="clear-btn" onclick="app.clearDay('${dateStr}')">Clear</button>
                </td>
            `;
            tbody.appendChild(row);
        }

        // Add column totals row
        const columnTotals = this.calculateColumnTotals();
        const totalRow = document.createElement('tr');
        totalRow.style.background = '#fff8f5';
        totalRow.style.fontWeight = '600';
        totalRow.innerHTML = `
            <td></td>
            <td style="text-align: right; padding-right: 1rem;">Totals:</td>
            <td class="expense-amount">${columnTotals.flight > 0 ? this.formatCurrency(columnTotals.flight) : '-'}</td>
            <td class="expense-amount">${columnTotals.parking > 0 ? this.formatCurrency(columnTotals.parking) : '-'}</td>
            <td class="expense-amount">${columnTotals.accommodation > 0 ? this.formatCurrency(columnTotals.accommodation) : '-'}</td>
            <td class="expense-amount">${columnTotals.transport > 0 ? this.formatCurrency(columnTotals.transport) : '-'}</td>
            <td class="expense-amount">${columnTotals.food > 0 ? this.formatCurrency(columnTotals.food) : '-'}</td>
            <td class="daily-total">${this.formatCurrency(columnTotals.grandTotal)}</td>
            <td></td>
        `;
        tbody.appendChild(totalRow);
    }

    getFlightCostFromBookings(dateStr) {
        const bookingsOnDate = this.bookings.filter(b => b.date === dateStr);
        return bookingsOnDate.reduce((sum, b) => sum + (b.pricePaid || 0), 0);
    }

    getParkingCostFromBookings(dateStr) {
        const parkingOnDate = this.parkingBookings.filter(p => p.arrivalDate === dateStr);
        return parkingOnDate.reduce((sum, p) => sum + (p.pricePaid || 0), 0);
    }

    getAccommodationCostFromBookings(dateStr) {
        const accommodationOnDate = this.accommodationBookings.filter(a => {
            const fromDate = new Date(a.fromDate);
            const toDate = new Date(a.toDate);
            const checkDate = new Date(dateStr);
            // Include from_date but exclude to_date (checkout day)
            return checkDate >= fromDate && checkDate < toDate;
        });
        return accommodationOnDate.reduce((sum, a) => sum + (a.pricePerNight || 0), 0);
    }

    getTransportCostFromBookings(dateStr) {
        const checkDate = new Date(dateStr);
        return this.transportBookings.reduce((sum, t) => {
            const fromDate = new Date(t.fromDate);
            const toDate = new Date(t.toDate);
            if (checkDate >= fromDate && checkDate <= toDate) {
                const days = this.calculateTransportDays(t.fromDate, t.toDate);
                return sum + (days > 0 ? t.totalCost / days : 0);
            }
            return sum;
        }, 0);
    }

    calculateTransportDays(fromDate, toDate) {
        const from = new Date(fromDate);
        const to = new Date(toDate);
        const diffTime = to - from;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return Math.max(1, diffDays + 1);
    }

    calculateColumnTotals() {
        let totals = {
            flight: 0,
            parking: 0,
            accommodation: 0,
            transport: 0,
            food: 0,
            grandTotal: 0
        };

        for (let i = 0; i < 7; i++) {
            const currentDate = new Date(this.currentWeekStart);
            currentDate.setDate(currentDate.getDate() + i);
            const dateStr = this.formatDate(currentDate);
            const dayExpenses = this.expenses[dateStr] || this.getDefaultExpenses();
            const flightCostFromBookings = this.getFlightCostFromBookings(dateStr);
            const parkingCostFromBookings = this.getParkingCostFromBookings(dateStr);
            const accommodationCostFromBookings = this.getAccommodationCostFromBookings(dateStr);
            const transportCostFromBookings = this.getTransportCostFromBookings(dateStr);

            totals.flight += dayExpenses.flight + flightCostFromBookings;
            totals.parking += dayExpenses.parking + parkingCostFromBookings;
            totals.accommodation += dayExpenses.accommodation + accommodationCostFromBookings;
            totals.transport += dayExpenses.transport + transportCostFromBookings;
            totals.food += dayExpenses.food;
        }

        totals.grandTotal = totals.flight + totals.parking + totals.accommodation + totals.transport + totals.food;
        return totals;
    }

    async updateLocation(dateStr, location) {
        const dayExpenses = this.expenses[dateStr] || this.getDefaultExpenses();
        dayExpenses.location = location;
        this.expenses[dateStr] = dayExpenses;
        await this.saveExpenseRow(dateStr, dayExpenses);
        this.renderWeekTable();
        this.renderMonthTable();
        this.updateDashboard();
        this.showSuccessMessage('Location updated!');
    }

    getDefaultExpenses() {
        return {
            location: '',
            flight: 0,
            parking: 0,
            accommodation: 0,
            transport: 0,
            food: 0
        };
    }

    calculateDailyTotal(expenses) {
        return expenses.flight + expenses.parking + expenses.accommodation + expenses.transport + expenses.food;
    }

    calculateWeeklyTotal() {
        let total = 0;
        for (let i = 0; i < 7; i++) {
            const currentDate = new Date(this.currentWeekStart);
            currentDate.setDate(currentDate.getDate() + i);
            const dateStr = this.formatDate(currentDate);
            const dayExpenses = this.expenses[dateStr] || this.getDefaultExpenses();
            const flightCostFromBookings = this.getFlightCostFromBookings(dateStr);
            const parkingCostFromBookings = this.getParkingCostFromBookings(dateStr);
            const accommodationCostFromBookings = this.getAccommodationCostFromBookings(dateStr);
            const transportCostFromBookings = this.getTransportCostFromBookings(dateStr);
            total += this.calculateDailyTotal(dayExpenses) + flightCostFromBookings + parkingCostFromBookings + accommodationCostFromBookings + transportCostFromBookings;
        }
        return total;
    }

    updateDashboard() {
        const weeklyTotal = this.calculateWeeklyTotal();
        const monthlyEstimate = weeklyTotal * 4.33; // Average weeks per month
        
        document.getElementById('weekly-total').textContent = this.formatCurrency(weeklyTotal);
        document.getElementById('monthly-estimate').textContent = this.formatCurrency(monthlyEstimate);
    }

    editDay(dateStr) {
        this.selectedDate = dateStr;
        const dayExpenses = this.expenses[dateStr] || this.getDefaultExpenses();
        const flightCostFromBookings = this.getFlightCostFromBookings(dateStr);
        const parkingCostFromBookings = this.getParkingCostFromBookings(dateStr);
        const accommodationCostFromBookings = this.getAccommodationCostFromBookings(dateStr);
        const transportCostFromBookings = this.getTransportCostFromBookings(dateStr);
        const totalFlightCost = dayExpenses.flight + flightCostFromBookings;
        const totalParkingCost = dayExpenses.parking + parkingCostFromBookings;
        const totalAccommodationCost = dayExpenses.accommodation + accommodationCostFromBookings;
        const totalTransportCost = dayExpenses.transport + transportCostFromBookings;

        document.getElementById('selected-date').value = dateStr;
        document.getElementById('location').value = dayExpenses.location || '';
        document.getElementById('flight').value = totalFlightCost > 0 ? totalFlightCost : '';
        document.getElementById('parking').value = totalParkingCost > 0 ? totalParkingCost : '';
        document.getElementById('accommodation').value = totalAccommodationCost > 0 ? totalAccommodationCost : '';
        document.getElementById('transport').value = totalTransportCost > 0 ? totalTransportCost : '';
        document.getElementById('food').value = dayExpenses.food || '';

        // Make flight input read-only if it comes from bookings
        const flightInput = document.getElementById('flight');
        if (flightCostFromBookings > 0) {
            flightInput.readOnly = true;
            flightInput.title = 'Flight cost from bookings - edit in Bookings tab';
            flightInput.style.background = '#f0f0f0';
        } else {
            flightInput.readOnly = false;
            flightInput.title = '';
            flightInput.style.background = '';
        }

        // Make parking input read-only if it comes from bookings
        const parkingInput = document.getElementById('parking');
        if (parkingCostFromBookings > 0) {
            parkingInput.readOnly = true;
            parkingInput.title = 'Parking cost from bookings - edit in Parking tab';
            parkingInput.style.background = '#f0f0f0';
        } else {
            parkingInput.readOnly = false;
            parkingInput.title = '';
            parkingInput.style.background = '';
        }

        // Make accommodation input read-only if it comes from bookings
        const accommodationInput = document.getElementById('accommodation');
        if (accommodationCostFromBookings > 0) {
            accommodationInput.readOnly = true;
            accommodationInput.title = 'Accommodation cost from bookings - edit in Accommodation tab';
            accommodationInput.style.background = '#f0f0f0';
        } else {
            accommodationInput.readOnly = false;
            accommodationInput.title = '';
            accommodationInput.style.background = '';
        }
        
        // Make transport input read-only if it comes from bookings
        const transportInput = document.getElementById('transport');
        if (transportCostFromBookings > 0) {
            transportInput.readOnly = true;
            transportInput.title = 'Transport cost from bookings - edit in Transport tab';
            transportInput.style.background = '#f0f0f0';
        } else {
            transportInput.readOnly = false;
            transportInput.title = '';
            transportInput.style.background = '';
        }
        
        // Scroll to form
        document.querySelector('.expense-form').scrollIntoView({ behavior: 'smooth' });
    }

    async clearDay(dateStr) {
        if (confirm('Are you sure you want to clear all expenses for this day?')) {
            await this.deleteExpenseRow(dateStr);
            delete this.expenses[dateStr];
            this.renderWeekTable();
            this.updateDashboard();
        }
    }

    async handleFormSubmit(e) {
        e.preventDefault();
        const dateStr = document.getElementById('selected-date').value;
        if (!dateStr) {
            alert('Please click Edit on a day first');
            return;
        }
        const flightCostFromBookings = this.getFlightCostFromBookings(dateStr);
        const parkingCostFromBookings = this.getParkingCostFromBookings(dateStr);
        const accommodationCostFromBookings = this.getAccommodationCostFromBookings(dateStr);
        const transportCostFromBookings = this.getTransportCostFromBookings(dateStr);
        const dayExpenses = this.expenses[dateStr] || this.getDefaultExpenses();
        const totalFlightValue = parseFloat(document.getElementById('flight').value) || 0;
        const totalParkingValue = parseFloat(document.getElementById('parking').value) || 0;
        const totalAccommodationValue = parseFloat(document.getElementById('accommodation').value) || 0;
        const totalTransportValue = parseFloat(document.getElementById('transport').value) || 0;

        // If flight cost comes from bookings, preserve manual portion only
        let flightToSave = dayExpenses.flight;
        if (flightCostFromBookings > 0) {
            // Flight input shows total (manual + bookings), so subtract bookings to get manual
            flightToSave = Math.max(0, totalFlightValue - flightCostFromBookings);
        } else {
            // No bookings, save the value as-is
            flightToSave = totalFlightValue;
        }

        // If parking cost comes from bookings, preserve manual portion only
        let parkingToSave = dayExpenses.parking;
        if (parkingCostFromBookings > 0) {
            // Parking input shows total (manual + bookings), so subtract bookings to get manual
            parkingToSave = Math.max(0, totalParkingValue - parkingCostFromBookings);
        } else {
            // No bookings, save the value as-is
            parkingToSave = totalParkingValue;
        }

        // If accommodation cost comes from bookings, preserve manual portion only
        let accommodationToSave = dayExpenses.accommodation;
        if (accommodationCostFromBookings > 0) {
            // Accommodation input shows total (manual + bookings), so subtract bookings to get manual
            accommodationToSave = Math.max(0, totalAccommodationValue - accommodationCostFromBookings);
        } else {
            // No bookings, save the value as-is
            accommodationToSave = totalAccommodationValue;
        }

        // If transport cost comes from bookings, preserve manual portion only
        let transportToSave = dayExpenses.transport;
        if (transportCostFromBookings > 0) {
            // Transport input shows total (manual + bookings), so subtract bookings to get manual
            transportToSave = Math.max(0, totalTransportValue - transportCostFromBookings);
        } else {
            // No bookings, save the value as-is
            transportToSave = totalTransportValue;
        }

        const expenseData = {
            location: document.getElementById('location').value,
            flight: flightToSave,
            parking: parkingToSave,
            accommodation: accommodationToSave,
            transport: transportToSave,
            food: parseFloat(document.getElementById('food').value) || 0,
            _id: this.expenses[dateStr] ? this.expenses[dateStr]._id : undefined
        };
        this.expenses[dateStr] = expenseData;
        await this.saveExpenseRow(dateStr, expenseData);
        this.renderWeekTable();
        this.updateDashboard();
        this.clearForm();
        this.showSuccessMessage('Expenses saved!');
    }

    clearForm() {
        document.getElementById('expense-form').reset();
        document.getElementById('selected-date').value = '';
        this.selectedDate = null;
    }

    showSuccessMessage(message) {
        const messageDiv = document.createElement('div');
        messageDiv.textContent = message;
        messageDiv.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #4CAF50;
            color: white;
            padding: 1rem 1.5rem;
            border-radius: 8px;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
            z-index: 1000;
            animation: slideIn 0.3s ease;
        `;
        
        document.body.appendChild(messageDiv);
        
        setTimeout(() => {
            messageDiv.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => messageDiv.remove(), 300);
        }, 3000);
    }

    exportToCSV() {
        const csvData = this.generateCSVData();
        const blob = new Blob([csvData], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `orange-contract-expenses-${this.formatDate(new Date())}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    generateCSVData() {
        let csv = 'Date,Location,Flight,Parking,Accommodation,Transport,Food,Daily Total\n';

        const sortedDates = Object.keys(this.expenses).sort();

        sortedDates.forEach(dateStr => {
            const expenses = this.expenses[dateStr];
            const total = this.calculateDailyTotal(expenses);

            csv += `${dateStr},"${expenses.location}",${expenses.flight},${expenses.parking},${expenses.accommodation},${expenses.transport},${expenses.food},${total}\n`;
        });

        return csv;
    }

    exportToJSON() {
        const jsonData = {
            exportDate: new Date().toISOString(),
            expenses: this.expenses,
            summary: {
                totalExpenses: Object.values(this.expenses).reduce((sum, day) => sum + this.calculateDailyTotal(day), 0),
                totalDays: Object.keys(this.expenses).length,
                averageDailyCost: Object.values(this.expenses).length > 0 ?
                    Object.values(this.expenses).reduce((sum, day) => sum + this.calculateDailyTotal(day), 0) / Object.values(this.expenses).length : 0
            }
        };
        const blob = new Blob([JSON.stringify(jsonData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `orange-contract-expenses-${this.formatDate(new Date())}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ─── Bookings ──────────────────────────────────────────────────────────────

    showBookingForm(booking = null) {
        document.getElementById('booking-form-container').classList.remove('hidden');
        document.getElementById('booking-form-title').textContent = booking ? 'Edit Booking' : 'Add Booking';
        document.getElementById('booking-id').value = booking ? booking.id : '';
        document.getElementById('booking-flight-number').value = booking ? booking.flightNumber : '';
        document.getElementById('booking-route').value = booking ? booking.route : '';
        document.getElementById('booking-date').value = booking ? booking.date : '';
        document.getElementById('booking-departure').value = booking ? booking.departureTime : '';
        document.getElementById('booking-arrival').value = booking ? booking.arrivalTime : '';
        document.getElementById('booking-price').value = booking ? booking.pricePaid : '';
        document.getElementById('booking-ref').value = booking ? booking.bookingRef : '';
        document.getElementById('booking-seat').value = booking ? booking.seat : '';
        document.getElementById('booking-notes').value = booking ? booking.notes : '';
        document.getElementById('booking-booking-date').value = booking ? booking.bookingDate : '';
        document.getElementById('booking-form-container').scrollIntoView({ behavior: 'smooth' });
    }

    hideBookingForm() {
        document.getElementById('booking-form-container').classList.add('hidden');
        document.getElementById('booking-form').reset();
    }

    async handleBookingSubmit(e) {
        e.preventDefault();
        const id = document.getElementById('booking-id').value;
        const booking = {
            id: id || null,
            flightNumber: document.getElementById('booking-flight-number').value.trim().toUpperCase(),
            route: document.getElementById('booking-route').value.trim(),
            date: document.getElementById('booking-date').value,
            departureTime: document.getElementById('booking-departure').value.trim(),
            arrivalTime: document.getElementById('booking-arrival').value.trim(),
            pricePaid: parseFloat(document.getElementById('booking-price').value) || 0,
            bookingRef: document.getElementById('booking-ref').value.trim().toUpperCase(),
            seat: document.getElementById('booking-seat').value.trim().toUpperCase(),
            notes: document.getElementById('booking-notes').value.trim(),
            bookingDate: document.getElementById('booking-booking-date').value || null
        };
        const savedId = await this.saveBookingToDB(booking);
        if (savedId) booking.id = savedId;
        if (id) {
            const idx = this.bookings.findIndex(b => b.id === id);
            if (idx > -1) this.bookings[idx] = booking;
        } else {
            this.bookings.push(booking);
        }
        if (!this.useSupabase) {
            localStorage.setItem('orange-contract-bookings', JSON.stringify(this.bookings));
        }
        this.hideBookingForm();
        this.renderBookings();
        this.renderWeekTable();
        this.updateDashboard();
        this.showSuccessMessage('Booking saved!');
    }

    async deleteBooking(bookingId) {
        if (!confirm('Delete this booking?')) return;
        await this.deleteBookingFromDB(bookingId);
        this.bookings = this.bookings.filter(b => b.id !== bookingId);
        if (!this.useSupabase) {
            localStorage.setItem('orange-contract-bookings', JSON.stringify(this.bookings));
        }
        this.renderBookings();
        this.renderWeekTable();
        this.updateDashboard();
        this.showSuccessMessage('Booking deleted.');
    }

    async toggleBookingUsed(bookingId) {
        const booking = this.bookings.find(b => b.id === bookingId);
        if (!booking) return;
        
        booking.used = !booking.used;
        
        if (this.useSupabase) {
            this.setSyncStatus('saving');
            const { error } = await this.db.from('bookings').update({ used: booking.used }).eq('id', bookingId);
            if (error) {
                console.error('Error updating booking used status:', error);
                this.setSyncStatus('offline');
                return;
            }
            this.setSyncStatus('connected');
        } else {
            localStorage.setItem('orange-contract-bookings', JSON.stringify(this.bookings));
        }
        
        this.renderBookings();
        this.renderWeekTable();
        this.updateDashboard();
    }

    formatDateUK(dateStr) {
        if (!dateStr) return '—';
        const parts = dateStr.split('-');
        if (parts.length === 3) {
            // YYYY-MM-DD to DD-MM-YYYY
            return `${parts[2]}-${parts[1]}-${parts[0]}`;
        }
        return dateStr;
    }

    renderBookings() {
        const container = document.getElementById('bookings-list');
        if (!container) return;
        const today = new Date().toISOString().split('T')[0];

        if (this.bookings.length === 0) {
            container.innerHTML = '<p class="empty-state">No bookings yet. Click "+ Add Booking" or use Import Email to add your first flight.</p>';
            return;
        }

        const renderItem = (b) => {
            const isToday = b.date === today;
            const isPast = b.date < today;
            return `
            <div class="booking-item ${isPast ? 'past' : ''} ${isToday ? 'today' : ''}">
                <div class="booking-main">
                    <span class="booking-flight">${b.flightNumber}</span>
                    <span class="booking-route">${b.route}</span>
                    <span class="booking-date">${this.formatDateUK(b.date)}</span>
                </div>
                <div class="booking-details">
                    ${b.departureTime ? `<span>✈ ${b.departureTime}${b.arrivalTime ? ' → ' + b.arrivalTime : ''}</span>` : ''}
                    ${b.bookingRef ? `<span>Ref: <strong>${b.bookingRef}</strong></span>` : ''}
                    ${b.seat ? `<span>Seat: <strong>${b.seat}</strong></span>` : ''}
                    ${b.notes ? `<span>${b.notes}</span>` : ''}
                    <span class="booking-price">${this.formatCurrency(b.pricePaid)}</span>
                </div>
                <div class="booking-actions">
                    <button onclick="app.showBookingForm(app.bookings.find(b=>b.id==='${b.id}'))">Edit</button>
                    <button class="delete-btn" onclick="app.deleteBooking('${b.id}')">Delete</button>
                </div>
            </div>`;
        };

        const current = this.bookings.filter(b => b.date >= today).sort((a, b) => new Date(a.date) - new Date(b.date));
        const previous = this.bookings.filter(b => b.date < today).sort((a, b) => new Date(b.date) - new Date(a.date));

        let html = '';
        if (current.length > 0) {
            html += current.map(b => renderItem(b)).join('');
        }
        if (previous.length > 0) {
            html += `<div class="previous-bookings-section"><h4>Previous Bookings</h4>${previous.map(b => renderItem(b)).join('')}</div>`;
        }
        container.innerHTML = html;
    }

    escapeFareWatchHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        })[character]);
    }

    showPlannedFlightForm(flight = null) {
        const form = document.getElementById('planned-flight-form');
        form.reset();
        document.getElementById('planned-flight-id').value = flight?.id || '';
        document.getElementById('planned-flight-form-title').textContent = flight ? 'Edit price watch' : 'Plan a flight';
        document.getElementById('planned-origin').value = flight?.origin || 'BRS';
        document.getElementById('planned-destination').value = flight?.destination || 'GLA';
        document.getElementById('planned-outbound-date').value = flight?.outbound_date || '';
        document.getElementById('planned-outbound-time').value = flight?.outbound_time?.slice(0, 5) || '';
        document.getElementById('planned-return-date').value = flight?.return_date || '';
        document.getElementById('planned-return-time').value = flight?.return_time?.slice(0, 5) || '';
        document.getElementById('planned-time-flex').value = String(flight?.time_flex_minutes || 90);
        document.getElementById('planned-target-price').value = flight?.target_price || '';
        document.getElementById('planned-direct-only').checked = flight ? flight.direct_only : true;

        const today = new Date().toISOString().split('T')[0];
        const oneYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const outboundDateInput = document.getElementById('planned-outbound-date');
        const returnDateInput = document.getElementById('planned-return-date');
        outboundDateInput.min = today;
        outboundDateInput.max = oneYear;
        returnDateInput.min = outboundDateInput.value || today;
        returnDateInput.max = oneYear;
        outboundDateInput.addEventListener('change', () => {
            returnDateInput.min = outboundDateInput.value || today;
            if (returnDateInput.value && returnDateInput.value < outboundDateInput.value) {
                returnDateInput.value = outboundDateInput.value;
            }
        }, { once: true });

        document.getElementById('planned-flight-form-container').classList.remove('hidden');
        document.getElementById('planned-flight-form-container').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    hidePlannedFlightForm() {
        document.getElementById('planned-flight-form-container').classList.add('hidden');
        document.getElementById('planned-flight-form').reset();
    }

    async handlePlannedFlightSubmit(event) {
        event.preventDefault();
        const id = document.getElementById('planned-flight-id').value;
        const origin = document.getElementById('planned-origin').value.trim().toUpperCase();
        const destination = document.getElementById('planned-destination').value.trim().toUpperCase();
        const outboundDate = document.getElementById('planned-outbound-date').value;
        const returnDate = document.getElementById('planned-return-date').value || null;
        const returnTime = document.getElementById('planned-return-time').value || null;
        if (origin === destination) return this.showErrorMessage('Origin and destination must be different.');
        if (Boolean(returnDate) !== Boolean(returnTime)) return this.showErrorMessage('Add both a return date and return time, or leave both blank.');
        if (returnDate && returnDate < outboundDate) return this.showErrorMessage('The return cannot be before the outbound flight.');

        const row = {
            origin,
            destination,
            outbound_date: outboundDate,
            outbound_time: document.getElementById('planned-outbound-time').value,
            return_date: returnDate,
            return_time: returnTime,
            time_flex_minutes: Number(document.getElementById('planned-time-flex').value),
            direct_only: document.getElementById('planned-direct-only').checked,
            target_price: Number(document.getElementById('planned-target-price').value) || null,
            status: 'tracking',
            updated_at: new Date().toISOString()
        };
        this.setSyncStatus('saving');
        const request = id
            ? this.db.from('planned_flights').update(row).eq('id', id).select().single()
            : this.db.from('planned_flights').insert(row).select().single();
        const { data, error } = await request;
        if (error) {
            console.error(error);
            this.setSyncStatus('offline');
            return this.showErrorMessage(`Could not save price watch: ${error.message}`);
        }
        this.hidePlannedFlightForm();
        await this.loadFareWatchData();
        this.setSyncStatus('connected');
        this.showSuccessMessage(id ? 'Price watch updated.' : 'Flight saved. Checking the first live fare now…');
        if (!id) {
            this.requestFareWatchNotificationPermission();
            await this.checkFarePrices(data.id);
        }
    }

    async handleFareWatchAction(event) {
        const button = event.target.closest('[data-fare-action]');
        if (!button) return;
        const flight = this.plannedFlights.find(item => item.id === button.dataset.flightId);
        if (!flight) return;
        const action = button.dataset.fareAction;
        if (action === 'edit') this.showPlannedFlightForm(flight);
        if (action === 'check') await this.checkFarePrices(flight.id, button);
        if (action === 'pause') await this.updatePlannedFlightStatus(flight.id, flight.status === 'paused' ? 'tracking' : 'paused');
        if (action === 'booked') await this.updatePlannedFlightStatus(flight.id, 'booked');
        if (action === 'delete') await this.deletePlannedFlight(flight.id);
    }

    async updatePlannedFlightStatus(id, status) {
        const { error } = await this.db.from('planned_flights').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
        if (error) return this.showErrorMessage(error.message);
        await this.loadFareWatchData();
        this.showSuccessMessage(status === 'booked' ? 'Marked as booked. Daily checks have stopped.' : status === 'paused' ? 'Price watch paused.' : 'Price watch resumed.');
    }

    async deletePlannedFlight(id) {
        if (!confirm('Delete this price watch and all of its price history?')) return;
        const { error } = await this.db.from('planned_flights').delete().eq('id', id);
        if (error) return this.showErrorMessage(error.message);
        await this.loadFareWatchData();
        this.showSuccessMessage('Price watch deleted.');
    }

    async checkFarePrices(flightId = null, button = null) {
        const trigger = button || document.getElementById('check-all-fares-btn');
        const originalText = trigger?.textContent;
        if (trigger) {
            trigger.classList.add('button-loading');
            trigger.textContent = 'Queuing live fare check…';
            trigger.disabled = true;
        }
        try {
            const { data, error } = await this.db.functions.invoke('monitor-flight-prices', { body: flightId ? { action: 'start', flightId } : { action: 'start' } });
            if (error) {
                let message = error.message;
                try {
                    const detail = await error.context?.json();
                    if (detail?.error) message = detail.error;
                } catch (_) {}
                throw new Error(message);
            }
            const started = (data?.started || []).filter((result) => result.ok !== false);
            const failures = (data?.started || []).filter((result) => result.ok === false);
            if (failures.length) this.showErrorMessage(failures.map((result) => result.error).join(' '));
            if (!started.length && !failures.length) {
                this.showSuccessMessage('No tracking flights need a fare check right now.');
                return;
            }
            if (started.length) {
                await this.pollFareWatch({ flightId, trigger, originalText });
            }
        } catch (error) {
            console.error('Fare check failed:', error);
            const status = document.getElementById('fare-watch-settings-status');
            if (status) {
                status.textContent = error.message;
                status.className = 'api-status-display error';
            }
            this.showErrorMessage(`Fare check failed: ${error.message}`);
            if (trigger) {
                trigger.classList.remove('button-loading');
                trigger.textContent = originalText;
                trigger.disabled = false;
            }
        }
    }

    async pollFareWatch({ flightId = null, trigger = null, originalText = null, maxAttempts = 30 } = {}) {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        let attempts = 0;
        let done = false;
        let message = '';

        while (attempts < maxAttempts && !done) {
            attempts++;
            if (trigger) trigger.textContent = `Checking easyJet (${attempts}/${maxAttempts})…`;
            await wait(15000);
            try {
                const { data, error } = await this.db.functions.invoke('monitor-flight-prices', { body: flightId ? { action: 'poll', flightId } : { action: 'poll' } });
                if (error) throw new Error(error.message);
                const processed = data?.processed || [];
                const stillPending = data?.stillPending || [];
                const successes = processed.filter((result) => result.ok);
                if (successes.length) {
                    await this.loadFareWatchData();
                    message = `${successes.length} fare ${successes.length === 1 ? 'watch' : 'watches'} updated.`;
                }
                if (flightId) {
                    const thisFlight = processed.find((result) => result.id === flightId);
                    if (thisFlight) {
                        if (!thisFlight.ok) this.showErrorMessage(thisFlight.error);
                        done = true;
                    } else if (!stillPending.some((result) => result.id === flightId)) {
                        done = true;
                    }
                } else {
                    done = stillPending.length === 0;
                }
            } catch (err) {
                console.error('Fare poll failed:', err);
                message = `Poll failed: ${err.message}`;
                done = true;
            }
        }

        if (!done && !message) message = 'EasyJet scrape is still running; results will refresh automatically.';
        if (message) this.showSuccessMessage(message);
        if (trigger) {
            trigger.classList.remove('button-loading');
            trigger.textContent = originalText;
            trigger.disabled = false;
        }
        await this.loadFareWatchData();
    }

    renderFareWatch() {
        const container = document.getElementById('planned-flights-list');
        if (!container) return;
        this.renderFareWatchAlerts();
        const tracked = this.plannedFlights.filter(flight => flight.status === 'tracking');
        document.getElementById('fare-stat-tracked').textContent = tracked.length;
        document.getElementById('fare-stat-book-now').textContent = tracked.filter(flight => flight.recommendation === 'book_now').length;
        const savings = tracked.map(flight => {
            const prices = (flight.flight_price_snapshots || []).map(snapshot => Number(snapshot.total_price));
            return prices.length && flight.latest_total_price ? Math.max(...prices) - Number(flight.latest_total_price) : 0;
        });
        const bestSaving = Math.max(0, ...savings);
        document.getElementById('fare-stat-saving').textContent = bestSaving > 0 ? this.formatCurrency(bestSaving) : '—';
        const checks = tracked.map(flight => flight.last_checked_at).filter(Boolean).sort().reverse();
        document.getElementById('fare-stat-last-scan').textContent = checks.length ? this.formatRelativeFareWatchTime(checks[0]) : 'Not yet';
        if (!this.plannedFlights.length) {
            container.innerHTML = '<div class="fare-watch-empty">No flights are being watched yet. Plan a trip to start building daily price intelligence.</div>';
            return;
        }
        const rank = { tracking: 0, paused: 1, booked: 2 };
        container.innerHTML = [...this.plannedFlights]
            .sort((a, b) => rank[a.status] - rank[b.status] || a.outbound_date.localeCompare(b.outbound_date))
            .map(flight => this.renderPlannedFlightCard(flight)).join('');
    }

    renderPlannedFlightCard(flight) {
        const safe = value => this.escapeFareWatchHtml(value);
        const recommendationClass = flight.status === 'paused' ? 'paused' : (flight.recommendation || 'watch').replaceAll('_', '-');
        const recommendationLabel = flight.status === 'booked' ? 'Booked' : flight.status === 'paused' ? 'Paused' : ({
            book_now: 'Book now', consider_booking: 'Consider booking', watch: 'Keep watching', unavailable: 'Fare unavailable', new: 'New watch'
        })[flight.recommendation] || 'New watch';
        const returnText = flight.return_date ? `<span>Return ${safe(this.formatDateUK(flight.return_date))} at ${safe(flight.return_time?.slice(0, 5))}</span>` : '<span>One way</span>';
        const fare = flight.latest_total_price ? this.formatCurrency(flight.latest_total_price) : 'Awaiting fare';
        const latestSnapshot = flight.flight_price_snapshots?.at(-1);
        const outTime = latestSnapshot?.outbound_actual_time ? safe(latestSnapshot.outbound_actual_time.slice(0, 5)) : safe(flight.outbound_time?.slice(0, 5));
        const retTime = latestSnapshot?.return_actual_time ? safe(latestSnapshot.return_actual_time.slice(0, 5)) : safe(flight.return_time?.slice(0, 5));
        const legs = flight.latest_total_price
            ? (flight.latest_return_price
                ? `Outbound ${outTime} · ${this.formatCurrency(flight.latest_outbound_price)} · Return ${retTime} · ${this.formatCurrency(flight.latest_return_price)}`
                : `Outbound ${outTime} · ${this.formatCurrency(flight.latest_outbound_price)}`)
            : safe(flight.last_error || 'Run the first live price check');
        const reasons = Array.isArray(flight.recommendation_reasons) ? flight.recommendation_reasons : [];
        const events = Array.isArray(flight.event_insights) ? flight.event_insights : [];
        const sources = Array.isArray(flight.event_sources) ? flight.event_sources : [];
        const bookingLink = latestSnapshot?.booking_url?.startsWith('https://')
            ? `<a class="settings-link-button" href="${safe(latestSnapshot.booking_url)}" target="_blank" rel="noopener">View on easyJet</a>` : '';
        return `<article class="planned-flight-card ${recommendationClass} ${safe(flight.status)}">
            <header class="planned-flight-card-header">
                <div>
                    <div class="planned-route">${safe(flight.origin)} <span>→</span> ${safe(flight.destination)}</div>
                    <div class="planned-flight-meta"><span>Out ${safe(this.formatDateUK(flight.outbound_date))} at ${safe(flight.outbound_time?.slice(0, 5))}</span>${returnText}<span>±${safe(flight.time_flex_minutes)} min</span></div>
                </div>
                <span class="recommendation-badge ${recommendationClass}">${recommendationLabel}</span>
            </header>
            <div class="planned-flight-card-body">
                <div class="fare-summary">
                    <span class="current-fare-label">Current total</span>
                    <strong class="current-fare">${fare}</strong>
                    <div class="fare-legs">${legs}</div>
                    <div class="fare-disclaimer">Prices from Apify easyJet scraper — may differ from live checkout.</div>
                    <div class="planned-flight-price-row"><span class="fare-trend ${safe(flight.trend)}">${this.fareTrendLabel(flight.trend)}</span>${flight.lowest_total_price ? `<span class="fare-legs">Low ${this.formatCurrency(flight.lowest_total_price)}</span>` : ''}</div>
                    <div class="recommendation-panel">
                        <strong>${safe(flight.recommendation_summary || 'Building your recommendation')}</strong>
                        <ul>${reasons.length ? reasons.map(reason => `<li>${safe(reason)}</li>`).join('') : '<li>Daily observations will reveal whether the fare is rising or falling.</li>'}</ul>
                    </div>
                </div>
                ${this.renderFarePriceChart(flight.flight_price_snapshots || [], flight.id)}
            </div>
            <details class="event-intelligence">
                <summary>Gemini demand intelligence · ${events.length} ${events.length === 1 ? 'factor' : 'factors'} found</summary>
                <div class="event-list">${events.length ? events.map(item => `<div class="event-item"><span class="event-risk ${safe(item.risk)}">${safe(item.risk || 'info')}</span><div><strong>${safe(item.name)}</strong> · ${safe(item.date)} · ${safe(item.location)}<br>${safe(item.impact)}</div></div>`).join('') : '<div class="fare-legs">No significant researched demand factors are stored yet. Gemini research runs when its server-side key is configured.</div>'}</div>
                ${sources.length ? `<div class="event-sources">Sources: ${sources.map(source => source.url?.startsWith('https://') ? `<a href="${safe(source.url)}" target="_blank" rel="noopener">${safe(source.title)}</a>` : '').join('')}</div>` : ''}
            </details>
            <footer class="planned-flight-card-footer">
                <span class="last-checked">${flight.last_checked_at ? `Checked ${safe(this.formatRelativeFareWatchTime(flight.last_checked_at))}` : 'Not checked yet'}${flight.target_price ? ` · Target ${this.formatCurrency(flight.target_price)}` : ''}</span>
                <div class="planned-flight-actions">
                    ${bookingLink}
                    ${flight.status !== 'booked' ? `<button data-fare-action="check" data-flight-id="${safe(flight.id)}">Check now</button><button data-fare-action="edit" data-flight-id="${safe(flight.id)}">Edit</button><button class="secondary-btn" data-fare-action="pause" data-flight-id="${safe(flight.id)}">${flight.status === 'paused' ? 'Resume' : 'Pause'}</button><button class="secondary-btn" data-fare-action="booked" data-flight-id="${safe(flight.id)}">Mark booked</button>` : ''}
                    <button class="danger" data-fare-action="delete" data-flight-id="${safe(flight.id)}">Delete</button>
                </div>
            </footer>
        </article>`;
    }

    renderFarePriceChart(snapshots, flightId) {
        if (!snapshots.length) return '<div class="price-chart-wrap"><div class="price-chart-heading"><span>Price history</span></div><div class="price-chart-empty">The first daily observation will appear here.</div></div>';
        const prices = snapshots.map(snapshot => Number(snapshot.total_price));
        const minimum = Math.min(...prices);
        const maximum = Math.max(...prices);
        const spread = Math.max(maximum - minimum, 10);
        const points = prices.map((price, index) => {
            const x = snapshots.length === 1 ? 50 : 4 + (index / (snapshots.length - 1)) * 92;
            const y = 112 - ((price - minimum) / spread) * 94;
            return { x, y, price, snapshot: snapshots[index] };
        });
        const path = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
        const areaPath = `${path} L ${points.at(-1).x.toFixed(1)} 124 L ${points[0].x.toFixed(1)} 124 Z`;
        const gradientId = `fare-gradient-${flightId.replaceAll('-', '')}`;
        const labels = `${this.formatDateUK(snapshots[0].observed_on)} → ${this.formatDateUK(snapshots.at(-1).observed_on)}`;
        return `<div class="price-chart-wrap">
            <div class="price-chart-heading"><span>Price history · ${snapshots.length} ${snapshots.length === 1 ? 'day' : 'days'}</span><span>${labels}</span></div>
            <svg class="price-chart" viewBox="0 0 100 128" preserveAspectRatio="none" role="img" aria-label="Fare price history from ${this.formatCurrency(prices[0])} to ${this.formatCurrency(prices.at(-1))}">
                <defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f5b800"/><stop offset="1" stop-color="#f5b800" stop-opacity="0"/></linearGradient></defs>
                <path class="price-chart-area" fill="url(#${gradientId})" d="${areaPath}"></path><path class="price-chart-line" d="${path}"></path>
                ${points.map(point => `<circle class="price-chart-dot" cx="${point.x}" cy="${point.y}" r="1.8"><title>${this.formatCurrency(point.price)} on ${this.formatDateUK(point.snapshot.observed_on)}</title></circle>`).join('')}
            </svg>
        </div>`;
    }

    fareTrendLabel(trend) {
        return ({ falling: '↓ Falling', rising: '↑ Rising', steady: '→ Steady', new: '• New watch' })[trend] || '• New watch';
    }

    formatRelativeFareWatchTime(value) {
        const date = new Date(value);
        const difference = Date.now() - date.getTime();
        if (difference < 60000) return 'just now';
        if (difference < 3600000) return `${Math.floor(difference / 60000)}m ago`;
        if (difference < 86400000) return `${Math.floor(difference / 3600000)}h ago`;
        return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    }

    renderFareWatchAlerts() {
        const container = document.getElementById('fare-watch-alerts');
        if (!container) return;
        container.innerHTML = this.fareWatchAlerts.map(alert => `<div class="fare-alert"><div><strong>${this.escapeFareWatchHtml(alert.title)}</strong><p>${this.escapeFareWatchHtml(alert.message)}</p></div><button type="button" data-alert-id="${this.escapeFareWatchHtml(alert.id)}" aria-label="Dismiss alert">×</button></div>`).join('');
    }

    async dismissFareWatchAlert(id) {
        const { error } = await this.db.from('flight_price_alerts').update({ is_read: true }).eq('id', id);
        if (error) return this.showErrorMessage(error.message);
        this.fareWatchAlerts = this.fareWatchAlerts.filter(alert => alert.id !== id);
        this.renderFareWatchAlerts();
    }

    async requestFareWatchNotificationPermission() {
        if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    }

    showFareWatchNotifications() {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        const shown = JSON.parse(localStorage.getItem('orange-contract-fare-alerts-shown') || '[]');
        const unseen = this.fareWatchAlerts.filter(alert => !shown.includes(alert.id));
        unseen.forEach(alert => new Notification(alert.title, { body: alert.message, tag: alert.id }));
        if (unseen.length) localStorage.setItem('orange-contract-fare-alerts-shown', JSON.stringify([...shown, ...unseen.map(alert => alert.id)].slice(-50)));
    }

    // ─── Gmail API ─────────────────────────────────────────────────────────────

    async initGmailState() {
        this.googleAccessToken = null;
        this.googleTokenClient = null;
        const clientId = await credentialManager.get('google-client-id');
        if (!clientId) {
            this.setGmailStatus('no-client', 'Add your Google Client ID in Settings first');
            return;
        }

        // If we have a previously saved token, validate it first
        const savedToken = await credentialManager.get('gmail-access-token');
        if (savedToken) {
            try {
                const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
                    headers: { Authorization: 'Bearer ' + savedToken }
                });
                if (resp.ok) {
                    this.googleAccessToken = savedToken;
                    this.setGmailStatus('connected', 'Connected to Gmail ✓');
                    document.getElementById('gmail-search-btn').disabled = false;
                    document.getElementById('gmail-parking-search-btn').disabled = false;
                    document.getElementById('gmail-connect-btn').classList.add('hidden');
                    document.getElementById('gmail-disconnect-btn').classList.remove('hidden');
                    return;
                } else if (resp.status === 401) {
                    await credentialManager.delete('gmail-access-token');
                    await credentialManager.delete('gmail-token-time');
                }
            } catch (e) {
                console.error('Gmail token validation failed:', e);
            }
        }

        // No valid saved token — try a silent reconnect
        this.setGmailStatus('ready', 'Reconnecting to Gmail…');
        this.tryAutoGmailConnect();
    }

    async saveGoogleClientId() {
        const clientId = document.getElementById('google-client-id').value.trim();
        if (!clientId || !clientId.includes('.apps.googleusercontent.com')) {
            this.showErrorMessage('Please enter a valid Google Client ID');
            return;
        }
        await this.saveSettingToDB('google-client-id', clientId);
        console.log('Saved Google Client ID to secure storage');
        
        // Verify it was saved
        const saved = await credentialManager.get('google-client-id');
        console.log('Verified saved Client ID:', saved ? 'Present' : 'Missing');
        
        const status = document.getElementById('google-settings-status');
        status.textContent = '✅ Client ID saved locally inside your browser sandbox.';
        status.className = 'api-status-display success';
        this.setGmailStatus('ready', 'Client ID saved — click Connect Gmail to sign in');
        this.showSuccessMessage('Google Client ID saved!');
    }

    async saveGeminiKey() {
        const key = document.getElementById('gemini-api-key').value.trim();
        if (!key) {
            this.showErrorMessage('Please enter a Gemini API Key');
            return;
        }
        await this.saveSettingToDB('gemini-api-key', key);
        const status = document.getElementById('gemini-settings-status');
        status.textContent = '✅ Gemini API Key saved locally.';
        status.className = 'api-status-display success';
        this.showSuccessMessage('Gemini API Key saved!');
    }

    async saveFreeAgentKey() {
        const token = document.getElementById('freeagent-token').value.trim();
        if (!token) {
            this.showErrorMessage('Please enter a FreeAgent Access Token');
            return;
        }
        await this.saveSettingToDB('freeagent-token', token);
        const status = document.getElementById('freeagent-settings-status');
        status.textContent = '✅ FreeAgent key saved locally.';
        status.className = 'api-status-display success';
        this.showSuccessMessage('FreeAgent Integration saved!');
    }

    async loadFreeAgentVisibility() {
        const value = await credentialManager.get('show-freeagent');
        this.applyFreeAgentVisibility(value === 'true');
    }

    async saveFreeAgentVisibility() {
        const checkbox = document.getElementById('show-freeagent-toggle');
        const show = checkbox ? checkbox.checked : false;
        await this.saveSettingToDB('show-freeagent', show ? 'true' : 'false');
        this.applyFreeAgentVisibility(show);
    }

    applyFreeAgentVisibility(show) {
        const navBtn = document.querySelector('[data-section="freeagent"]');
        const section = document.getElementById('freeagent-section');
        const checkbox = document.getElementById('show-freeagent-toggle');

        if (navBtn) navBtn.classList.toggle('hidden', !show);
        if (section) section.classList.toggle('hidden', !show);
        if (checkbox) checkbox.checked = show;

        if (!show && section && section.classList.contains('active')) {
            this.switchSection('dashboard');
        }
    }

    // ─── FreeAgent Integration ─────────────────────────────────────────────────────

    async fetchFreeAgentExpenses() {
        const token = await credentialManager.get('freeagent-token');
        if (!token) {
            this.showErrorMessage('Please enter your FreeAgent Access Token in Settings first');
            this.switchSection('settings');
            return;
        }

        const fromDate = document.getElementById('freeagent-from-date').value;
        const toDate = document.getElementById('freeagent-to-date').value;

        if (!fromDate || !toDate) {
            this.showErrorMessage('Please select a date range');
            return;
        }

        const loadingEl = document.getElementById('freeagent-loading');
        const listEl = document.getElementById('freeagent-expenses-list');
        
        loadingEl.classList.remove('hidden');
        listEl.innerHTML = '';

        try {
            // FreeAgent API endpoint for expenses
            const response = await fetch(`https://api.freeagent.com/v2/bank_transactions?from_date=${fromDate}&to_date=${toDate}`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`FreeAgent API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            const expenses = data.bank_transactions || [];

            // Load already linked expenses
            await this.loadLinkedFreeAgentExpenses();

            this.renderFreeAgentExpenses(expenses);
        } catch (error) {
            console.error('Error fetching FreeAgent expenses:', error);
            this.showErrorMessage(`Failed to fetch expenses: ${error.message}`);
            listEl.innerHTML = '<p class="empty-state">Failed to load expenses. Please check your API token and try again.</p>';
        } finally {
            loadingEl.classList.add('hidden');
        }
    }

    renderFreeAgentExpenses(expenses) {
        const listEl = document.getElementById('freeagent-expenses-list');
        
        if (!expenses || expenses.length === 0) {
            listEl.innerHTML = '<p class="empty-state">No expenses found in this date range.</p>';
            return;
        }

        listEl.innerHTML = '';

        expenses.forEach(expense => {
            const date = expense.dated_on || expense.date;
            const description = expense.description || expense.name || 'Unknown';
            const amount = Math.abs(parseFloat(expense.value || expense.amount || 0));
            const category = expense.category || expense.category_name || 'General';
            const expenseId = expense.url || expense.id || `${date}-${description}`;

            const isLinked = this.linkedFreeAgentExpenses.some(
                linked => linked.freeagent_expense_id === expenseId
            );

            const item = document.createElement('div');
            item.className = `freeagent-expense-item ${isLinked ? 'linked' : ''}`;
            item.innerHTML = `
                <input type="checkbox" 
                       class="freeagent-checkbox" 
                       data-expense-id="${expenseId}"
                       data-date="${date}"
                       data-description="${description}"
                       data-category="${category}"
                       data-amount="${amount}"
                       ${isLinked ? 'checked' : ''}
                       onchange="app.toggleFreeAgentExpense(this)">
                <div class="freeagent-expense-details">
                    <span class="freeagent-expense-date">${this.formatDateDisplay(date)}</span>
                    <span class="freeagent-expense-category">${category}</span>
                    <span class="freeagent-expense-description">${description}</span>
                    <span class="freeagent-expense-amount">£${amount.toFixed(2)}</span>
                </div>
            `;
            listEl.appendChild(item);
        });

        this.updateLinkedSummary();
    }

    formatDateDisplay(dateStr) {
        if (!dateStr) return '-';
        const date = new Date(dateStr);
        return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    async toggleFreeAgentExpense(checkbox) {
        const expenseId = checkbox.dataset.expenseId;
        const date = checkbox.dataset.date;
        const description = checkbox.dataset.description;
        const category = checkbox.dataset.category;
        const amount = parseFloat(checkbox.dataset.amount);

        const item = checkbox.closest('.freeagent-expense-item');

        if (checkbox.checked) {
            // Link the expense
            item.classList.add('linked');
            await this.linkFreeAgentExpense(expenseId, date, description, category, amount);
        } else {
            // Unlink the expense
            item.classList.remove('linked');
            await this.unlinkFreeAgentExpense(expenseId);
        }

        this.updateLinkedSummary();
    }

    async linkFreeAgentExpense(expenseId, date, description, category, amount) {
        if (this.useSupabase) {
            const { error } = await this.db.from('freeagent_linked_expenses').insert({
                freeagent_expense_id: expenseId,
                date: date,
                description: description,
                category: category,
                amount: amount,
                linked_date: new Date().toISOString().split('T')[0]
            });
            if (error) console.error('Error linking FreeAgent expense:', error);
        } else {
            this.linkedFreeAgentExpenses.push({
                freeagent_expense_id: expenseId,
                date: date,
                description: description,
                category: category,
                amount: amount,
                linked_date: new Date().toISOString().split('T')[0]
            });
            localStorage.setItem('freeagent-linked-expenses', JSON.stringify(this.linkedFreeAgentExpenses));
        }
    }

    async unlinkFreeAgentExpense(expenseId) {
        if (this.useSupabase) {
            const { error } = await this.db.from('freeagent_linked_expenses')
                .delete()
                .eq('freeagent_expense_id', expenseId);
            if (error) console.error('Error unlinking FreeAgent expense:', error);
        } else {
            this.linkedFreeAgentExpenses = this.linkedFreeAgentExpenses.filter(
                exp => exp.freeagent_expense_id !== expenseId
            );
            localStorage.setItem('freeagent-linked-expenses', JSON.stringify(this.linkedFreeAgentExpenses));
        }
    }

    async loadLinkedFreeAgentExpenses() {
        if (this.useSupabase) {
            const { data, error } = await this.db.from('freeagent_linked_expenses').select('*');
            if (error) {
                console.error('Error loading linked FreeAgent expenses:', error);
                this.linkedFreeAgentExpenses = [];
            } else {
                this.linkedFreeAgentExpenses = data || [];
            }
        } else {
            this.linkedFreeAgentExpenses = JSON.parse(
                localStorage.getItem('freeagent-linked-expenses') || '[]'
            );
        }
    }

    updateLinkedSummary() {
        const summaryEl = document.getElementById('freeagent-linked-summary');
        const totalEl = document.getElementById('freeagent-linked-total');

        if (this.linkedFreeAgentExpenses.length === 0) {
            summaryEl.classList.add('hidden');
            return;
        }

        const total = this.linkedFreeAgentExpenses.reduce(
            (sum, exp) => sum + (parseFloat(exp.amount) || 0),
            0
        );

        totalEl.textContent = `Total linked: £${total.toFixed(2)} (${this.linkedFreeAgentExpenses.length} expenses)`;
        summaryEl.classList.remove('hidden');
    }

    initializeFreeAgentDateRange() {
        const today = new Date();
        const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        
        document.getElementById('freeagent-from-date').value = this.formatDate(firstDayOfMonth);
        document.getElementById('freeagent-to-date').value = this.formatDate(today);
    }

    saveLocations() {
        const locationsText = document.getElementById('locations-list').value.trim();
        const locations = locationsText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (locations.length === 0) {
            this.showErrorMessage('Please enter at least one location');
            return;
        }
        this.locations = locations;
        localStorage.setItem('orange-contract-locations', JSON.stringify(locations));
        const status = document.getElementById('locations-settings-status');
        status.textContent = '✅ Locations saved locally.';
        status.className = 'api-status-display success';
        this.populateLocationDropdown();
        this.showSuccessMessage('Locations saved!');
    }

    async exportCredentials() {
        try {
            const backup = await credentialManager.exportBackup();
            const blob = new Blob([backup], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `orange-contract-credentials-${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            const status = document.getElementById('credential-backup-status');
            status.textContent = '✅ Credentials exported successfully!';
            status.className = 'api-status-display success';
            this.showSuccessMessage('Credentials exported!');
        } catch (e) {
            console.error('Export failed:', e);
            const status = document.getElementById('credential-backup-status');
            status.textContent = '❌ Export failed: ' + e.message;
            status.className = 'api-status-display error';
            this.showErrorMessage('Export failed: ' + e.message);
        }
    }

    importCredentials() {
        document.getElementById('credential-file-input').click();
    }

    async handleCredentialFile(event) {
        const file = event.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const count = await credentialManager.importBackup(text);
            
            const status = document.getElementById('credential-backup-status');
            status.textContent = `✅ Restored ${count} credentials successfully!`;
            status.className = 'api-status-display success';
            this.showSuccessMessage(`Restored ${count} credentials!`);
            
            // Refresh the form fields
            const savedUrl = await credentialManager.get('sb-url');
            const savedKey = await credentialManager.get('sb-key');
            const savedClientId = await credentialManager.get('google-client-id');
            const savedGeminiKey = await credentialManager.get('gemini-api-key');
            const savedFreeAgentToken = await credentialManager.get('freeagent-token');

            if (savedUrl) document.getElementById('supabase-url').value = savedUrl;
            if (savedKey) document.getElementById('supabase-key').value = savedKey;
            if (savedClientId) document.getElementById('google-client-id').value = savedClientId;
            if (savedGeminiKey) document.getElementById('gemini-api-key').value = savedGeminiKey;
            if (savedFreeAgentToken) document.getElementById('freeagent-token').value = savedFreeAgentToken;
            
            // Reinitialize services with new credentials
            await this.initSupabase();
            await this.initGmailState();
        } catch (e) {
            console.error('Import failed:', e);
            const status = document.getElementById('credential-backup-status');
            status.textContent = '❌ Import failed: ' + e.message;
            status.className = 'api-status-display error';
            this.showErrorMessage('Import failed: ' + e.message);
        }
        
        // Reset file input
        event.target.value = '';
    }

    loadLocations() {
        const saved = localStorage.getItem('orange-contract-locations');
        if (saved) {
            try {
                this.locations = JSON.parse(saved);
            } catch (e) {
                console.warn('Failed to load locations, using defaults');
            }
        }
        // Pre-fill the textarea
        const textarea = document.getElementById('locations-list');
        if (textarea) {
            textarea.value = this.locations.join('\n');
        }
    }

    populateLocationDropdown() {
        const select = document.getElementById('location');
        if (!select) return;
        select.innerHTML = '<option value="">Select location...</option>';
        this.locations.forEach(loc => {
            const option = document.createElement('option');
            option.value = loc;
            option.textContent = loc;
            select.appendChild(option);
        });
    }

    installPWA() {
        if (!this.deferredInstallPrompt) return;
        this.deferredInstallPrompt.prompt();
        this.deferredInstallPrompt.userChoice.then((choiceResult) => {
            if (choiceResult.outcome === 'accepted') {
                console.log('User accepted the PWA install prompt');
                const installBtn = document.getElementById('pwa-install-btn');
                if (installBtn) installBtn.style.display = 'none';
            }
            this.deferredInstallPrompt = null;
        });
    }

    async connectGmail({ auto = false } = {}) {
        const clientId = await credentialManager.get('google-client-id');
        console.log('connectGmail - Retrieved Client ID:', clientId ? 'Present' : 'Missing');
        if (!clientId) {
            if (!auto) {
                this.showErrorMessage('Please save a Google Client ID in Settings first');
                this.switchSection('settings');
            }
            return;
        }
        if (typeof google === 'undefined' || !google.accounts) {
            if (!auto) {
                this.showErrorMessage('Google Identity Services not loaded yet — try refreshing the page');
            }
            return;
        }
        if (this.googleAccessToken) return; // already connected

        this.googleTokenClient = google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: 'https://www.googleapis.com/auth/gmail.readonly',
            callback: (response) => {
                if (response.error) {
                    if (auto) {
                        console.warn('Auto Gmail reconnect failed:', response.error);
                        this.setGmailStatus('ready', 'Client ID saved — click Connect Gmail to sign in');
                    } else {
                        this.setGmailStatus('error', 'Connection failed: ' + response.error);
                    }
                    return;
                }
                this.googleAccessToken = response.access_token;
                credentialManager.set('gmail-access-token', response.access_token);
                credentialManager.set('gmail-token-time', Date.now().toString());
                this.setGmailStatus('connected', 'Connected to Gmail ✓');
                document.getElementById('gmail-search-btn').disabled = false;
                document.getElementById('gmail-parking-search-btn').disabled = false;
                document.getElementById('gmail-connect-btn').classList.add('hidden');
                document.getElementById('gmail-disconnect-btn').classList.remove('hidden');
                if (!auto) this.showSuccessMessage('Gmail connected!');
            }
        });

        if (auto) {
            this.googleTokenClient.requestAccessToken({ prompt: 'none' });
        } else {
            this.googleTokenClient.requestAccessToken();
        }
    }

    disconnectGmail() {
        if (this.googleAccessToken) {
            google.accounts.oauth2.revoke(this.googleAccessToken, () => {});
        }
        this.googleAccessToken = null;
        this.googleTokenClient = null;
        credentialManager.delete('gmail-access-token');
        credentialManager.delete('gmail-token-time');
        document.getElementById('gmail-search-btn').disabled = true;
        document.getElementById('gmail-parking-search-btn').disabled = true;
        document.getElementById('gmail-connect-btn').classList.remove('hidden');
        document.getElementById('gmail-disconnect-btn').classList.add('hidden');
        document.getElementById('gmail-results').classList.add('hidden');
        this.setGmailStatus('ready', 'Disconnected from Gmail');
    }

    tryAutoGmailConnect() {
        const attempt = () => {
            if (typeof google !== 'undefined' && google.accounts) {
                this.connectGmail({ auto: true });
                return true;
            }
            return false;
        };

        if (attempt()) return;

        let attempts = 0;
        const maxAttempts = 30; // wait up to 30 seconds for Google GIS to load
        const interval = setInterval(() => {
            attempts++;
            if (attempt() || attempts >= maxAttempts) {
                clearInterval(interval);
                if (attempts >= maxAttempts && !this.googleAccessToken) {
                    this.setGmailStatus('ready', 'Client ID saved — click Connect Gmail to sign in');
                }
            }
        }, 1000);
    }

    setGmailStatus(state, text) {
        const statusEl = document.getElementById('gmail-status-text');
        const dotEl = document.querySelector('.gmail-dot');
        if (!statusEl || !dotEl) return;
        statusEl.textContent = text;
        dotEl.className = 'gmail-dot ' + state;
    }

    async searchGmailBookings() {
        if (!this.googleAccessToken) {
            this.showErrorMessage('Please connect to Gmail first');
            return;
        }
        this._lastSearchExtracted = false;
        const resultsDiv = document.getElementById('gmail-results');
        resultsDiv.classList.remove('hidden');
        resultsDiv.innerHTML = '<div class="gmail-loading">🔍 Searching your Gmail for flight booking confirmations...</div>';

        const debugOutput = document.getElementById('debug-log-output');
        let debugLogs = [];
        const logDebug = (msg) => {
            console.log('[DEBUG CONSOLE]', msg);
            debugLogs.push("[" + new Date().toLocaleTimeString() + "] " + msg);
            if (debugOutput) {
                debugOutput.innerText = debugLogs.join('\n');
            }
        };

        logDebug('Starting Gmail scanning process...');
        logDebug('Search query: easyJet and Loganair booking filters (last 20 days)');

        try {
            const query = encodeURIComponent('from:confirmation@easyjet.com OR from:donotreply@easyjet.com OR from:bookings@easyjet.com OR from:noreply@easyjet.com OR from:noreply@loganair.co.uk OR subject:"easyJet" booking OR subject:"Loganair" booking newer_than:20d');
            const listUrl = "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=" + query + "&maxResults=25";

            logDebug("Requesting list API: users/me/messages?q=...");

            const listResp = await fetch(listUrl, {
                headers: { Authorization: "Bearer " + this.googleAccessToken }
            });

            logDebug("Gmail list status: " + listResp.status + " " + listResp.statusText);

            if (listResp.status === 401) {
                this.googleAccessToken = null;
                this.disconnectGmail();
                this.showErrorMessage('Gmail session expired — please reconnect');
                resultsDiv.innerHTML = '';
                logDebug('ERROR: 401 Unauthorized access token.');
                return;
            }

            if (!listResp.ok) {
                throw new Error("Gmail API returned status " + listResp.status);
            }

            const listData = await listResp.json();
            const messages = listData.messages || [];
            logDebug("Found " + messages.length + " raw matching email records in mailbox.");

            if (messages.length === 0) {
                resultsDiv.innerHTML = '<div class="gmail-empty">No matching flight booking emails found in your Gmail account.</div>';
                logDebug('Exit: 0 matching messages in Gmail query.');
                return;
            }

            logDebug("Discovered " + messages.length + " email candidate(s). Fetching detail payloads...");
            resultsDiv.innerHTML = '<div class="gmail-loading">Found ' + messages.length + ' email(s) — reading details...</div>';

            const emailPromises = messages.slice(0, 15).map(msg =>
                this.fetchGmailMessage(msg.id).catch(err => {
                    logDebug("Failed fetching email detail ID " + msg.id + ": " + err.message);
                    return null;
                })
            );
            const emails = await Promise.all(emailPromises);
            logDebug("Downloaded payloads for " + emails.filter(Boolean).length + " emails successfully.");

            const found = [];
            const geminiKey = await credentialManager.get('gemini-api-key');
            logDebug("Gemini AI API Key check: " + (geminiKey ? 'Present (Using AI Parser)' : 'Missing (Using legacy local engine)'));

            for (let index = 0; index < emails.length; index++) {
                const email = emails[index];
                if (!email) continue;

                const subject = this.getEmailHeader(email, 'Subject');
                const body = this.decodeEmailBody(email.payload);
                if (!body) {
                    logDebug("Skipping empty payload/unreadable body. Subject: " + subject);
                    continue;
                }

                logDebug("----------------------------------------");
                logDebug("Processing email subject: " + subject);

                const lowerBody = body.toLowerCase();
                const lowerSubject = subject.toLowerCase();
                if (lowerSubject.includes('invoice') || lowerSubject.includes('vat') || 
                    lowerBody.includes('vat invoice') || lowerBody.includes('requested vat invoice')) {
                    logDebug("BYPASSED INVOICE: Subject " + subject + " matches invoice/receipt criteria. Ignored.");
                    continue;
                }

                const { bookingRef, date: bookingDate } = this.extractBookingRefAndDate(subject, body);
                logDebug("Extracted from email - Booking Ref: " + (bookingRef || 'NOT FOUND') + ", Booking Date: " + (bookingDate || 'NOT FOUND'));
                
                if (bookingRef && bookingDate) {
                    const isDuplicate = await this.isBookingSkippedOrDuplicate(bookingRef, bookingDate);
                    if (isDuplicate) {
                        logDebug("SKIPPED DUPLICATE: Booking ref " + bookingRef + " on booking date " + bookingDate + " already exists or was skipped. Skipping Gemini API call.");
                        continue;
                    }
                } else {
                    logDebug("Could not extract both booking ref and booking date, proceeding to Gemini API anyway.");
                }

                this._currentBookingDate = bookingDate;
                logDebug("Set _currentBookingDate to: " + this._currentBookingDate);

                let parsedList = [];

                if (geminiKey) {
                    try {
                        logDebug("Sending email to Gemini AI for intelligent flight segment extraction...");
                        const prompt = `You are a strict travel data extractor. Read the travel booking email text provided. Extract ALL booking segments.

COMPULSORY FIELD RULES:
1. "route" Formatting: This field must ONLY contain "City1 → City2".
   - "City1" and "City2" MUST be the single-word city names (e.g., "Bristol", "Glasgow", "Malta", "London").
   - Under no circumstances can this field contain words like "Flex", "Pass", "EZY", flight numbers, airline names, check-in information, passenger names, or anything else.
   - It must strictly match this exact regex shape: ^[A-Za-z]+ → [A-Za-z]+\$
   - Example correct values: "Bristol → Glasgow", "Bristol → Malta", "Glasgow → Bristol".
2. "seat": Extract ONLY the passenger's seat assignment alphanumeric code (e.g. "27A", "7C"). If not found, leave as empty string. Do not include passenger names or headings.
3. "notes": Put indicators about Flex Passes or baggage rules here (e.g. "Flex Pass not used"). Keep this completely separated from "route".

Return ONLY a valid JSON array of objects (no markdown, no backticks, no wrap, just raw JSON text) with this exact schema:
[
  {
    "flightNumber": "flight number (e.g. EZY201)",
    "route": "Origin → Destination (e.g. Bristol → Glasgow)",
    "date": "departure date in YYYY-MM-DD format",
    "departureTime": "departure time in HH:MM format",
    "arrivalTime": "arrival time in HH:MM format",
    "pricePaid": number,
    "bookingRef": "booking reference (e.g. KCRCW6Z)",
    "seat": "alphanumeric seat code (e.g. 27A)",
    "notes": "Flex Pass status and details"
  }
]

Email text:
${body}`;

                        const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json',
                                'X-goog-api-key': geminiKey 
                            },
                            body: JSON.stringify({
                                contents: [{ parts: [{ text: prompt }] }]
                            })
                        });

                        if (response.ok) {
                            const data = await response.json();
                            const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
                            if (textResponse) {
                                const cleanJson = textResponse.replace(/\```json/g, '').replace(/\```/g, '').trim();
                                const parsed = JSON.parse(cleanJson);
                                if (Array.isArray(parsed)) {
                                    logDebug("Gemini successfully extracted " + parsed.length + " raw segment(s).");
                                    // If multiple flights, divide total cost by number of flights
                                    const flightCount = parsed.length;
                                    parsedList = parsed.map(b => {
                                        const price = parseFloat(b.pricePaid || b.price_paid || b.cost) || 0;
                                        const dividedPrice = flightCount > 1 ? price / flightCount : price;
                                        return {
                                            flightNumber: b.flightNumber || b.flight_number || b.reference || 'Booking',
                                            route: this.cleanRoute(b.route || b.location || 'Location'),
                                            date: b.date || '',
                                            departureTime: b.departureTime || b.departure_time || '',
                                            arrivalTime: b.arrivalTime || b.arrival_time || '',
                                            pricePaid: dividedPrice,
                                            bookingRef: b.bookingRef || b.booking_ref || '',
                                            seat: b.seat || b.Seat || b.seatNumber || b.seat_number || '',
                                            notes: b.notes || ''
                                        };
                                    });
                                }
                            }
                        } else {
                            logDebug("Gemini responded with HTTP Error " + response.status);
                        }
                    } catch (e) {
                        logDebug("Gemini extraction failed: " + e.message);
                    }
                }

                if (parsedList.length === 0) {
                    logDebug('Using standard local regex parsing engine fallback...');
                    
                    // Try easyjet parser first
                    logDebug('Running easyjet-specific parser...');
                    const easyjetDetails = this.extractEasyjetDetails(body);
                    if (Array.isArray(easyjetDetails)) {
                        const flightCount = easyjetDetails.length;
                        easyjetDetails.forEach(details => {
                            if (details.flightNumber || details.bookingRef) {
                                const price = details.cost ? parseFloat(details.cost) : 0;
                                const dividedPrice = flightCount > 1 ? price / flightCount : price;
                                parsedList.push({
                                    flightNumber: details.flightNumber || '',
                                    route: (details.departure && details.arrival) ? details.departure + " → " + details.arrival : '',
                                    date: details.date || '',
                                    departureTime: details.departureTime || '',
                                    arrivalTime: details.arrivalTime || '',
                                    pricePaid: dividedPrice,
                                    bookingRef: details.bookingRef || '',
                                    seat: details.seat || '',
                                    notes: details.notes || ''
                                });
                            }
                        });
                    } else if (easyjetDetails.flightNumber || easyjetDetails.bookingRef) {
                        parsedList.push({
                            flightNumber: easyjetDetails.flightNumber || '',
                            route: (easyjetDetails.departure && easyjetDetails.arrival) ? easyjetDetails.departure + " → " + easyjetDetails.arrival : '',
                            date: easyjetDetails.date || '',
                            departureTime: easyjetDetails.departureTime || '',
                            arrivalTime: easyjetDetails.arrivalTime || '',
                            pricePaid: easyjetDetails.cost ? parseFloat(easyjetDetails.cost) : 0,
                            bookingRef: easyjetDetails.bookingRef || '',
                            seat: easyjetDetails.seat || '',
                            notes: easyjetDetails.notes || ''
                        });
                    }
                    
                    // Then try loganair parser
                    logDebug('Running loganair-specific parser...');
                    const loganairDetails = this.extractLoganairDetails(body);
                    if (Array.isArray(loganairDetails)) {
                        const flightCount = loganairDetails.length;
                        loganairDetails.forEach(details => {
                            if (details.flightNumber || details.bookingRef) {
                                const price = details.cost ? parseFloat(details.cost) : 0;
                                const dividedPrice = flightCount > 1 ? price / flightCount : price;
                                parsedList.push({
                                    flightNumber: details.flightNumber || '',
                                    route: (details.departure && details.arrival) ? details.departure + " → " + details.arrival : '',
                                    date: details.date || '',
                                    departureTime: details.departureTime || '',
                                    arrivalTime: details.arrivalTime || '',
                                    pricePaid: dividedPrice,
                                    bookingRef: details.bookingRef || '',
                                    seat: details.seat || '',
                                    notes: details.notes || ''
                                });
                            }
                        });
                    } else if (loganairDetails.flightNumber || loganairDetails.bookingRef) {
                        parsedList.push({
                            flightNumber: loganairDetails.flightNumber || '',
                            route: (loganairDetails.departure && loganairDetails.arrival) ? loganairDetails.departure + " → " + loganairDetails.arrival : '',
                            date: loganairDetails.date || '',
                            departureTime: loganairDetails.departureTime || '',
                            arrivalTime: loganairDetails.arrivalTime || '',
                            pricePaid: loganairDetails.cost ? parseFloat(loganairDetails.cost) : 0,
                            bookingRef: loganairDetails.bookingRef || '',
                            seat: loganairDetails.seat || '',
                            notes: loganairDetails.notes || ''
                        });
                    }
                }

                this._lastSearchExtracted = this._lastSearchExtracted || parsedList.length > 0;
                parsedList.forEach(b => {
                    const bookingRef = b.bookingRef;
                    const date = b.date;

                    logDebug("-> Discovered: Flight " + b.flightNumber + " | Route: " + b.route + " | Date: " + date + " | Seat: " + (b.seat || 'None') + " | Price: £" + b.pricePaid + " | Ref: " + bookingRef);

                    if (!date || !b.route || b.route === 'Location') {
                        logDebug("   [SKIPPED] Missing travel date or route. Invalid segment.");
                        return;
                    }

                    if (!b.seat) {
                        const rawSeatMatch = body.match(/Seat:\s*([0-9]{1,2}[A-K])\b/i) || 
                                             body.match(/Seat\s+([0-9]{1,2}[A-K])\b/i) ||
                                             body.match(/\b([0-9]{1,2}[A-K])\s+Small cabin bag/i);
                        if (rawSeatMatch) {
                            b.seat = rawSeatMatch[1].toUpperCase();
                            logDebug("   [SEAT RESTORED] Fallback regex detected seat: " + b.seat);
                        }
                    }

                    const isAlwaysSkipped = this.skippedBookings?.some(
                        sb => sb.bookingRef === bookingRef && sb.date === date
                    );
                    if (isAlwaysSkipped) {
                        logDebug("   [SKIPPED] Matching blocklisted item (Always Skip Ref: " + bookingRef + ", Date: " + date + ").");
                        return;
                    }

                    const isDuplicate = this.bookings?.some(
                        ab => ab.bookingRef === bookingRef && ab.date === date
                    );
                    if (isDuplicate) {
                        logDebug("   [SKIPPED] Matching duplicate active booking (already imported: Ref: " + bookingRef + ", Date: " + date + ").");
                        return;
                    }

                    logDebug("   [KEPT] Added segment to import suggestion list.");
                    found.push({
                        details: b,
                        subject,
                        date: this.getEmailHeader(email, 'Date')
                    });
                });
            }

            logDebug("----------------------------------------");
            logDebug("Process Complete! Total suggested imports displayed: " + found.length);
            this.renderGmailResults(found);

        } catch (err) {
            logDebug("FATAL CRASH ERROR: " + err.message);
            console.error('Full Gmail search catch handler error:', err);
            resultsDiv.innerHTML = '<div class="gmail-empty">Search process encountered an error: ' + err.message + '</div>';
        }
    }

    async searchGmailParkingBookings() {
        if (!this.googleAccessToken) {
            this.showErrorMessage('Please connect to Gmail first');
            return;
        }
        this._lastSearchExtracted = false;
        const resultsDiv = document.getElementById('gmail-results');
        resultsDiv.classList.remove('hidden');
        resultsDiv.innerHTML = '<div class="gmail-loading">🔍 Searching your Gmail for parking booking confirmations...</div>';

        const debugOutput = document.getElementById('debug-log-output');
        let debugLogs = [];
        const logDebug = (msg) => {
            console.log('[DEBUG CONSOLE]', msg);
            debugLogs.push("[" + new Date().toLocaleTimeString() + "] " + msg);
            if (debugOutput) {
                debugOutput.innerText = debugLogs.join('\n');
            }
        };

        logDebug('Starting Gmail parking scanning process...');
        logDebug('Search query: parking booking filters (last 20 days)');

        try {
            const query = encodeURIComponent('from:no-reply@bristolairport.com OR subject:"parking" booking OR subject:"car park" booking newer_than:20d');
            const listUrl = "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=" + query + "&maxResults=25";

            logDebug("Requesting list API: users/me/messages?q=...");

            const listResp = await fetch(listUrl, {
                headers: { Authorization: "Bearer " + this.googleAccessToken }
            });

            logDebug("Gmail list status: " + listResp.status + " " + listResp.statusText);

            if (listResp.status === 401) {
                this.googleAccessToken = null;
                this.disconnectGmail();
                this.showErrorMessage('Gmail session expired — please reconnect');
                resultsDiv.innerHTML = '';
                logDebug('ERROR: 401 Unauthorized access token.');
                return;
            }

            if (!listResp.ok) {
                throw new Error("Gmail API returned status " + listResp.status);
            }

            const listData = await listResp.json();
            const messages = listData.messages || [];
            logDebug("Found " + messages.length + " raw matching email records in mailbox.");

            if (messages.length === 0) {
                resultsDiv.innerHTML = '<div class="gmail-empty">No matching parking booking emails found in your Gmail account.</div>';
                logDebug('Exit: 0 matching messages in Gmail query.');
                return;
            }

            logDebug("Discovered " + messages.length + " email candidate(s). Fetching detail payloads...");
            resultsDiv.innerHTML = '<div class="gmail-loading">Found ' + messages.length + ' email(s) — reading details...</div>';

            const emailPromises = messages.slice(0, 15).map(msg =>
                this.fetchGmailMessage(msg.id).catch(err => {
                    logDebug("Failed fetching email detail ID " + msg.id + ": " + err.message);
                    return null;
                })
            );
            const emails = await Promise.all(emailPromises);
            logDebug("Downloaded payloads for " + emails.filter(Boolean).length + " emails successfully.");

            const found = [];
            const geminiKey = await credentialManager.get('gemini-api-key');
            logDebug("Gemini AI API Key check: " + (geminiKey ? 'Present (Using AI Parser)' : 'Missing (Using legacy local engine)'));

            for (let index = 0; index < emails.length; index++) {
                const email = emails[index];
                if (!email) continue;

                const subject = this.getEmailHeader(email, 'Subject');
                const body = this.decodeEmailBody(email.payload);
                logDebug("Processing email subject: " + subject);

                // Extract booking date from email date header
                const emailDate = this.getEmailHeader(email, 'Date');
                const bookingDate = this.parseEmailDateToISO(emailDate);
                this._currentBookingDate = bookingDate;
                logDebug("Extracted booking date from email: " + bookingDate);

                // Extract parking booking ref from subject for duplicate check
                const bookingRef = this.extractParkingRefFromSubject(subject);
                logDebug("Extracted from email - Parking Ref: " + (bookingRef || 'NOT FOUND'));

                if (bookingRef && this.isParkingSkipped(bookingRef)) {
                    logDebug("SKIPPED BLOCKLIST: Parking ref " + bookingRef + " is on the always-skip list. Skipping Gemini API call.");
                    continue;
                }

                const lowerBody = body.toLowerCase();
                const lowerSubject = subject.toLowerCase();
                if (lowerSubject.includes('invoice') || lowerSubject.includes('vat') || 
                    lowerBody.includes('vat invoice') || lowerBody.includes('requested vat invoice')) {
                    logDebug("BYPASSED INVOICE: Subject " + subject + " matches invoice/receipt criteria. Ignored.");
                    continue;
                }

                if (geminiKey) {
                    try {
                        logDebug("Sending email to Gemini AI for parking extraction...");
                        const prompt = `You are a strict parking booking data extractor. Read the parking booking email text provided. Extract parking booking details.

COMPULSORY FIELD RULES:
1. "carParkName": Extract the car park name (e.g., "Silver Zone", "Long Stay", "Meet and Greet").
2. "arrivalDate": Extract arrival date in YYYY-MM-DD format.
3. "arrivalTime": Extract arrival time in HH:MM format.
4. "returnDate": Extract return date in YYYY-MM-DD format.
5. "returnTime": Extract return time in HH:MM format.
6. "pricePaid": Extract the total price paid as a number.
7. "bookingRef": Extract the booking reference code.
8. "carRegistration": Extract the car registration number if present.
9. "bookingStatus": Determine the booking status from the email. Must be one of: "Booking" (new confirmation), "Amendment" (changed booking), or "Cancellation" (cancelled booking). Default to "Booking" if not clear.

Return ONLY a valid JSON object (no markdown, no backticks, no wrap, just raw JSON text) with this exact schema:
{
    "carParkName": "car park name",
    "arrivalDate": "YYYY-MM-DD",
    "arrivalTime": "HH:MM",
    "returnDate": "YYYY-MM-DD",
    "returnTime": "HH:MM",
    "pricePaid": number,
    "bookingRef": "booking reference",
    "carRegistration": "car registration if present",
    "bookingStatus": "Booking" | "Amendment" | "Cancellation"
}`;

                        const geminiResp = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json',
                                'X-goog-api-key': geminiKey 
                            },
                            body: JSON.stringify({
                                contents: [{ parts: [{ text: prompt + "\n\nEMAIL TEXT:\n" + body }] }]
                            })
                        });

                        if (!geminiResp.ok) {
                            logDebug("Gemini API error: " + geminiResp.status);
                            continue;
                        }

                        const geminiData = await geminiResp.json();
                        const geminiText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
                        
                        const jsonMatch = geminiText.match(/\{[\s\S]*\}/);
                        if (!jsonMatch) {
                            logDebug("Gemini response did not contain valid JSON");
                            continue;
                        }

                        const parkingDetails = JSON.parse(jsonMatch[0]);
                        this._lastSearchExtracted = true;
                        logDebug("Gemini successfully extracted parking booking.");

                        // Add booking date to details for the import form
                        parkingDetails.bookingDate = this._currentBookingDate;

                        // Skip if already imported or on the always-skip list
                        const isDuplicateOrSkipped = await this.isParkingDuplicate(parkingDetails);
                        if (isDuplicateOrSkipped) {
                            logDebug("SKIPPED BLOCKED/DUPLICATE: Parking booking already imported or on blocklist.");
                            continue;
                        }

                        found.push({
                            details: parkingDetails,
                            subject,
                            date: this.getEmailHeader(email, 'Date')
                        });
                    } catch (e) {
                        logDebug("Gemini extraction failed: " + e.message);
                    }
                }
            }

            logDebug("----------------------------------------");
            logDebug("Process Complete! Total suggested imports displayed: " + found.length);
            this.renderGmailParkingResults(found);

        } catch (err) {
            logDebug("FATAL CRASH ERROR: " + err.message);
            console.error('Full Gmail parking search catch handler error:', err);
            resultsDiv.innerHTML = '<div class="gmail-empty">Search process encountered an error: ' + err.message + '</div>';
        }
    }

    renderGmailParkingResults(found) {
        const resultsDiv = document.getElementById('gmail-results');
        if (found.length === 0) {
            const message = this._lastSearchExtracted
                ? 'Found emails but couldn\'t find anything new.'
                : 'Found emails but couldn\'t extract parking booking details. Try the manual paste option below.';
            resultsDiv.innerHTML = `<div class="gmail-empty">${message}</div>`;
            return;
        }
        
        // Sort by arrival date (earliest first)
        const sortedFound = [...found].sort((a, b) => new Date(a.details.arrivalDate) - new Date(b.details.arrivalDate));
        
        resultsDiv.innerHTML = `
            <h4>Found ${found.length} parking booking(s) in Gmail</h4>
            <p class="gmail-hint">Review each booking and click Import to add it.</p>
            ${sortedFound.map((item, i) => {
                const d = item.details;
                const isSkipped = this.isParkingSkipped(d.bookingRef);
                const isDuplicate = !isSkipped && this.parkingBookings.some(p => this.matchesParkingKey(p, d));
                const alreadyHandled = isDuplicate || isSkipped;
                const greyedStyle = alreadyHandled ? 'opacity: 0.5; background: #f0f0f0;' : '';
                const disabledAttr = alreadyHandled ? 'disabled' : '';
                const importBtnText = isSkipped ? '🚫 Always Skipped' : (isDuplicate ? '✓ Already Imported' : '➕ Import');
                const importBtnStyle = isSkipped ? 'background: #ef4444; color: white; cursor: not-allowed;' : (isDuplicate ? 'background: #4CAF50; color: white; cursor: not-allowed;' : '');

                return `
                <div class="gmail-result-item" id="gmail-parking-item-${i}" style="${greyedStyle}">
                    <div class="gmail-result-header">
                        <strong>${d.carParkName || '—'}</strong>
                        <span>Arrive: ${this.formatDateUK(d.arrivalDate)} ${d.arrivalTime || ''}</span>
                        <span>Return: ${this.formatDateUK(d.returnDate)} ${d.returnTime || ''}</span>
                        ${d.pricePaid ? `<span class="gmail-price">£${d.pricePaid}</span>` : ''}
                        ${d.bookingRef ? `<span class="gmail-ref">Ref: ${d.bookingRef}</span>` : ''}
                        ${d.carRegistration ? `<span>Reg: ${d.carRegistration}</span>` : ''}
                        ${d.bookingStatus ? `<span class="gmail-status ${(d.bookingStatus || '').toLowerCase()}">${d.bookingStatus}</span>` : ''}
                    </div>
                    <div style="margin-top: 0.5rem; display: flex; gap: 0.5rem;">
                        <button onclick="app.importGmailParkingBooking(${i})" class="gmail-import-btn" style="padding: 0.35rem 0.75rem; ${importBtnStyle}" ${disabledAttr}>${importBtnText}</button>
                        ${!isSkipped ? `<button onclick="document.getElementById('gmail-parking-item-${i}').remove()" class="gmail-skip-btn" style="background:#475569; padding: 0.35rem 0.75rem;">Skip Now</button>
                        <button onclick="app.alwaysSkipGmailParkingBooking(${i})" class="gmail-skip-btn" style="background:#ef4444; color:white; padding: 0.35rem 0.75rem;">🚫 Always Skip</button>` : ''}
                    </div>
                </div>`;
            }).join('')}
        `;
        this._gmailParkingFound = sortedFound;
    }

    async alwaysSkipGmailParkingBooking(index) {
        const item = this._gmailParkingFound?.[index];
        if (!item) return;
        const d = item.details;
        if (!d.bookingRef) {
            this.showErrorMessage('Cannot always-skip: Missing booking reference.');
            return;
        }
        const skipDate = d.bookingDate || d.arrivalDate || '';
        await this.addToSkippedParkingBookings(d.bookingRef, skipDate);
        document.getElementById(`gmail-parking-item-${index}`).remove();
        this.showSuccessMessage(`Added parking Ref ${d.bookingRef} to blocklist.`);
    }

    async addToSkippedParkingBookings(bookingRef, date) {
        if (!bookingRef) return;
        const normalizedRef = bookingRef.toUpperCase();

        if (this.useSupabase) {
            const { data: existing } = await this.db.from('skipped_parkings').select('id').eq('booking_ref', normalizedRef);
            if (existing && existing.length > 0) return;

            const { error } = await this.db.from('skipped_parkings').insert({
                booking_ref: normalizedRef,
                date: date
            });
            if (error) console.error('Error saving skipped parking to Supabase:', error);
        } else {
            if (!this.skippedParkingBookings) this.skippedParkingBookings = [];
            if (this.skippedParkingBookings.some(sb => (sb.bookingRef || '').toUpperCase() === normalizedRef)) return;
            this.skippedParkingBookings.push({ bookingRef: normalizedRef, date });
            localStorage.setItem('orange-contract-skipped-parking', JSON.stringify(this.skippedParkingBookings));
        }
    }

    async importGmailParkingBooking(index) {
        const item = this._gmailParkingFound?.[index];
        if (!item) return;
        const d = item.details;

        // Check for duplicate before importing
        const isDuplicate = await this.isParkingDuplicate(d);
        if (isDuplicate) {
            this.showErrorMessage('This parking booking already exists');
            return;
        }

        this.switchSection('parking');
        this.showParkingBookingForm({
            id: null,
            carParkName: d.carParkName || '',
            arrivalDate: d.arrivalDate || '',
            arrivalTime: d.arrivalTime || '',
            returnDate: d.returnDate || '',
            returnTime: d.returnTime || '',
            pricePaid: d.pricePaid || 0,
            bookingRef: d.bookingRef || '',
            carRegistration: d.carRegistration || '',
            bookingDate: this._currentBookingDate || null,
            bookingStatus: d.bookingStatus || 'Booking'
        });
    }

    showParkingBookingForm(parking = null) {
        document.getElementById('parking-form-container').classList.remove('hidden');
        document.getElementById('parking-form-title').textContent = parking ? 'Edit Parking' : 'Add Parking Booking';
        document.getElementById('parking-id').value = parking ? parking.id : '';
        document.getElementById('parking-name').value = parking ? parking.carParkName : '';
        document.getElementById('parking-ref').value = parking ? parking.bookingRef : '';
        document.getElementById('parking-arrival-date').value = parking ? parking.arrivalDate : '';
        document.getElementById('parking-arrival-time').value = parking ? parking.arrivalTime : '';
        document.getElementById('parking-return-date').value = parking ? parking.returnDate : '';
        document.getElementById('parking-return-time').value = parking ? parking.returnTime : '';
        document.getElementById('parking-price').value = parking ? parking.pricePaid : '';
        document.getElementById('parking-car-reg').value = parking ? parking.carRegistration : '';
        document.getElementById('parking-booking-date').value = parking ? parking.bookingDate : '';
        document.getElementById('parking-booking-status').value = parking ? (parking.bookingStatus || 'Booking') : 'Booking';
        document.getElementById('parking-notes').value = parking ? parking.notes : '';
        document.getElementById('parking-form-container').scrollIntoView({ behavior: 'smooth' });
    }

    hideParkingForm() {
        document.getElementById('parking-form-container').classList.add('hidden');
        document.getElementById('parking-form').reset();
    }

    async handleParkingSubmit(e) {
        e.preventDefault();
        const id = document.getElementById('parking-id').value;
        const parking = {
            id: id || null,
            carParkName: document.getElementById('parking-name').value.trim(),
            arrivalDate: document.getElementById('parking-arrival-date').value,
            arrivalTime: document.getElementById('parking-arrival-time').value.trim(),
            returnDate: document.getElementById('parking-return-date').value,
            returnTime: document.getElementById('parking-return-time').value.trim(),
            pricePaid: parseFloat(document.getElementById('parking-price').value) || 0,
            bookingRef: document.getElementById('parking-ref').value.trim().toUpperCase(),
            carRegistration: document.getElementById('parking-car-reg').value.trim().toUpperCase(),
            bookingDate: document.getElementById('parking-booking-date').value || null,
            bookingStatus: document.getElementById('parking-booking-status').value || 'Booking',
            notes: document.getElementById('parking-notes').value.trim()
        };

        // Check for duplicates when adding new parking (not editing)
        if (!id) {
            const isDuplicate = await this.isParkingDuplicate(parking);
            if (isDuplicate) {
                this.showErrorMessage('This parking booking already exists (same reference, car park and dates/times)');
                return;
            }
        }

        const savedId = await this.saveParkingToDB(parking);
        if (savedId) parking.id = savedId;
        if (id) {
            const idx = this.parkingBookings.findIndex(p => p.id === id);
            if (idx > -1) this.parkingBookings[idx] = parking;
        } else {
            this.parkingBookings.push(parking);
        }
        if (!this.useSupabase) {
            localStorage.setItem('orange-contract-parking', JSON.stringify(this.parkingBookings));
        }
        this.hideParkingForm();
        this.renderParking();
        this.renderWeekTable();
        this.updateDashboard();
        this.showSuccessMessage('Parking booking saved!');
    }

    async saveParkingToDB(parking) {
        if (this.useSupabase) {
            this.setSyncStatus('saving');
            const row = {
                car_park_name: parking.carParkName,
                arrival_date: parking.arrivalDate,
                arrival_time: parking.arrivalTime,
                return_date: parking.returnDate,
                return_time: parking.returnTime,
                price_paid: parking.pricePaid,
                booking_ref: parking.bookingRef,
                car_registration: parking.carRegistration,
                booking_date: parking.bookingDate,
                booking_status: parking.bookingStatus,
                notes: parking.notes,
                updated_at: new Date().toISOString()
            };
            if (parking.id && typeof parking.id === 'string' && parking.id.length === 36) {
                const { error } = await this.db.from('car_park_bookings').update(row).eq('id', parking.id);
                if (error) { console.error(error); this.setSyncStatus('offline'); return null; }
                this.setSyncStatus('connected');
                return parking.id;
            } else {
                const { data, error } = await this.db.from('car_park_bookings').insert(row).select().single();
                if (error) { console.error(error); this.setSyncStatus('offline'); return null; }
                this.setSyncStatus('connected');
                return data.id;
            }
        } else {
            localStorage.setItem('orange-contract-parking', JSON.stringify(this.parkingBookings));
            return parking.id;
        }
    }

    renderParking() {
        const listDiv = document.getElementById('parking-list');
        if (!listDiv) return;

        const today = new Date().toISOString().split('T')[0];
        const activeParking = this.parkingBookings.filter(p => !p.used);

        if (activeParking.length === 0) {
            listDiv.innerHTML = '<p class="empty-state">No parking bookings yet. Click "+ Add Parking" to add one.</p>';
            return;
        }

        const renderItem = (p, isPrevious) => {
            return `
            <div class="booking-item ${isPrevious ? 'past' : ''}">
                <div class="booking-details">
                    <strong>${p.carParkName}</strong>
                    <span>Arrive: ${this.formatDateUK(p.arrivalDate)} ${p.arrivalTime || ''}</span>
                    <span>Return: ${this.formatDateUK(p.returnDate)} ${p.returnTime || ''}</span>
                    ${p.bookingRef ? `<span>Ref: <strong>${p.bookingRef}</strong></span>` : ''}
                    ${p.carRegistration ? `<span>Reg: <strong>${p.carRegistration}</strong></span>` : ''}
                    ${p.bookingStatus ? `<span class="booking-status ${(p.bookingStatus || '').toLowerCase()}">${p.bookingStatus}</span>` : ''}
                    ${p.notes ? `<span>${p.notes}</span>` : ''}
                    <span class="booking-price">${this.formatCurrency(p.pricePaid)}</span>
                </div>
                <div class="booking-actions">
                    <button onclick="app.showParkingBookingForm(app.parkingBookings.find(p=>p.id==='${p.id}'))">Edit</button>
                    <button class="delete-btn" onclick="app.deleteParking('${p.id}')">Delete</button>
                </div>
            </div>`;
        };

        const isPreviousParking = (p) => {
            const endDate = p.returnDate || p.arrivalDate;
            return endDate && endDate < today;
        };

        const current = activeParking.filter(p => !isPreviousParking(p)).sort((a, b) => new Date(a.arrivalDate) - new Date(b.arrivalDate));
        const previous = activeParking.filter(p => isPreviousParking(p)).sort((a, b) => {
            const aDate = a.returnDate || a.arrivalDate;
            const bDate = b.returnDate || b.arrivalDate;
            return new Date(bDate) - new Date(aDate);
        });

        let html = '';
        if (current.length > 0) {
            html += current.map(p => renderItem(p, false)).join('');
        }
        if (previous.length > 0) {
            html += `<div class="previous-bookings-section"><h4>Previous Bookings</h4>${previous.map(p => renderItem(p, true)).join('')}</div>`;
        }
        listDiv.innerHTML = html;
    }

    async deleteParking(id) {
        if (!confirm('Are you sure you want to delete this parking booking?')) return;

        if (this.useSupabase) {
            const { error } = await this.db.from('car_park_bookings').delete().eq('id', id);
            if (error) { console.error(error); this.showErrorMessage('Failed to delete parking'); return; }
        } else {
            this.parkingBookings = this.parkingBookings.filter(p => p.id !== id);
            localStorage.setItem('orange-contract-parking', JSON.stringify(this.parkingBookings));
        }

        this.parkingBookings = this.parkingBookings.filter(p => p.id !== id);
        this.renderParking();
        this.renderWeekTable();
        this.updateDashboard();
        this.showSuccessMessage('Parking booking deleted');
    }

    // ─── Accommodation ─────────────────────────────────────────────────────────────

    showAccommodationForm(accommodation = null) {
        document.getElementById('accommodation-form-container').classList.remove('hidden');
        document.getElementById('accommodation-form-title').textContent = accommodation ? 'Edit Accommodation' : 'Add Accommodation';
        document.getElementById('accommodation-id').value = accommodation ? accommodation.id : '';
        document.getElementById('accommodation-name').value = accommodation ? accommodation.name : '';
        document.getElementById('accommodation-from-date').value = accommodation ? accommodation.fromDate : '';
        document.getElementById('accommodation-to-date').value = accommodation ? accommodation.toDate : '';
        document.getElementById('accommodation-price-per-night').value = accommodation ? accommodation.pricePerNight : '';
        document.getElementById('accommodation-booking-date').value = accommodation ? accommodation.bookingDate : '';
        document.getElementById('accommodation-breakfast').checked = accommodation ? accommodation.breakfastIncluded : false;
        document.getElementById('accommodation-notes').value = accommodation ? accommodation.notes : '';
        document.getElementById('accommodation-form-container').scrollIntoView({ behavior: 'smooth' });
    }

    hideAccommodationForm() {
        document.getElementById('accommodation-form-container').classList.add('hidden');
        document.getElementById('accommodation-form').reset();
    }

    async handleAccommodationSubmit(e) {
        e.preventDefault();
        const id = document.getElementById('accommodation-id').value;
        const accommodation = {
            id: id || null,
            name: document.getElementById('accommodation-name').value.trim(),
            fromDate: document.getElementById('accommodation-from-date').value,
            toDate: document.getElementById('accommodation-to-date').value,
            pricePerNight: parseFloat(document.getElementById('accommodation-price-per-night').value) || 0,
            breakfastIncluded: document.getElementById('accommodation-breakfast').checked,
            bookingDate: document.getElementById('accommodation-booking-date').value || null,
            notes: document.getElementById('accommodation-notes').value.trim()
        };

        const savedId = await this.saveAccommodationToDB(accommodation);
        if (savedId) accommodation.id = savedId;
        if (id) {
            const idx = this.accommodationBookings.findIndex(a => a.id === id);
            if (idx > -1) this.accommodationBookings[idx] = accommodation;
        } else {
            this.accommodationBookings.push(accommodation);
        }
        if (!this.useSupabase) {
            localStorage.setItem('orange-contract-accommodation', JSON.stringify(this.accommodationBookings));
        }
        this.hideAccommodationForm();
        this.renderAccommodation();
        this.renderWeekTable();
        this.updateDashboard();
        this.showSuccessMessage('Accommodation booking saved!');
    }

    async saveAccommodationToDB(accommodation) {
        if (this.useSupabase) {
            this.setSyncStatus('saving');
            const row = {
                name: accommodation.name,
                from_date: accommodation.fromDate,
                to_date: accommodation.toDate,
                price_per_night: accommodation.pricePerNight,
                breakfast_included: accommodation.breakfastIncluded,
                booking_date: accommodation.bookingDate,
                notes: accommodation.notes,
                updated_at: new Date().toISOString()
            };
            if (accommodation.id && typeof accommodation.id === 'string' && accommodation.id.length === 36) {
                const { error } = await this.db.from('accommodation_bookings').update(row).eq('id', accommodation.id);
                if (error) { console.error(error); this.setSyncStatus('offline'); return null; }
                this.setSyncStatus('connected');
                return accommodation.id;
            } else {
                const { data, error } = await this.db.from('accommodation_bookings').insert(row).select().single();
                if (error) { console.error(error); this.setSyncStatus('offline'); return null; }
                this.setSyncStatus('connected');
                return data.id;
            }
        } else {
            localStorage.setItem('orange-contract-accommodation', JSON.stringify(this.accommodationBookings));
            return accommodation.id;
        }
    }

    renderAccommodation() {
        const listDiv = document.getElementById('accommodation-list');
        if (!listDiv) return;

        const sortedAccommodation = [...this.accommodationBookings].sort((a, b) => new Date(a.fromDate) - new Date(b.fromDate));

        if (sortedAccommodation.length === 0) {
            listDiv.innerHTML = '<p class="empty-state">No accommodation bookings yet. Click "+ Add Accommodation" to add one.</p>';
            return;
        }

        listDiv.innerHTML = sortedAccommodation.map(a => {
            const nights = this.calculateNights(a.fromDate, a.toDate);
            const totalCost = nights * a.pricePerNight;
            return `
            <div class="booking-item">
                <div class="booking-details">
                    <strong>${a.name}</strong>
                    <span>${this.formatDateUK(a.fromDate)} → ${this.formatDateUK(a.toDate)} (${nights} night${nights !== 1 ? 's' : ''})</span>
                    <span>Price: ${this.formatCurrency(a.pricePerNight)}/night</span>
                    <span class="booking-price">Total: ${this.formatCurrency(totalCost)}</span>
                    ${a.breakfastIncluded ? '<span>🍳 Breakfast included</span>' : ''}
                    ${a.notes ? `<span>${a.notes}</span>` : ''}
                </div>
                <div class="booking-actions">
                    <button onclick="app.showAccommodationForm(app.accommodationBookings.find(a=>a.id==='${a.id}'))">Edit</button>
                    <button class="delete-btn" onclick="app.deleteAccommodation('${a.id}')">Delete</button>
                </div>
            </div>
        `}).join('');
    }

    calculateNights(fromDate, toDate) {
        const from = new Date(fromDate);
        const to = new Date(toDate);
        const diffTime = to - from;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return diffDays;
    }

    async deleteAccommodation(id) {
        if (!confirm('Are you sure you want to delete this accommodation booking?')) return;

        if (this.useSupabase) {
            const { error } = await this.db.from('accommodation_bookings').delete().eq('id', id);
            if (error) { console.error(error); this.showErrorMessage('Failed to delete accommodation'); return; }
        } else {
            this.accommodationBookings = this.accommodationBookings.filter(a => a.id !== id);
            localStorage.setItem('orange-contract-accommodation', JSON.stringify(this.accommodationBookings));
        }

        this.accommodationBookings = this.accommodationBookings.filter(a => a.id !== id);
        this.renderAccommodation();
        this.renderWeekTable();
        this.updateDashboard();
        this.showSuccessMessage('Accommodation booking deleted');
    }

    // ─── Transport ─────────────────────────────────────────────────────────────

    showTransportForm(transport = null) {
        document.getElementById('transport-form-container').classList.remove('hidden');
        document.getElementById('transport-form-title').textContent = transport ? 'Edit Transport' : 'Add Transport';
        document.getElementById('transport-id').value = transport ? transport.id : '';
        document.getElementById('transport-name').value = transport ? transport.name : '';
        document.getElementById('transport-from-date').value = transport ? transport.fromDate : '';
        document.getElementById('transport-to-date').value = transport ? transport.toDate : '';
        document.getElementById('transport-total-cost').value = transport ? transport.totalCost : '';
        document.getElementById('transport-booking-date').value = transport ? transport.bookingDate : '';
        document.getElementById('transport-notes').value = transport ? transport.notes : '';
        document.getElementById('transport-form-container').scrollIntoView({ behavior: 'smooth' });
    }

    hideTransportForm() {
        document.getElementById('transport-form-container').classList.add('hidden');
        document.getElementById('transport-form').reset();
    }

    async handleTransportSubmit(e) {
        e.preventDefault();
        const id = document.getElementById('transport-id').value;
        const fromDate = document.getElementById('transport-from-date').value;
        const toDate = document.getElementById('transport-to-date').value;

        if (fromDate && toDate && new Date(fromDate) > new Date(toDate)) {
            this.showErrorMessage('From date cannot be after to date');
            return;
        }

        const transport = {
            id: id || null,
            name: document.getElementById('transport-name').value.trim(),
            fromDate: fromDate,
            toDate: toDate,
            totalCost: parseFloat(document.getElementById('transport-total-cost').value) || 0,
            bookingDate: document.getElementById('transport-booking-date').value || null,
            notes: document.getElementById('transport-notes').value.trim()
        };

        const savedId = await this.saveTransportToDB(transport);
        if (savedId) transport.id = savedId;
        if (id) {
            const idx = this.transportBookings.findIndex(t => t.id === id);
            if (idx > -1) this.transportBookings[idx] = transport;
        } else {
            this.transportBookings.push(transport);
        }
        if (!this.useSupabase) {
            localStorage.setItem('orange-contract-transport', JSON.stringify(this.transportBookings));
        }
        this.hideTransportForm();
        this.renderTransport();
        this.renderWeekTable();
        this.updateDashboard();
        this.showSuccessMessage('Transport booking saved!');
    }

    async saveTransportToDB(transport) {
        if (this.useSupabase) {
            this.setSyncStatus('saving');
            const row = {
                name: transport.name,
                from_date: transport.fromDate,
                to_date: transport.toDate,
                total_cost: transport.totalCost,
                booking_date: transport.bookingDate,
                notes: transport.notes,
                updated_at: new Date().toISOString()
            };
            if (transport.id && typeof transport.id === 'string' && transport.id.length === 36) {
                const { error } = await this.db.from('transport_bookings').update(row).eq('id', transport.id);
                if (error) { console.error(error); this.setSyncStatus('offline'); return null; }
                this.setSyncStatus('connected');
                return transport.id;
            } else {
                const { data, error } = await this.db.from('transport_bookings').insert(row).select().single();
                if (error) { console.error(error); this.setSyncStatus('offline'); return null; }
                this.setSyncStatus('connected');
                return data.id;
            }
        } else {
            localStorage.setItem('orange-contract-transport', JSON.stringify(this.transportBookings));
            return transport.id;
        }
    }

    renderTransport() {
        const listDiv = document.getElementById('transport-list');
        if (!listDiv) return;

        const sortedTransport = [...this.transportBookings].sort((a, b) => new Date(a.fromDate) - new Date(b.fromDate));

        if (sortedTransport.length === 0) {
            listDiv.innerHTML = "<p class=\"empty-state\">No transport bookings yet. Click \"+ Add Transport\" to add one.</p>";
            return;
        }

        listDiv.innerHTML = sortedTransport.map(t => {
            const days = this.calculateTransportDays(t.fromDate, t.toDate);
            const perDay = days > 0 ? t.totalCost / days : 0;
            return `
            <div class="booking-item">
                <div class="booking-details">
                    <strong>${t.name}</strong>
                    <span>${this.formatDateUK(t.fromDate)} → ${this.formatDateUK(t.toDate)} (${days} day${days !== 1 ? 's' : ''})</span>
                    <span>Total: ${this.formatCurrency(t.totalCost)}</span>
                    <span class="booking-price">${this.formatCurrency(perDay)}/day</span>
                    ${t.notes ? `<span>${t.notes}</span>` : ''}
                </div>
                <div class="booking-actions">
                    <button onclick="app.showTransportForm(app.transportBookings.find(t=>t.id==='${t.id}'))">Edit</button>
                    <button class="delete-btn" onclick="app.deleteTransport('${t.id}')">Delete</button>
                </div>
            </div>
        `}).join('');
    }

    async deleteTransport(id) {
        if (!confirm('Are you sure you want to delete this transport booking?')) return;

        if (this.useSupabase) {
            const { error } = await this.db.from('transport_bookings').delete().eq('id', id);
            if (error) { console.error(error); this.showErrorMessage('Failed to delete transport'); return; }
        } else {
            this.transportBookings = this.transportBookings.filter(t => t.id !== id);
            localStorage.setItem('orange-contract-transport', JSON.stringify(this.transportBookings));
        }

        this.transportBookings = this.transportBookings.filter(t => t.id !== id);
        this.renderTransport();
        this.renderWeekTable();
        this.updateDashboard();
        this.showSuccessMessage('Transport booking deleted');
    }

    async fetchGmailMessage(messageId) {
        try {
            const resp = await fetch(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
                { headers: { Authorization: `Bearer ${this.googleAccessToken}` } }
            );
            return resp.ok ? await resp.json() : null;
        } catch { return null; }
    }

    getEmailHeader(email, name) {
        const headers = email.payload?.headers || [];
        return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
    }

    decodeEmailBody(payload) {
        if (!payload) return '';
        // Try plain text part first
        const plainPart = this.findPart(payload, 'text/plain');
        if (plainPart?.body?.data) return atob(plainPart.body.data.replace(/-/g, '+').replace(/_/g, '/'));
        // Fallback to HTML part (strip tags)
        const htmlPart = this.findPart(payload, 'text/html');
        if (htmlPart?.body?.data) {
            const html = atob(htmlPart.body.data.replace(/-/g, '+').replace(/_/g, '/'));
            return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        }
        // Inline body
        if (payload.body?.data) return atob(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
        return '';
    }

    findPart(payload, mimeType) {
        if (payload.mimeType === mimeType) return payload;
        if (payload.parts) {
            for (const part of payload.parts) {
                const found = this.findPart(part, mimeType);
                if (found) return found;
            }
        }
        return null;
    }

    renderGmailResults(found) {
        const resultsDiv = document.getElementById('gmail-results');
        if (found.length === 0) {
            const message = this._lastSearchExtracted
                ? 'Found emails but couldn\'t find anything new.'
                : 'Found emails but couldn\'t extract booking details. Try the manual paste option below.';
            resultsDiv.innerHTML = `<div class="gmail-empty">${message}</div>`;
            return;
        }
        resultsDiv.innerHTML = `
            <h4>Found ${found.length} booking(s) in Gmail</h4>
            <p class="gmail-hint">Review each booking and click Import to add it.</p>
            ${found.map((item, i) => {
                const d = item.details;
                const route = this.cleanRoute(d.route);
                return `
                <div class="gmail-result-item" id="gmail-item-${i}">
                    <div class="gmail-result-header">
                        <strong>${d.flightNumber || '—'}</strong>
                        <span>${route}</span>
                        <span>${this.formatDateUK(d.date)}</span>
                        ${d.seat ? `<span>Seat: ${d.seat}</span>` : ''}
                        ${d.pricePaid ? `<span class="gmail-price">£${d.pricePaid}</span>` : ''}
                        ${d.bookingRef ? `<span class="gmail-ref">Ref: ${d.bookingRef}</span>` : ''}
                    </div>
                    <div style="margin-top: 0.5rem; display: flex; gap: 0.5rem;">
                        <button onclick="app.importGmailBooking(${i})" class="gmail-import-btn" style="padding: 0.35rem 0.75rem;">➕ Import</button>
                        <button onclick="document.getElementById('gmail-item-${i}').remove()" class="gmail-skip-btn" style="background:#475569; padding: 0.35rem 0.75rem;">Skip Now</button>
                        <button onclick="app.alwaysSkipGmailBooking(${i})" class="gmail-skip-btn" style="background:#ef4444; color:white; padding: 0.35rem 0.75rem;">🚫 Always Skip</button>
                    </div>
                </div>`;
            }).join('')}
        `;
        // Store found data for import
        this._gmailFound = found;
    }

    async alwaysSkipGmailBooking(index) {
        const item = this._gmailFound?.[index];
        if (!item) return;
        const d = item.details;
        if (!d.bookingRef || !d.date) {
            this.showErrorMessage('Cannot always-skip: Missing booking reference or date.');
            return;
        }
        await this.addToSkippedBookings(d.bookingRef, d.date);
        document.getElementById(`gmail-item-${index}`).remove();
        this.showSuccessMessage(`Added Ref ${d.bookingRef} on ${d.date} to blocklist.`);
    }

    async importGmailBooking(index) {
        const item = this._gmailFound?.[index];
        if (!item) return;
        const d = item.details;
        const route = d.departure && d.arrival ? `${d.departure} → ${d.arrival}` : (d.route || '');
        this.switchSection('bookings');
        this.showBookingForm({
            id: null,
            flightNumber: d.flightNumber || '',
            route,
            date: d.date || '',
            departureTime: d.departureTime || '',
            arrivalTime: d.arrivalTime || '',
            pricePaid: d.pricePaid || 0,
            bookingRef: d.bookingRef || '',
            seat: d.seat || '',
            notes: d.notes || '',
            bookingDate: this._currentBookingDate || null
        });
    }

    // ─── Email parsing ─────────────────────────────────────────────────────────

    parseEmail() {
        const emailText = document.getElementById('email-text').value.trim();
        if (!emailText) {
            this.showErrorMessage('Please paste email content');
            return;
        }

        const { bookingRef, date: bookingDate } = this.extractBookingRefAndDate('', emailText);
        this._currentBookingDate = bookingDate;

        const engine = document.getElementById('parser-engine').value;
        if (engine === 'gemini') {
            this.parseWithGemini(emailText);
        } else {
            const flights = this.extractMultipleFlights(emailText);
            this.displayMultipleParsedFlights(flights);
        }
    }

    extractBookingRefAndDate(subject, body) {
        let bookingRef = null;
        
        const isLoganair = subject.toLowerCase().includes('loganair') || 
                         subject.toLowerCase().includes('thank you for booking');
        
        if (isLoganair) {
            const loganairMatch = body.match(/booking\s+ref(?:erence)?[:\s]+([A-Z]{2}[0-9]{4,5})\b/i) ||
                                 body.match(/ref(?:erence)?[:\s]+([A-Z]{2}[0-9]{4,5})\b/i) ||
                                 body.match(/booking\s+ref(?:erence)?[:\s]+([A-Z0-9]{6,7})\b/i) ||
                                 body.match(/ref(?:erence)?[:\s]+([A-Z0-9]{6,7})\b/i) ||
                                 body.match(/\b([A-Z]{2}[0-9]{4,5})\b/);
            if (loganairMatch) {
                bookingRef = loganairMatch[1];
            }
        } else {
            const easyjetMatch = subject.match(/booking\s+ref(?:erence)?[:\s]+([A-Z0-9]{6,7})$/i);
            if (easyjetMatch) {
                bookingRef = easyjetMatch[1];
            }
        }
        
        const dateMatch = body.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})/i) ||
                         body.match(/(\d{4}-\d{2}-\d{2})/) ||
                         body.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/) ||
                         body.match(/(?:departure|flight|date)[:\s]*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/i) ||
                         body.match(/(?:departure|flight|date)[:\s]*(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})/i);
        
        let date = '';
        if (dateMatch) {
            if (dateMatch[0].includes('-') && dateMatch[0].match(/^\d{4}-\d{2}-\d{2}$/)) {
                date = dateMatch[0];
            } else if (dateMatch.length >= 4) {
                const months = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
                let month, day, year;
                
                if (dateMatch[2] && months[dateMatch[2].toLowerCase()]) {
                    day = dateMatch[1].padStart(2, '0');
                    month = months[dateMatch[2].toLowerCase()];
                    year = dateMatch[3];
                } else {
                    day = dateMatch[1].padStart(2, '0');
                    month = dateMatch[2].padStart(2, '0');
                    year = dateMatch[3];
                }
                date = `${year}-${month}-${day}`;
            }
        }
        
        return { bookingRef, date };
    }

    extractParkingRefFromSubject(subject) {
        // Extract booking reference from subject line
        // Pattern: typically 1 letter followed by 5 alphanumeric chars (e.g., B2PDT)
        const refMatch = subject.match(/\b([A-Z][A-Z0-9]{4,5})\b/);
        if (refMatch) {
            return refMatch[1].toUpperCase();
        }
        return null;
    }

    matchesParkingKey(a, b) {
        const normalize = (v) => (v === undefined || v === null ? '' : String(v).toUpperCase().trim());
        return (
            normalize(a.bookingRef) === normalize(b.bookingRef) &&
            normalize(a.carParkName) === normalize(b.carParkName) &&
            normalize(a.arrivalDate) === normalize(b.arrivalDate) &&
            normalize(a.arrivalTime) === normalize(b.arrivalTime) &&
            normalize(a.returnDate) === normalize(b.returnDate) &&
            normalize(a.returnTime) === normalize(b.returnTime)
        );
    }

    isParkingSkipped(bookingRef) {
        if (!bookingRef || !this.skippedParkingBookings) return false;
        const normalizedRef = bookingRef.toUpperCase();
        return this.skippedParkingBookings.some(sb => (sb.bookingRef || '').toUpperCase() === normalizedRef);
    }

    async isParkingDuplicate(parking) {
        if (!parking) return false;
        // Honour the "Always Skip" blocklist first (by ref)
        if (this.isParkingSkipped(parking.bookingRef)) return true;
        // Compare against existing parking bookings using all key fields
        return this.parkingBookings.some(p => this.matchesParkingKey(p, parking));
    }

    async isBookingSkippedOrDuplicate(bookingRef, bookingDate) {
        if (!bookingRef || !bookingDate) return false;
        
        const normalizedRef = bookingRef.toUpperCase();
        
        if (this.useSupabase) {
            const { data: skipped } = await this.db.from('skipped_bookings')
                .select('*')
                .eq('booking_ref', normalizedRef)
                .eq('date', bookingDate);
            if (skipped && skipped.length > 0) return true;
            
            const { data: existing } = await this.db.from('bookings')
                .select('*')
                .eq('booking_ref', normalizedRef)
                .eq('booking_date', bookingDate);
            if (existing && existing.length > 0) return true;
        } else {
            const isSkipped = this.skippedBookings.some(
                sb => sb.bookingRef === normalizedRef && sb.date === bookingDate
            );
            if (isSkipped) return true;
            
            const isDuplicate = this.bookings.some(
                b => b.bookingRef === normalizedRef && b.bookingDate === bookingDate
            );
            if (isDuplicate) return true;
        }
        
        return false;
    }

    async parseWithGemini(emailText) {
        const geminiKey = await credentialManager.get('gemini-api-key');
        if (!geminiKey) {
            this.showErrorMessage('Please add a Gemini API Key in Settings first.');
            this.switchSection('settings');
            return;
        }

        const { bookingRef, date: bookingDate } = this.extractBookingRefAndDate('', emailText);
        this._currentBookingDate = bookingDate;
        
        if (bookingRef && bookingDate) {
            const isDuplicate = await this.isBookingSkippedOrDuplicate(bookingRef, bookingDate);
            if (isDuplicate) {
                const parsedDiv = document.getElementById('parsed-flight');
                parsedDiv.innerHTML = `<div class="parse-warning">⚠️ This booking (Ref: ${bookingRef}, Booking Date: ${bookingDate}) already exists or was skipped. No need to import again.</div>`;
                return;
            }
        }

        const parsedDiv = document.getElementById('parsed-flight');
        parsedDiv.innerHTML = '<div class="gmail-loading">🧠 Gemini AI is reading and extracting bookings...</div>';

        const prompt = `You are a strict travel data extractor. Read the travel booking email text provided. Extract ALL booking segments.

COMPULSORY FIELD RULES:
1. "route" Formatting: This field must ONLY contain "City1 → City2".
   - "City1" and "City2" MUST be the single-word city names (e.g., "Bristol", "Glasgow", "Malta", "London").
   - Under no circumstances can this field contain words like "Flex", "Pass", "EZY", flight numbers, airline names, check-in information, passenger names, or anything else.
   - It must strictly match this exact regex shape: ^[A-Za-z]+ → [A-Za-z]+$
   - Example correct values: "Bristol → Glasgow", "Bristol → Malta", "Glasgow → Bristol".
2. "seat": Extract ONLY the passenger's seat assignment alphanumeric code (e.g. "27A", "7C"). If not found, leave as empty string. Do not include passenger names or headings.
3. "notes": Put indicators about Flex Passes or baggage rules here (e.g. "Flex Pass not used"). Keep this completely separated from "route".

Return ONLY a valid JSON array of objects (no markdown, no backticks, no wrap, just raw JSON text) with this exact schema:
[
  {
    "flightNumber": "flight number (e.g. EZY201)",
    "route": "Origin → Destination (e.g. Bristol → Glasgow)",
    "date": "departure date in YYYY-MM-DD format",
    "departureTime": "departure time in HH:MM format",
    "arrivalTime": "arrival time in HH:MM format",
    "pricePaid": number,
    "bookingRef": "booking reference (e.g. KCRCW6Z)",
    "seat": "alphanumeric seat code (e.g. 27A)",
    "notes": "Flex Pass status and details"
  }
]

Email text to parse:
${emailText}`;

        try {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-goog-api-key': geminiKey 
                },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                })
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error?.message || `HTTP ${response.status}`);
            }

            const data = await response.json();
            const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!textResponse) throw new Error('Empty response from Gemini AI');

            // Clean markdown wrap if present
            const cleanJson = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();
            const bookings = JSON.parse(cleanJson);
            
            if (!Array.isArray(bookings)) {
                throw new Error('Gemini did not return an array');
            }

            // Format bookings to match expected schema
            const formatted = bookings.map(b => {
                let seat = b.seat || b.Seat || b.seatNumber || b.seat_number || '';
                if (!seat) {
                    const rawSeatMatch = emailText.match(/Seat:\s*([0-9]{1,2}[A-K])\b/i) || 
                                         emailText.match(/Seat\s+([0-9]{1,2}[A-K])\b/i) ||
                                         emailText.match(/\b([0-9]{1,2}[A-K])\s+Small cabin bag/i);
                    if (rawSeatMatch) {
                        seat = rawSeatMatch[1].toUpperCase();
                    }
                }
                return {
                    flightNumber: b.flightNumber || b.flight_number || b.reference || 'Booking',
                    route: this.cleanRoute(b.route || b.location || 'Location'),
                    date: b.date || '',
                    departureTime: b.departureTime || b.departure_time || b.start_time || '',
                    arrivalTime: b.arrivalTime || b.arrival_time || b.end_time || '',
                    pricePaid: parseFloat(b.pricePaid || b.price_paid || b.cost || b.price) || 0,
                    bookingRef: b.bookingRef || b.booking_ref || b.ref || '',
                    seat,
                    notes: b.notes || ''
                };
            });

            this.displayGeminiParsedBookings(formatted);
            this.showSuccessMessage('Parsed successfully with Gemini AI!');
        } catch (e) {
            console.error('Gemini extraction failed:', e);
            parsedDiv.innerHTML = `<div class="parse-warning">⚠️ Gemini AI extraction failed: ${e.message}. Please check your API key and network connection.</div>`;
        }
    }

    displayGeminiParsedBookings(bookings) {
        const parsedDiv = document.getElementById('parsed-flight');
        if (bookings.length === 0) {
            parsedDiv.innerHTML = '<div class="parse-warning">⚠️ Gemini AI did not detect any bookings in this text.</div>';
            return;
        }

        parsedDiv.innerHTML = `
            <div class="parsed-result">
                <h4>🧠 Gemini AI Extracted Bookings (${bookings.length})</h4>
                <p class="gmail-hint">Review each item and click Import to add it.</p>
                ${bookings.map((booking, i) => {
                    return `
                    <div style="border-bottom: 1px solid #e0e0e0; margin-bottom: 1rem; padding-bottom: 1rem;">
                        <h5 style="color: #ff6b35; margin-bottom: 0.5rem;">Item ${i + 1}: ${booking.route}</h5>
                        <table class="parsed-table">
                            <tr><td>Reference / Flight</td><td><strong>${booking.flightNumber || '—'}</strong></td></tr>
                            <tr><td>Date</td><td><strong>${this.formatDateUK(booking.date)}</strong></td></tr>
                            <tr><td>Route / Details</td><td>${booking.route || '—'}</td></tr>
                            <tr><td>Start / Departs</td><td>${booking.departureTime || '—'}</td></tr>
                            <tr><td>End / Arrives</td><td>${booking.arrivalTime || '—'}</td></tr>
                            <tr><td>Booking Ref</td><td>${booking.bookingRef || '—'}</td></tr>
                            <tr><td>Seat</td><td>${booking.seat || '—'}</td></tr>
                            <tr><td>Price</td><td>${booking.pricePaid ? '£' + booking.pricePaid : '— (Or included)'}</td></tr>
                            ${booking.notes ? `<tr><td>Notes</td><td><small>${booking.notes}</small></td></tr>` : ''}
                        </table>
                        <button onclick="app.importSegment(${i})" style="margin-top: 0.5rem; padding: 0.4rem 0.8rem; font-size: 0.85rem;">➕ Add ${booking.flightNumber || 'Item'} to Bookings</button>
                    </div>`;
                }).join('')}
            </div>`;
        this._parsedSegments = bookings;
    }

    extractMultipleFlights(emailText) {
        // Try easyjet parser first
        const easyjetResult = this.extractEasyjetDetails(emailText);
        if (easyjetResult && (easyjetResult.flightNumber || easyjetResult.bookingRef)) {
            if (Array.isArray(easyjetResult)) {
                return easyjetResult;
            }
            return [easyjetResult];
        }
        
        // Then try loganair parser
        const loganairResult = this.extractLoganairDetails(emailText);
        if (loganairResult && (loganairResult.flightNumber || loganairResult.bookingRef)) {
            if (Array.isArray(loganairResult)) {
                return loganairResult;
            }
            return [loganairResult];
        }
        
        // Fallback to original parsing logic
        // Extract common fields
        let bookingRef = '';
        const refMatch = emailText.match(/booking\s*(?:reference|ref|number)?[:\s#]*([A-Z0-9]{7})\b/i);
        if (refMatch) {
            bookingRef = refMatch[1].toUpperCase();
        } else {
            // Fallback: search for any standalone 7-character alphanumeric string that contains both letters and numbers
            const genericRefMatch = emailText.match(/\b([A-Z0-9]{7})\b/g);
            if (genericRefMatch) {
                const found = genericRefMatch.find(ref => !ref.match(/^\d+$/) && !ref.match(/^[A-Za-z]+$/));
                if (found) bookingRef = found.toUpperCase();
            }
        }

        let totalCost = '';
        const costMatch = emailText.match(/Payment to easyJet of £\s*(\d+(?:\.\d{2})?)/i) || emailText.match(/£\s*(\d+(?:\.\d{2})?)/);
        if (costMatch) totalCost = costMatch[1];

        // Split text into potential flight segments by searching for Flight blocks or Passenger sections
        // Let's find every occurrence of EZY/U2 flight numbers
        const flightNumRegex = /\b((?:EZY|U2)\s*\d{3,4})\b/ig;
        const flightNumbers = [];
        let match;
        while ((match = flightNumRegex.exec(emailText)) !== null) {
            flightNumbers.push({
                number: match[1].replace(/\s+/g, '').toUpperCase(),
                index: match.index
            });
        }

        const flights = [];

        // For each flight segment, locate local information relative to its index
        flightNumbers.forEach((fNumObj, i) => {
            const currentIdx = fNumObj.index;
            const nextIdx = flightNumbers[i + 1] ? flightNumbers[i + 1].index : emailText.length;
            
            // Limit segment scope to start from flight number up to the next flight number
            const segmentText = emailText.substring(currentIdx, nextIdx);

            const flight = {
                flightNumber: fNumObj.number,
                date: '',
                departure: '',
                arrival: '',
                departureTime: '',
                arrivalTime: '',
                bookingRef: bookingRef,
                cost: i === 0 ? totalCost : ''
            };

            // 1. Parse Route: Find airport names before the flight number inside the preceding 200 characters
            const lookbackText = emailText.substring(currentIdx - 200 < 0 ? 0 : currentIdx - 200, currentIdx);
            
            // Matches "Bristol to Glasgow" or "Bristol  to  Glasgow" or "Bristol → Glasgow"
            const routeMatch = lookbackText.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s*(?:to|→)\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i);
            if (routeMatch) {
                const dep = routeMatch[1].trim();
                const arr = routeMatch[2].trim();
                if (dep.toLowerCase() !== 'payment' && dep.toLowerCase() !== 'flight' && dep.toLowerCase() !== 'passenger') {
                    flight.departure = dep;
                    flight.arrival = arr;
                }
            }

            // 2. Parse Date & Times inside this specific segment (outbound vs return text block)
            const depBlockMatch = segmentText.match(/Departs:\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}:\d{2})/i);
            const arrBlockMatch = segmentText.match(/Arrives:\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}:\d{2})/i);

            if (depBlockMatch) {
                const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
                const day = parseInt(depBlockMatch[1]);
                const month = months[depBlockMatch[2].toLowerCase()];
                const year = parseInt(depBlockMatch[3]);
                const d = new Date(year, month, day);
                if (!isNaN(d.getTime())) {
                    flight.date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
                }
                flight.departureTime = depBlockMatch[4];
            }

            if (arrBlockMatch) {
                flight.arrivalTime = arrBlockMatch[4];
            }

            // 3. Parse Seat: e.g. "Seat: 27A" within this segment block
            const seatMatch = segmentText.match(/Seat:\s*([A-Z0-9]{2,4})\b/i);
            if (seatMatch) {
                flight.seat = seatMatch[1].toUpperCase();
            } else {
                flight.seat = '';
            }

            flights.push(flight);
        });

        return flights;
    }

    displayMultipleParsedFlights(flights) {
        const parsedDiv = document.getElementById('parsed-flight');
        if (flights.length === 0) {
            parsedDiv.innerHTML = '<div class="parse-warning">⚠️ Could not extract any flight details. Try checking the format of the email.</div>';
            return;
        }

        parsedDiv.innerHTML = `
            <div class="parsed-result">
                <h4>Extracted Flights (${flights.length})</h4>
                ${flights.map((flight, i) => {
                    const route = flight.departure && flight.arrival ? `${flight.departure} → ${flight.arrival}` : 'Not found';
                    return `
                    <div style="border-bottom: 1px solid #e0e0e0; margin-bottom: 1rem; padding-bottom: 1rem;">
                        <h5 style="color: #ff6b35; margin-bottom: 0.5rem;">Flight ${i + 1}: ${flight.flightNumber}</h5>
                        <table class="parsed-table">
                            <tr><td>Flight</td><td><strong>${flight.flightNumber || '—'}</strong></td></tr>
                            <tr><td>Date</td><td>${flight.date || '—'}</td></tr>
                            <tr><td>Route</td><td>${route}</td></tr>
                            <tr><td>Departure</td><td>${flight.departureTime || '—'}</td></tr>
                            <tr><td>Arrival</td><td>${flight.arrivalTime || '—'}</td></tr>
                            <tr><td>Booking Ref</td><td>${flight.bookingRef || '—'}</td></tr>
                            <tr><td>Seat</td><td><strong>${flight.seat || 'Not assigned'}</strong></td></tr>
                            <tr><td>Price (Outbound)</td><td>${flight.cost ? '£' + flight.cost : '— (Included)'}</td></tr>
                        </table>
                        <button onclick="app.importSegment(${i})" style="margin-top: 0.5rem; padding: 0.4rem 0.8rem; font-size: 0.85rem;">➕ Add Flight ${i + 1} to Bookings</button>
                    </div>`;
                }).join('')}
            </div>`;
        this._parsedSegments = flights;
    }

    importSegment(index) {
        const flight = this._parsedSegments?.[index];
        if (!flight) return;
        const route = flight.departure && flight.arrival ? `${flight.departure} → ${flight.arrival}` : '';
        this.switchSection('bookings');
        this.showBookingForm({
            id: null,
            flightNumber: flight.flightNumber,
            route: route,
            date: flight.date,
            departureTime: flight.departureTime,
            arrivalTime: flight.arrivalTime,
            pricePaid: flight.cost ? parseFloat(flight.cost) : 0,
            bookingRef: flight.bookingRef,
            seat: flight.seat || '',
            notes: '',
            bookingDate: this._currentBookingDate || null
        });
    }

    extractEasyjetDetails(emailText) {
        // Multi-flight extraction fallback support for Loganair/easyJet local engine
        const flights = [];
        
        // 1. Extract common fields
        let bookingRef = '';
        const bookingRefMatch = emailText.match(/booking\s*(?:reference|ref|number)?[:\s#]*([A-Z0-9]{6,7})\b/i);
        if (bookingRefMatch) {
            bookingRef = bookingRefMatch[1].toUpperCase();
        } else {
            const refMatch = emailText.match(/\b([A-Z0-9]{6,7})\b/g);
            if (refMatch) {
                const found = refMatch.find(ref => !ref.match(/^\d+$/) && !ref.match(/^[A-Za-z]+$/) && (ref.length === 6 || ref.length === 7));
                if (found) bookingRef = found.toUpperCase();
            }
        }

        let totalCost = '';
        const costMatch = emailText.match(/Total\s*(?:GBP)?\s*£?(\d+(?:\.\d{2})?)/i) || emailText.match(/£\s*(\d+(?:\.\d{2})?)/);
        if (costMatch) totalCost = costMatch[1];

        // 2. Discover all flight segments by searching for Flight Numbers (e.g. LM0046, EZY123)
        const flightNumRegex = /\b((?:EZY|U2|LM)\s*\d{3,4})\b/ig;
        const flightNumbers = [];
        let match;
        while ((match = flightNumRegex.exec(emailText)) !== null) {
            flightNumbers.push({
                number: match[1].replace(/\s+/g, '').toUpperCase(),
                index: match.index
            });
        }

        // If no flight numbers found, fallback to standard parsing logic for single segment
        if (flightNumbers.length === 0) {
            const flight = { flightNumber: 'Booking', date: '', departure: '', arrival: '', departureTime: '', arrivalTime: '', bookingRef: bookingRef, cost: totalCost };
            
            // Try to find a date
            const dateMatch = emailText.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4}|\d{2})/i);
            if (dateMatch) {
                const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
                const day = parseInt(dateMatch[1]);
                const month = months[dateMatch[2].toLowerCase()];
                let year = parseInt(dateMatch[3]);
                if (year < 100) year += 2000;
                const d = new Date(year, month, day);
                if (!isNaN(d.getTime())) {
                    flight.date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
                }
            }
            return flight;
        }

        // 3. Extract each segment as a separate flight
        flightNumbers.forEach((fNumObj, i) => {
            const currentIdx = fNumObj.index;
            const nextIdx = flightNumbers[i + 1] ? flightNumbers[i + 1].index : emailText.length;
            const segmentText = emailText.substring(currentIdx, nextIdx);

            // Look back up to 200 chars for route (e.g. Bristol ... To: ... Aberdeen)
            const lookbackText = emailText.substring(currentIdx - 200 < 0 ? 0 : currentIdx - 200, currentIdx);
            let departure = '';
            let arrival = '';

            // Clean lookback route matching (Loganair style: Bristol \n To: \n Aberdeen)
            const routeMatch = lookbackText.match(/([A-Z][a-z]+)\s*(?:\n|\r|\s)*To:?\s*(?:\n|\r|\s)*([A-Z][a-z]+)/i) ||
                               lookbackText.match(/([A-Z][a-z]+)\s*(?:to|→)\s*([A-Z][a-z]+)/i);

            if (routeMatch) {
                const dep = routeMatch[1].trim();
                const arr = routeMatch[2].trim();
                const badWords = ['payment', 'flight', 'passenger', 'welcome', 'next', 'check', 'attention', 'allergy', 'thank', 'you', 'choosing', 'fly', 'with', 'loganair'];
                if (!badWords.includes(dep.toLowerCase()) && !badWords.includes(arr.toLowerCase())) {
                    departure = dep;
                    arrival = arr;
                }
            }

            // Look forward for Date, Depart, Arrive
            let date = '';
            let departureTime = '';
            let arrivalTime = '';

            const dateMatch = segmentText.match(/Date:\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4}|\d{2})/i) ||
                              emailText.substring(currentIdx - 100 < 0 ? 0 : currentIdx - 100, currentIdx).match(/Date:\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4}|\d{2})/i);
            
            if (dateMatch) {
                const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
                const day = parseInt(dateMatch[1]);
                const month = months[dateMatch[2].toLowerCase()];
                let year = parseInt(dateMatch[3]);
                if (year < 100) year += 2000;
                const d = new Date(year, month, day);
                if (!isNaN(d.getTime())) {
                    date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
                }
            }

            const depTimeMatch = segmentText.match(/Depart:\s*(\d{2}:\d{2})/i);
            if (depTimeMatch) departureTime = depTimeMatch[1];

            const arrTimeMatch = segmentText.match(/Arrive:\s*(\d{2}:\d{2})/i);
            if (arrTimeMatch) arrivalTime = arrTimeMatch[1];

            // Extract seat number: look for Seat: block further down, or find 11F layout below Traveller block
            let seat = '';
            const seatMatch = segmentText.match(/Seat:\s*([0-9]{1,2}[A-K])\b/i) || 
                              emailText.match(/Seat:\s*(?:\n|\r|\s)*[A-Z0-9\/s]+(?:\n|\r|\s)*([0-9]{1,2}[A-K])\b/i);
            if (seatMatch) {
                seat = seatMatch[1].toUpperCase();
            } else {
                // If there are multiple flights, seats can be listed in order under Flight(s): Seat: E-Ticket: block
                // Let's search the whole email text for seat lists
                const seatListMatch = emailText.match(/\b([0-9]{1,2}[A-K])\s*\n\s*[0-9]{1,2}[A-K]\b/) ||
                                      emailText.match(/\b([0-9]{1,2}[A-K])\s+Small cabin bag/i);
                if (seatListMatch) {
                    seat = seatListMatch[1].toUpperCase();
                }
            }

            flights.push({
                flightNumber: fNumObj.number,
                departure: departure,
                arrival: arrival,
                date: date,
                departureTime: departureTime,
                arrivalTime: arrivalTime,
                bookingRef: bookingRef,
                cost: totalCost,
                seat: seat
            });
        });

        // To comply with standard single-flight details interface if only 1 segment
        if (flights.length === 1) {
            return flights[0];
        }

        // Return the array - the parsing loop handles this beautifully
        return flights;
    }

    extractLoganairDetails(emailText) {
        // Loganair-specific parsing with tab character support
        const flights = [];
        
        // 1. Extract common fields - Loganair uses tabs
        let bookingRef = '';
        const bookingRefMatch = emailText.match(/booking\s*reference:\s*\t*([A-Z0-9]{6,7})/i);
        if (bookingRefMatch) {
            bookingRef = bookingRefMatch[1].toUpperCase();
        } else {
            const refMatch = emailText.match(/\b([A-Z0-9]{6,7})\b/g);
            if (refMatch) {
                const found = refMatch.find(ref => !ref.match(/^\d+$/) && !ref.match(/^[A-Za-z]+$/) && (ref.length === 6 || ref.length === 7));
                if (found) bookingRef = found.toUpperCase();
            }
        }

        let totalCost = '';
        const costMatch = emailText.match(/Total\s*(?:GBP)?\s*£?(\d+(?:\.\d{2})?)/i) || emailText.match(/£\s*(\d+(?:\.\d{2})?)/);
        if (costMatch) totalCost = costMatch[1];

        // 2. Discover all flight segments by searching for Flight Numbers (LM only for Loganair)
        const flightNumRegex = /\b(LM\d{3,4})\b/ig;
        const flightNumbers = [];
        let match;
        while ((match = flightNumRegex.exec(emailText)) !== null) {
            flightNumbers.push({
                number: match[1].toUpperCase(),
                index: match.index
            });
        }

        // If no flight numbers found, fallback to standard parsing logic for single segment
        if (flightNumbers.length === 0) {
            const flight = { flightNumber: 'Booking', date: '', departure: '', arrival: '', departureTime: '', arrivalTime: '', bookingRef: bookingRef, cost: totalCost };
            
            // Try to find a date
            const dateMatch = emailText.match(/Date:\s*\t*(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2})/i);
            if (dateMatch) {
                const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
                const day = parseInt(dateMatch[1]);
                const month = months[dateMatch[2].toLowerCase()];
                let year = parseInt(dateMatch[3]);
                if (year < 100) year += 2000;
                const d = new Date(year, month, day);
                if (!isNaN(d.getTime())) {
                    flight.date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
                }
            }
            return flight;
        }

        // 3. Extract each segment as a separate flight
        flightNumbers.forEach((fNumObj, i) => {
            const currentIdx = fNumObj.index;
            const nextIdx = flightNumbers[i + 1] ? flightNumbers[i + 1].index : emailText.length;
            const segmentText = emailText.substring(currentIdx, nextIdx);

            // Look back up to 200 chars for route (Loganair style: Bristol \\n To: \\n Aberdeen with tabs)
            const lookbackText = emailText.substring(currentIdx - 200 < 0 ? 0 : currentIdx - 200, currentIdx);
            let departure = '';
            let arrival = '';

            // Loganair-specific route matching with tabs
            const routeMatch = lookbackText.match(/([A-Z][a-z]+)(?:\s*\n\s*\t*\s*To:\s*\n\s*\t*\s*)([A-Z][a-z]+)/i) ||
                               lookbackText.match(/([A-Z][a-z]+)\s*(?:\n|\r|\s)*To:?\s*(?:\n|\r|\s)*([A-Z][a-z]+)/i) ||
                               lookbackText.match(/([A-Z][a-z]+)\s*(?:to|→)\s*([A-Z][a-z]+)/i);

            if (routeMatch) {
                const dep = routeMatch[1].trim();
                const arr = routeMatch[2].trim();
                const badWords = ['payment', 'flight', 'passenger', 'welcome', 'next', 'check', 'attention', 'allergy', 'thank', 'you', 'choosing', 'fly', 'with', 'loganair'];
                if (!badWords.includes(dep.toLowerCase()) && !badWords.includes(arr.toLowerCase())) {
                    departure = dep;
                    arrival = arr;
                }
            }

            // Look forward for Date, Depart, Arrive - Loganair uses tabs
            let date = '';
            let departureTime = '';
            let arrivalTime = '';

            const dateMatch = segmentText.match(/Date:\s*\t*(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2})/i) ||
                              emailText.substring(currentIdx - 100 < 0 ? 0 : currentIdx - 100, currentIdx).match(/Date:\s*\t*(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2})/i);
            
            if (dateMatch) {
                const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
                const day = parseInt(dateMatch[1]);
                const month = months[dateMatch[2].toLowerCase()];
                let year = parseInt(dateMatch[3]);
                if (year < 100) year += 2000;
                const d = new Date(year, month, day);
                if (!isNaN(d.getTime())) {
                    date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
                }
            }

            const depTimeMatch = segmentText.match(/Depart:\s*\t*(\d{2}:\d{2})/i) ||
                              segmentText.match(/Depart:\s*(\d{2}:\d{2})/i);
            if (depTimeMatch) departureTime = depTimeMatch[1];

            const arrTimeMatch = segmentText.match(/Arrive:\s*\t*(\d{2}:\d{2})/i) ||
                              segmentText.match(/Arrive:\s*(\d{2}:\d{2})/i);
            if (arrTimeMatch) arrivalTime = arrTimeMatch[1];

            // Extract seat number - Loganair specific
            let seat = '';
            const seatMatch = segmentText.match(/Seat:\s*([0-9]{1,2}[A-K])\b/i) || 
                              emailText.match(/Seat:\s*(?:\n|\r|\s)*[A-Z0-9\/s]+(?:\n|\r|\s)*([0-9]{1,2}[A-K])\b/i);
            if (seatMatch) {
                seat = seatMatch[1].toUpperCase();
            } else {
                // Loganair seats listed in table format
                const seatListMatch = emailText.match(/\b([0-9]{1,2}[A-K])\s*\n\s*[0-9]{1,2}[A-K]\b/) ||
                                      emailText.match(/\b([0-9]{1,2}[A-K])\s+Small cabin bag/i);
                if (seatListMatch) {
                    seat = seatListMatch[1].toUpperCase();
                }
            }

            flights.push({
                flightNumber: fNumObj.number,
                departure: departure,
                arrival: arrival,
                date: date,
                departureTime: departureTime,
                arrivalTime: arrivalTime,
                bookingRef: bookingRef,
                cost: totalCost,
                seat: seat
            });
        });

        // To comply with standard single-flight details interface if only 1 segment
        if (flights.length === 1) {
            return flights[0];
        }

        // Return the array - the parsing loop handles this beautifully
        return flights;
    }

    formatDateForInput(dateString) {
        const date = new Date(dateString);
        if (!isNaN(date.getTime())) return date.toISOString().split('T')[0];
        return '';
    }

    parseEmailDateToISO(dateString) {
        if (!dateString) return null;
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return null;
        return date.toISOString().split('T')[0];
    }

    displayParsedFlight(flight) {
        const parsedDiv = document.getElementById('parsed-flight');
        const hasData = flight.flightNumber || flight.date || flight.departure;
        if (!hasData) {
            parsedDiv.innerHTML = '<div class="parse-warning">⚠️ Could not extract flight details. Try checking the format of the email.</div>';
            return;
        }
        const route = flight.departure && flight.arrival ? `${flight.departure} → ${flight.arrival}` : 'Not found';
        parsedDiv.innerHTML = `
            <div class="parsed-result">
                <h4>Extracted Details</h4>
                <table class="parsed-table">
                    <tr><td>Flight</td><td><strong>${flight.flightNumber || '—'}</strong></td></tr>
                    <tr><td>Date</td><td>${flight.date || '—'}</td></tr>
                    <tr><td>Route</td><td>${route}</td></tr>
                    <tr><td>Departure</td><td>${flight.departureTime || '—'}</td></tr>
                    <tr><td>Arrival</td><td>${flight.arrivalTime || '—'}</td></tr>
                    <tr><td>Booking Ref</td><td>${flight.bookingRef || '—'}</td></tr>
                    <tr><td>Price</td><td>${flight.cost ? '£' + flight.cost : '—'}</td></tr>
                </table>
                <button id="add-parsed-booking">➕ Add to Bookings</button>
            </div>`;
        document.getElementById('add-parsed-booking').addEventListener('click', () => {
            this.switchSection('bookings');
            this.showBookingForm({
                id: null,
                flightNumber: flight.flightNumber,
                route: route !== 'Not found' ? route : '',
                date: flight.date,
                departureTime: flight.departureTime,
                arrivalTime: flight.arrivalTime,
                pricePaid: flight.cost ? parseFloat(flight.cost) : 0,
                bookingRef: flight.bookingRef,
                notes: ''
            });
        });
    }

    // ─── Testing ───────────────────────────────────────────────────────────────

    testLoganairParsing() {
        const loganairEmail = `Loganair
Loganair Cabin Crew
Mrs Payne,
Thank you for choosing to fly with Loganair.
We know you have a choice of travel options and thank you for choosing Loganair – we look forward to welcoming you on board soon.
Booking reference: 	AJLPPR
Icon	Flight LM0046
Bristol
To:
Aberdeen
Fare type:  Fly Flex
Date:	14 Jun 26
Depart:	19:55
Arrive:	21:25
Icon	Flight LM0045
Aberdeen
To:
Bristol
Fare type:  Fly Flex
Date:	18 Jun 26
Depart:	17:55
Arrive:	19:25
Traveller(s)
PAYNE/JENNIFERMRS
Flight(s):
Seat:
E–ticket:
LM0046
LM0045
11F
11F
682 2305632697/1
682 2305632697/2`;

        console.log('=== Testing Loganair Email Parsing ===');
        const result = this.extractLoganairDetails(loganairEmail);
        console.log('Parsing result:', JSON.stringify(result, null, 2));
        
        if (Array.isArray(result)) {
            console.log(`Found ${result.length} flight segments:`);
            result.forEach((flight, i) => {
                console.log(`Flight ${i + 1}: ${flight.flightNumber} ${flight.departure} → ${flight.arrival} on ${flight.date} (${flight.departureTime}-${flight.arrivalTime})`);
            });
        } else {
            console.log(`Single flight: ${result.flightNumber} ${result.departure} → ${result.arrival} on ${result.date}`);
        }
        
        return result;
    }

    // ─── Settings ──────────────────────────────────────────────────────────────

    async saveSupabaseSettings() {
        const url = document.getElementById('supabase-url').value.trim();
        const key = document.getElementById('supabase-key').value.trim();
        if (!url || !key) { this.showErrorMessage('Please enter both URL and key'); return; }
        await credentialManager.set('sb-url', url);
        await credentialManager.set('sb-key', key);
        await this.initSupabase();
        if (this.useSupabase) {
            await this.loadAllData();
            this.renderWeekTable();
            this.updateDashboard();
            this.renderBookings();
            this.showSuccessMessage('Connected to Supabase!');
        } else {
            this.showErrorMessage('Connection failed — check URL and key');
        }
    }

    async testSupabaseSettings() {
        const url = document.getElementById('supabase-url').value.trim();
        const key = document.getElementById('supabase-key').value.trim();
        const statusDiv = document.getElementById('db-status');
        statusDiv.textContent = 'Testing...';
        statusDiv.className = 'api-status-display';
        try {
            const testClient = supabase.createClient(url || SUPABASE_URL_DEFAULT, key || SUPABASE_KEY_DEFAULT);
            const { error } = await testClient.from('expenses').select('id').limit(1);
            if (error) throw error;
            statusDiv.textContent = '✅ Connection successful!';
            statusDiv.className = 'api-status-display success';
        } catch (e) {
            statusDiv.textContent = `❌ Failed: ${e.message}`;
            statusDiv.className = 'api-status-display error';
        }
    }

    // ─── Notifications ─────────────────────────────────────────────────────────

    showSuccessMessage(message) {
        this._toast(message, '#28a745');
    }

    showErrorMessage(message) {
        this._toast(message, '#dc3545');
    }

    _toast(message, bg) {
        const div = document.createElement('div');
        div.textContent = message;
        div.style.cssText = `position:fixed;top:20px;right:20px;background:${bg};color:white;padding:1rem 1.5rem;border-radius:8px;box-shadow:0 4px 15px rgba(0,0,0,.2);z-index:1000;font-weight:500;`;
        document.body.appendChild(div);
        setTimeout(() => div.remove(), 3000);
    }
}

const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn { from { transform:translateX(100%); opacity:0; } to { transform:translateX(0); opacity:1; } }
    @keyframes slideOut { from { transform:translateX(0); opacity:1; } to { transform:translateX(100%); opacity:0; } }
`;
document.head.appendChild(style);

const app = new OrangeContractApp();

