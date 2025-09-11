// Fetch all MLB team profiles from SportsDataIO

// Load environment variables (optional if you create a .env file)
try {
  require('dotenv').config();
} catch (_) { /* dotenv optional */ }

const API_KEY = process.env.SPORTSDATAIO_API_KEY; // Set this in your environment
if (!API_KEY) {
  console.error('Missing SPORTSDATAIO_API_KEY environment variable.');
  console.error('PowerShell example:  $env:SPORTSDATAIO_API_KEY="your_api_key_here"');
  process.exit(1);
}

const ENDPOINT = 'https://api.sportsdata.io/v3/mlb/scores/json/AllTeams?key=' + API_KEY;

async function fetchAllTeamProfiles() {
  try {
    const resp = await fetch(ENDPOINT, {
      headers: {
        'Ocp-Apim-Subscription-Key': API_KEY
      }
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HTTP ${resp.status} ${resp.statusText} - ${text}`);
    }

    const data = await resp.json();

    console.log(`Fetched ${data.length} team profiles.`);
    // Example: list team + League + Division
    for (const t of data) {
      console.log(`${t.TeamID}: ${t.City} ${t.Name} | ${t.League} ${t.Division} ${t.GlobalTeamID}`);
    }

    // If you want to inspect full object of first team:
    // console.dir(data[0], { depth: 4 });

    return data;
  } catch (err) {
    console.error('Error fetching team profiles:', err.message);
    process.exitCode = 1;
  }
}

fetchAllTeamProfiles();