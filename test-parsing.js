// Simple test for Loganair parsing
const fs = require('fs');

// Read the main script
const script = fs.readFileSync('script.js', 'utf8');

// Extract just the extractFlightDetails method
const methodMatch = script.match(/extractFlightDetails\(emailText\) \{[\s\S]*?return flights;\s*\}/);
if (!methodMatch) {
    console.error('Could not find extractFlightDetails method');
    process.exit(1);
}

// Create a test function
const testCode = `
function extractFlightDetails(emailText) {
    ${methodMatch[0].replace('extractFlightDetails(emailText) {', '').replace(/return flights;\s*\}$/, '')}
    return flights;
}

function testLoganairParsing() {
    const loganairEmail = \`Loganair
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
682 2305632697/2\`;

    console.log('=== Testing Loganair Email Parsing ===');
    const result = extractFlightDetails(loganairEmail);
    console.log('Parsing result:', JSON.stringify(result, null, 2));
    
    if (Array.isArray(result)) {
        console.log(\`Found \${result.length} flight segments:\`);
        result.forEach((flight, i) => {
            console.log(\`Flight \${i + 1}: \${flight.flightNumber} \${flight.departure} → \${flight.arrival} on \${flight.date} (\${flight.departureTime}-\${flight.arrivalTime})\`);
        });
    } else {
        console.log(\`Single flight: \${result.flightNumber} \${result.departure} → \${result.arrival} on \${result.date}\`);
    }
    
    return result;
}

testLoganairParsing();
`;

fs.writeFileSync('test-runner.js', testCode);
console.log('Test file created. Running test...');
