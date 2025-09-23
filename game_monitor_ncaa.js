/* NCAA Final monitor for SportsDataIO (Games by Date - Live & Final)
   Env:
     - SPORTSDATAIO_API_KEY: your SportsDataIO key
     - MONITOR_DATE (optional): date to monitor (YYYY-MM-DD or YYYY-MMM-DD)
     - POLL_INTERVAL_MS (optional): default 30000
*/
const fs = require('fs');
const path = require('path');
const https = require('https');

const API_KEY = process.env.SPORTSDATAIO_API_KEY;
if (!API_KEY) {
  console.error('Missing env SPORTSDATAIO_API_KEY.');
  process.exit(1);
}

const monitorDateInput = process.env.MONITOR_DATE || process.argv[2] || new Date().toISOString().slice(0, 10);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);

function toApiDate(d) {
  // Accept YYYY-MM-DD or already MMM form; convert to YYYY-MMM-DD (MMM=JAN..DEC)
  if (/[A-Za-z]/.test(d)) return d.toUpperCase();
  const dt = new Date(d + 'T00:00:00Z');
  if (isNaN(dt)) return d;
  const y = dt.getUTCFullYear();
  const mIdx = dt.getUTCMonth();
  const day = String(dt.getUTCDate()).padStart(2, '0');
  const MMM = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][mIdx];
  return `${y}-${MMM}-${day}`;
}

const monitorDateForApi = toApiDate(monitorDateInput);

// Load team context (TeamID -> { GlobalTeamID, Name, School, Key, ShortDisplayName })
const teamsPath = path.resolve(__dirname, 'sportsdataio_teams.json');
let teams = [];
try {
  teams = JSON.parse(fs.readFileSync(teamsPath, 'utf8'));
} catch (e) {
  console.error('Failed to read sportsdataio_teams.json:', e.message);
  process.exit(1);
}

const teamById = new Map();
const teamByKey = new Map();
for (const t of teams) {
  if (t.TeamID != null) teamById.set(Number(t.TeamID), t);
  if (t.Key) teamByKey.set(String(t.Key).toUpperCase(), t);
}

function getTeamInfoFromGame(game, side /* 'Home' | 'Away' */) {
  const id = game[`${side}TeamID`];
  const key = game[`${side}Team`];
  let t = undefined;
  if (id != null) t = teamById.get(Number(id));
  if (!t && key) t = teamByKey.get(String(key).toUpperCase());
  return {
    id: id ?? (t ? t.TeamID : undefined),
    key: key ?? (t ? t.Key : undefined),
    name: (t && (t.School || t.ShortDisplayName || t.Name)) || key || String(id || ''),
    globalTeamId: t ? t.GlobalTeamID : undefined,
  };
}

function isFinalStatus(status) {
  if (!status) return false;
  const s = String(status).toUpperCase();
  return s.includes('FINAL') || s === 'F/OT';
}

function nowIso() {
  return new Date().toISOString();
}

const processedFinals = new Set(); // game identity we've announced

function gameIdentity(g) {
  return g.GameID ?? g.GlobalGameID ?? `${g.Season}-${g.Week}-${g.AwayTeam}-${g.HomeTeam}-${g.Day || g.DateTime || ''}`;
}

function fetchGamesByDate(dateStr) {
  // NCAA CFB endpoint
  // const url = `https://api.sportsdata.io/v3/cfb/scores/json/GamesByDate/${encodeURIComponent(dateStr)}`;
  const url = `https://replay.sportsdata.io/api/v3/cfb/scores/json/gamesbydate/2023-12-02?key=${API_KEY}`;
  const opts = {
    headers: { 'Ocp-Apim-Subscription-Key': API_KEY },
    timeout: 15000,
    agent: new https.Agent({ keepAlive: true }),
  };
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers: opts.headers, agent: opts.agent }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const json = JSON.parse(data || '[]');
            resolve(json);
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout, () => {
      req.destroy(new Error('Request timeout'));
    });
    req.end();
  });
}

function renderScoreLine(game) {
  const away = getTeamInfoFromGame(game, 'Away');
  const home = getTeamInfoFromGame(game, 'Home');
  const as = game.AwayTeamScore ?? game.AwayScore ?? game.ScoreAway ?? 0;
  const hs = game.HomeTeamScore ?? game.HomeScore ?? game.ScoreHome ?? 0;
  return {
    text: `${away.name} ${as} @ ${home.name} ${hs}`,
    away, home, as, hs,
  };
}

function announceFinal(game) {
  const id = gameIdentity(game);
  if (processedFinals.has(id)) return;

  const status = game.Status || game.GameStatus || '';
  if (!isFinalStatus(status)) return;

  processedFinals.add(id);

  const { text, away, home, as, hs } = renderScoreLine(game);

  console.log(`[FINAL] ${text}`);
  console.log(`Teams: ${away.name} (GlobalTeamID: ${away.globalTeamId ?? 'N/A'}) vs ${home.name} (GlobalTeamID: ${home.globalTeamId ?? 'N/A'})`);

  let winner = null, loser = null;
  if (as > hs) {
    winner = away; loser = home;
  } else if (hs > as) {
    winner = home; loser = away;
  } else {
    console.log(`Result: Tie detected. Timestamp: ${nowIso()}`);
    return;
  }

  console.log(`Winner: ${winner.name} (GlobalTeamID: ${winner.globalTeamId ?? 'N/A'}) | Loser: ${loser.name} (GlobalTeamID: ${loser.globalTeamId ?? 'N/A'}) | Score: ${Math.max(as, hs)}-${Math.min(as, hs)} | Timestamp: ${nowIso()}`);
}

async function pollLoop() {
  console.log(`Monitoring NCAA games for ${monitorDateForApi} every ${POLL_INTERVAL_MS}ms...`);
  let backoff = 0;
  while (true) {
    try {
      const games = await fetchGamesByDate(monitorDateForApi);
      for (const g of Array.isArray(games) ? games : []) {
        announceFinal(g);
      }
      backoff = 0; // reset on success
    } catch (err) {
      backoff = Math.min((backoff || 1000) * 2, 30000);
      console.error(`[${nowIso()}] Poll error: ${err.message}. Backing off ${backoff}ms.`);
      await new Promise(r => setTimeout(r, backoff));
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

process.on('SIGINT', () => {
  console.log('\nStopping monitor...');
  process.exit(0);
});

pollLoop().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});