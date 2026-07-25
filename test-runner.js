
function extractFlightDetails(emailText) {
    
        // Multi-flight extraction fallback support for Loganair/easyJet local engine
        const flights = [];
        
        // 1. Extract common fields
        let bookingRef = '';
        // Handle Loganair format: "Booking reference: 	AJLPPR" (with tab)
        const bookingRefMatch = emailText.match(/bookings*(?:reference|ref|number)?[:s#t]*([A-Z0-9]{6,7})/i);
        if (bookingRefMatch) {
            bookingRef = bookingRefMatch[1].toUpperCase();
        } else {
            // Fallback: look for standalone 6-7 char alphanumeric codes
            const refMatch = emailText.match(/([A-Z0-9]{6,7})/g);
            if (refMatch) {
                const found = refMatch.find(ref => !ref.match(/^d+$/) && !ref.match(/^[A-Za-z]+$/) && (ref.length === 6 || ref.length === 7));
                if (found) bookingRef = found.toUpperCase();
            }
        }

        let totalCost = '';
        const costMatch = emailText.match(/Totals*(?:GBP)?s*£?(d+(?:.d{2})?)/i) || emailText.match(/£s*(d+(?:.d{2})?)/);
        if (costMatch) totalCost = costMatch[1];

        // 2. Discover all flight segments by searching for Flight Numbers (e.g. LM0046, EZY123)
        const flightNumRegex = /((?:EZY|U2|LM)s*d{3,4})/ig;
        const flightNumbers = [];
        let match;
        while ((match = flightNumRegex.exec(emailText)) !== null) {
            flightNumbers.push({
                number: match[1].replace(/s+/g, '').toUpperCase(),
                index: match.index
            });
        }

        // If no flight numbers found, fallback to standard parsing logic for single segment
        if (flightNumbers.length === 0) {
            const flight = { flightNumber: 'Booking', date: '', departure: '', arrival: '', departureTime: '', arrivalTime: '', bookingRef: bookingRef, cost: totalCost };
            
            // Try to find a date
            const dateMatch = emailText.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)s+(d{1,2})s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)s+(d{4}|d{2})/i);
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

            // Clean lookback route matching (Loganair style: Bristol \n To: \n Aberdeen with tabs)
            const routeMatch = lookbackText.match(/([A-Z][a-z]+)(?:\s*\n\s*\t*\s*To:\s*\n\s*\t*\s*)([A-Z][a-z]+)/i) ||
                               lookbackText.match(/([A-Z][a-z]+)s*(?:\n|\r|\s)*To:?s*(?:\n|\r|\s)*([A-Z][a-z]+)/i) ||
                               lookbackText.match(/([A-Z][a-z]+)s*(?:to|→)s*([A-Z][a-z]+)/i);

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
                              segmentText.match(/Date:\t*(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2})/i) ||
                              emailText.substring(currentIdx - 100 < 0 ? 0 : currentIdx - 100, currentIdx).match(/Date:\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4}|\d{2})/i) ||
                              emailText.substring(currentIdx - 100 < 0 ? 0 : currentIdx - 100, currentIdx).match(/Date:\t*(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2})/i);
            
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

            const depTimeMatch = segmentText.match(/Depart:\s*(\d{2}:\d{2})/i) ||
                              segmentText.match(/Depart:\t*(\d{2}:\d{2})/i);
            if (depTimeMatch) departureTime = depTimeMatch[1];

            const arrTimeMatch = segmentText.match(/Arrive:\s*(\d{2}:\d{2})/i) ||
                              segmentText.match(/Arrive:\t*(\d{2}:\d{2})/i);
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
                cost: i === 0 ? totalCost : '',
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

function testLoganairParsing() {
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
    const result = extractFlightDetails(loganairEmail);
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

testLoganairParsing();
