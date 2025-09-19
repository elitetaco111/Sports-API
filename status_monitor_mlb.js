// Runs every 30s, detects games going from InProgress -> Final, records winner,
// then re-verifies for 2 minutes to catch late scoring corrections.
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

const POLL_INTERVAL_MS = 30_000;     // 30 seconds
const VERIFY_WINDOW_MS = 120_000;    // 2 minutes

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
  return [today];
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      lastStatusByGameId: parsed.lastStatusByGameId ?? {},
      seenWinners: parsed.seenWinners ?? {},
      verifying: parsed.verifying ?? {} // { [gameId]: { startedAtMs, baseline: {homeRuns, awayRuns, winnerTeam} } }
    };
  } catch {
    return { lastStatusByGameId: {}, seenWinners: {}, verifying: {} };
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

async function logLine(entry) {
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
  if (homeRuns === awayRuns) return null; // safety
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

function winnersEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.homeRuns === b.homeRuns &&
         a.awayRuns === b.awayRuns &&
         a.winnerTeam === b.winnerTeam &&
         a.loserTeam === b.loserTeam;
}

async function tick(state) {
  const nowMs = Date.now();
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
      const firstSeenFinal = !prev && isFinal(currStatus);

      if ((transitioned || firstSeenFinal) && !state.seenWinners[id]) {
        const winner = computeWinner(g);
        const entry = {
          type: 'final',
          ts: new Date().toISOString(),
          date,
          gameId: id,
          statusFrom: prevStatus ?? null,
          statusTo: currStatus,
          ...winner
        };
        await logLine(entry);
        state.seenWinners[id] = true;

        // Start verification window
        state.verifying[id] = {
          startedAtMs: nowMs,
          baseline: winner
        };

        console.log(`Winner recorded: ${entry.winnerTeam} over ${entry.loserTeam} (${entry.awayTeam} ${entry.awayRuns} @ ${entry.homeTeam} ${entry.homeRuns})`);
      }

      // If in verification window, compare against baseline and extend/reset if changed
      if (state.verifying[id]) {
        const current = computeWinner(g);
        const baseline = state.verifying[id].baseline;

        // If winner or runs changed, log a correction and extend window
        if (!winnersEqual(current, baseline)) {
          const correction = {
            type: 'correction',
            ts: new Date().toISOString(),
            date,
            gameId: id,
            status: currStatus,
            from: baseline,
            to: current
          };
          await logLine(correction);
          state.verifying[id].baseline = current;
          state.verifying[id].startedAtMs = nowMs; // extend 2 minutes from last change
          console.log(`Correction detected for Game ${id}:`, correction);
        }

        // End verification if window elapsed without changes
        if (nowMs - state.verifying[id].startedAtMs >= VERIFY_WINDOW_MS) {
          // Optional: log verification completion
          await logLine({
            type: 'verified',
            ts: new Date().toISOString(),
            date,
            gameId: id,
            final: state.verifying[id].baseline
          });
          delete state.verifying[id];
          console.log(`Winner verified for Game ${id}.`);
        }
      }
    }
  }

  await saveState(state);
}

function msUntilNextInterval(periodMs) {
  const now = Date.now();
  return periodMs - (now % periodMs);
}

async function main() {
  await ensureDataDir();
  const state = await loadState();

  // Align to next 30s boundary
  setTimeout(() => {
    tick(state).catch(err => console.error('Tick error:', err));
    setInterval(() => {
      tick(state).catch(err => console.error('Tick error:', err));
    }, POLL_INTERVAL_MS);
  }, msUntilNextInterval(POLL_INTERVAL_MS));

  console.log(`MLB monitor started. Polling every ${POLL_INTERVAL_MS / 1000}s with a ${VERIFY_WINDOW_MS / 1000}s verification window.`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});