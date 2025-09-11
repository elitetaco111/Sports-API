// Runs every minute, detects games going from InProgress -> Final, records winner.
// Requires Node 18+ (global fetch). Set env: $env:SPORTSDATAIO_API_KEY="your_api_key_here"

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs/promises');
const path = require('path');

const API_KEY = process.env.SPORTSDATAIO_API_KEY;
if (!API_KEY) {
  console.error('Missing SPORTSDATAIO_API_KEY environment variable.');
  console.error('PowerShell example:  $env:SPORTSDATAIO_API_KEY="your_api_key_here"');
  process.exit(1);
}

const BASE_URL = 'https://api.sportsdata.io/v3/mlb/scores/json';
const DATA_DIR = path.join(__dirname, 'data');
const STATE_PATH = path.join(DATA_DIR, 'games-state.json');
const WINNERS_LOG = path.join(DATA_DIR, 'winners.jsonl');

const FINAL_STATUSES = ['final', 'final/over', 'complete', 'completed'];
function isFinal(status) {
  if (!status) return false;
  const s = String(status).toLowerCase();
  return FINAL_STATUSES.some(f => s.includes(f)) || s === 'f';
}
function isInProgress(status) {
  if (!status) return false;
  const s = String(status).toLowerCase();
  return s.includes('inprogress') || s.includes('in progress') || s === 'live';
}
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function datesToWatch(now = new Date()) {
  // Watch today. Also watch yesterday before 12:00 local to catch overnight finals.
  const today = fmtDate(now);
  if (now.getHours() < 12) {
    const yd = new Date(now);
    yd.setDate(yd.getDate() - 1);
    return [fmtDate(yd), today];
  }
  return [today];
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { lastStatusByGameId: {}, seenWinners: {} };
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

async function logWinner(entry) {
  const line = JSON.stringify(entry);
  await fs.appendFile(WINNERS_LOG, line + '\n', 'utf8');
}

async function fetchScoresByDate(date, attempt = 1) {
  const url = `${BASE_URL}/ScoresBasic/${date}`;
  const resp = await fetch(url, {
    headers: { 'Ocp-Apim-Subscription-Key': API_KEY }
  });

  if (resp.status === 429 && attempt <= 5) {
    const delay = Math.min(15000, 500 * Math.pow(2, attempt)); // backoff up to 15s
    await new Promise(r => setTimeout(r, delay));
    return fetchScoresByDate(date, attempt + 1);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status} ${resp.statusText} (${date}) - ${text}`);
  }
  return resp.json();
}

function computeWinner(game) {
  const homeRuns = game.HomeTeamRuns ?? null;
  const awayRuns = game.AwayTeamRuns ?? null;
  if (homeRuns == null || awayRuns == null) return null;
  if (homeRuns === awayRuns) return null; // rare in MLB; safety
  const winnerTeam = homeRuns > awayRuns ? game.HomeTeam : game.AwayTeam;
  const loserTeam = homeRuns > awayRuns ? game.AwayTeam : game.HomeTeam;
  return {
    winnerTeam,
    loserTeam,
    homeTeam: game.HomeTeam,
    awayTeam: game.AwayTeam,
    homeRuns,
    awayRuns
  };
}

async function tick(state) {
  const watchDates = datesToWatch();
  for (const date of watchDates) {
    let games = [];
    try {
      games = await fetchScoresByDate(date);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Fetch failed for ${date}: ${err.message}`);
      continue;
    }

    for (const g of games) {
      const id = g.GameID;
      const prev = state.lastStatusByGameId[id];
      const prevStatus = prev?.status;
      const currStatus = g.Status;

      // Always update last seen status
      state.lastStatusByGameId[id] = { status: currStatus, date };

      // Detect transition InProgress -> Final
      const transitioned = isInProgress(prevStatus) && isFinal(currStatus);

      // If we never saw it and it's already final, optionally record once
      const firstSeenFinal = !prev && isFinal(currStatus);

      if ((transitioned || firstSeenFinal) && !state.seenWinners[id]) {
        const winner = computeWinner(g);
        const entry = {
          ts: new Date().toISOString(),
          date,
          gameId: id,
          statusFrom: prevStatus ?? null,
          statusTo: currStatus,
          ...winner
        };
        await logWinner(entry);
        state.seenWinners[id] = true;
        console.log(`Winner recorded: ${entry.winnerTeam} over ${entry.loserTeam} (${entry.awayTeam} ${entry.awayRuns} @ ${entry.homeTeam} ${entry.homeRuns})`);
      }
    }
  }

  await saveState(state);
}

function msUntilNextMinute() {
  const now = Date.now();
  return 60000 - (now % 60000);
}

async function main() {
  await ensureDataDir();
  const state = await loadState();

  // Align to next minute boundary
  setTimeout(() => {
    tick(state).catch(err => console.error('Tick error:', err));
    setInterval(() => {
      tick(state).catch(err => console.error('Tick error:', err));
    }, 60_000);
  }, msUntilNextMinute());

  console.log('MLB monitor started. Polling every minute.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});