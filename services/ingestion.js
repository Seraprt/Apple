// services/ingestion.js
const axios = require('axios');
const Team = require('../models/Teams');
const Match = require('../models/Match');
const { normalizeLeague } = require('./leagues');

const FOOTBALL_API = 'https://api.football-data.org/v4';

const COMPETITION_TO_SPORT_KEY = {
  PL: 'soccer_epl',
  PD: 'soccer_spain_la_liga',
  BL1: 'soccer_germany_bundesliga',
  SA: 'soccer_italy_serie_a',
  FL1: 'soccer_france_ligue_1',
  DED: 'soccer_netherlands_eredivisie',
  PPL: 'soccer_portugal_primeira_liga',
  ELC: 'soccer_england_championship',
  BSA: 'soccer_brazil_campeonato',
  CL: 'soccer_uefa_champions_league',
  EL: 'soccer_uefa_europa_league',
  WC: 'soccer_fifa_world_cup',
  EC: 'soccer_uefa_euro',
};

const LEAGUE_AVG_HOME = 1.35;
const LEAGUE_AVG_AWAY = 1.05;

// Learning rates
const ALPHA_ATK = 0.18;   // attack reacts faster
const ALPHA_DEF = 0.14;   // defence is more stable
const PPG_ALPHA = 0.15;
const K_ELO = 28;

const PAST_DAYS = parseInt(process.env.INGEST_PAST_DAYS || '2000', 10);
const PAST_CHUNK_DAYS = 10;
const FUTURE_DAYS = 20;
const FUTURE_CHUNK_DAYS = 7;
const REQUEST_DELAY_MS = 6500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// ── Team create / update helper ──
async function getOrCreateTeam(teamData, competitionName) {
  const name = teamData.name;
  if (!name) return null;

  const crest = teamData.crest || '';
  const short = (teamData.tla || teamData.shortName || name.slice(0, 3))
    .toUpperCase()
    .slice(0, 3);
  const normalizedLeague = normalizeLeague(competitionName);

  let team = await Team.findOne({ name });
  if (!team) {
    team = await Team.create({
      name,
      short,
      logo: crest,
      league: normalizedLeague,
      // Overall (kept for backward compatibility)
      attack_rating: 1.0,
      defence_rating: 1.0,
      // New home / away splits
      attack_rating_home: 1.0,
      attack_rating_away: 1.0,
      defence_rating_home: 1.0,
      defence_rating_away: 1.0,
      elo_rating: 1500,
      home_ppg: 1.5,
      away_ppg: 1.0,
      strength: 50,
      external_id: String(teamData.id || ''),
    });
  } else {
    const updates = {};
    if (crest && !team.logo) updates.logo = crest;
    if (short && !team.short) updates.short = short;
    if (normalizedLeague) updates.league = normalizedLeague;

    // Backfill missing home/away ratings for older teams
    if (team.attack_rating_home == null) updates.attack_rating_home = team.attack_rating || 1.0;
    if (team.attack_rating_away == null) updates.attack_rating_away = team.attack_rating || 1.0;
    if (team.defence_rating_home == null) updates.defence_rating_home = team.defence_rating || 1.0;
    if (team.defence_rating_away == null) updates.defence_rating_away = team.defence_rating || 1.0;

    if (Object.keys(updates).length) {
      await Team.updateOne({ _id: team._id }, { $set: updates });
      Object.assign(team, updates);
    }
  }
  return team;
}

// ── Smarter rating update (opponent-adjusted + home/away split) ──
async function updateRatings(home, away, homeGoals, awayGoals) {
  // Safety
  const hAtkH = home.attack_rating_home ?? home.attack_rating ?? 1.0;
  const hDefH = home.defence_rating_home ?? home.defence_rating ?? 1.0;
  const aAtkA = away.attack_rating_away ?? away.attack_rating ?? 1.0;
  const aDefA = away.defence_rating_away ?? away.defence_rating ?? 1.0;

  // Opponent-adjusted observed performance
  // Higher opponent defence → harder to score → bigger credit when you do
  const homeObsAttack  = (homeGoals / LEAGUE_AVG_HOME) / Math.max(0.4, aDefA);
  const awayObsAttack  = (awayGoals / LEAGUE_AVG_AWAY) / Math.max(0.4, hDefH);
  const homeObsDefence = (awayGoals / LEAGUE_AVG_HOME) / Math.max(0.4, aAtkA);
  const awayObsDefence = (homeGoals / LEAGUE_AVG_AWAY) / Math.max(0.4, hAtkH);

  // Update home team's HOME ratings
  const newHomeAtkHome = clamp(hAtkH * (1 - ALPHA_ATK) + homeObsAttack * ALPHA_ATK, 0.30, 2.70);
  const newHomeDefHome = clamp(hDefH * (1 - ALPHA_DEF) + homeObsDefence * ALPHA_DEF, 0.30, 2.70);

  // Update away team's AWAY ratings
  const newAwayAtkAway = clamp(aAtkA * (1 - ALPHA_ATK) + awayObsAttack * ALPHA_ATK, 0.30, 2.70);
  const newAwayDefAway = clamp(aDefA * (1 - ALPHA_DEF) + awayObsDefence * ALPHA_DEF, 0.30, 2.70);

  // Overall ratings = blend of home + away (kept for compatibility)
  const newHomeAttack  = clamp((newHomeAtkHome + (home.attack_rating_away ?? 1.0)) / 2, 0.30, 2.70);
  const newHomeDefence = clamp((newHomeDefHome + (home.defence_rating_away ?? 1.0)) / 2, 0.30, 2.70);
  const newAwayAttack  = clamp(((away.attack_rating_home ?? 1.0) + newAwayAtkAway) / 2, 0.30, 2.70);
  const newAwayDefence = clamp(((away.defence_rating_home ?? 1.0) + newAwayDefAway) / 2, 0.30, 2.70);

  // ELO
  const expHome = 1 / (1 + Math.pow(10, (away.elo_rating - home.elo_rating) / 400));
  const homeResult = homeGoals > awayGoals ? 1 : homeGoals === awayGoals ? 0.5 : 0;
  const newHomeElo = home.elo_rating + K_ELO * (homeResult - expHome);
  const newAwayElo = away.elo_rating + K_ELO * ((1 - homeResult) - (1 - expHome));

  // PPG
  const homePts = homeGoals > awayGoals ? 3 : homeGoals === awayGoals ? 1 : 0;
  const awayPts = 3 - homePts;
  const newHomePpg = clamp(home.home_ppg * (1 - PPG_ALPHA) + homePts * PPG_ALPHA, 0, 3);
  const newAwayPpg = clamp(away.away_ppg * (1 - PPG_ALPHA) + awayPts * PPG_ALPHA, 0, 3);

  await Team.updateOne(
    { _id: home._id },
    {
      $set: {
        attack_rating: newHomeAttack,
        defence_rating: newHomeDefence,
        attack_rating_home: newHomeAtkHome,
        defence_rating_home: newHomeDefHome,
        elo_rating: newHomeElo,
        home_ppg: newHomePpg,
      },
    }
  );

  await Team.updateOne(
    { _id: away._id },
    {
      $set: {
        attack_rating: newAwayAttack,
        defence_rating: newAwayDefence,
        attack_rating_away: newAwayAtkAway,
        defence_rating_away: newAwayDefAway,
        elo_rating: newAwayElo,
        away_ppg: newAwayPpg,
      },
    }
  );
}

// ── Fetch with retry ──
async function fetchRange(dateFrom, dateTo, attempt = 0) {
  const url = `${FOOTBALL_API}/matches`;
  const headers = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };
  try {
    const { data } = await axios.get(url, {
      headers,
      params: { dateFrom, dateTo },
      timeout: 30000,
    });
    return data.matches || [];
  } catch (err) {
    const status = err.response?.status;
    if (status === 429 && attempt < 3) {
      const wait = 15000 * (attempt + 1);
      console.warn(`Rate limit hit. Retry in ${wait / 1000}s...`);
      await sleep(wait);
      return fetchRange(dateFrom, dateTo, attempt + 1);
    }
    console.error(`fetch error [${dateFrom} → ${dateTo}]: ${status || err.message}`);
    return [];
  }
}

// ── Store matches ──
async function storeMatches(matches) {
  let stored = 0;

  for (const m of matches) {
    if (!m.homeTeam?.name || !m.awayTeam?.name) continue;

    const competitionName = m.competition?.name || 'Unknown';
    const home = await getOrCreateTeam(m.homeTeam, competitionName);
    const away = await getOrCreateTeam(m.awayTeam, competitionName);
    if (!home || !away) continue;

    const eventId = String(m.id);
    const date = new Date(m.utcDate);
    const finished = m.status === 'FINISHED';
    const homeGoals = finished ? m.score.fullTime.home : null;
    const awayGoals = finished ? m.score.fullTime.away : null;

    const existing = await Match.findOne({ event_id: eventId });

    if (!existing) {
      await Match.create({
        event_id: eventId,
        home_team_id: home._id,
        away_team_id: away._id,
        date,
        tournament: competitionName,
        stage: m.stage || 'group',
        home_goals: homeGoals,
        away_goals: awayGoals,
      });

      if (finished && homeGoals !== null && awayGoals !== null) {
        await updateRatings(home, away, homeGoals, awayGoals);
      }
    } else if (finished && existing.home_goals === null) {
      existing.home_goals = homeGoals;
      existing.away_goals = awayGoals;
      await existing.save();
      await updateRatings(home, away, homeGoals, awayGoals);
    }

    stored++;
  }
  return stored;
}

// ── Main ingestion ──
async function runIngestion() {
  console.log(`🚀 Formline ingestion started — past ${PAST_DAYS} days`);
  const now = new Date();
  let total = 0;

  const pastChunks = Math.ceil(PAST_DAYS / PAST_CHUNK_DAYS);
  const futureChunks = Math.ceil(FUTURE_DAYS / FUTURE_CHUNK_DAYS);
  const totalChunks = pastChunks + futureChunks;
  const estMinutes = ((totalChunks * REQUEST_DELAY_MS) / 60000).toFixed(1);

  console.log(`📊 ${totalChunks} chunks total — estimated ~${estMinutes} minutes`);

  // Past
  for (let i = 0; i < PAST_DAYS; i += PAST_CHUNK_DAYS) {
    const start = new Date(now.getTime() - (PAST_DAYS - i) * 86400000);
    const end = new Date(start.getTime() + PAST_CHUNK_DAYS * 86400000);
    const df = start.toISOString().slice(0, 10);
    const dt = end.toISOString().slice(0, 10);

    const chunkNum = Math.floor(i / PAST_CHUNK_DAYS) + 1;
    console.log(`  [${chunkNum}/${totalChunks}] Past ${df} → ${dt}`);

    const matches = await fetchRange(df, dt);
    const stored = await storeMatches(matches);
    total += stored;
    console.log(`      stored/updated ${stored}`);
    await sleep(REQUEST_DELAY_MS);
  }

  // Future
  for (let i = 0; i < FUTURE_DAYS; i += FUTURE_CHUNK_DAYS) {
    const start = new Date(now.getTime() + i * 86400000);
    const end = new Date(start.getTime() + FUTURE_CHUNK_DAYS * 86400000);
    const df = start.toISOString().slice(0, 10);
    const dt = end.toISOString().slice(0, 10);

    const chunkNum = Math.floor((PAST_DAYS + i) / PAST_CHUNK_DAYS) + 1;
    console.log(`  [${chunkNum}/${totalChunks}] Future ${df} → ${dt}`);

    const matches = await fetchRange(df, dt);
    const stored = await storeMatches(matches);
    total += stored;
    console.log(`      stored/updated ${stored}`);
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`✅ Ingestion done. ${total} matches stored/updated.`);
  return total;
}

module.exports = { runIngestion };