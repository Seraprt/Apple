const axios = require('axios');
const Team = require('../models/Teams');
const Match = require('../models/Match');

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
const ALPHA = 0.2;

// ── Team create/update helper ──
async function getOrCreateTeam(teamData, competitionName) {
  const name = teamData.name;
  if (!name) return null;

  const crest = teamData.crest || '';
  const short = (teamData.tla || teamData.shortName || name.slice(0, 3)).toUpperCase().slice(0, 3);

  let team = await Team.findOne({ name });
  if (!team) {
    team = await Team.create({
      name,
      short,
      logo: crest,
      league: competitionName,
      attack_rating: 1.0,
      defence_rating: 1.0,
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
    if (competitionName && !team.league) updates.league = competitionName;
    if (Object.keys(updates).length) {
      await Team.updateOne({ _id: team._id }, { $set: updates });
    }
  }
  return team;
}

// ── Update attack/defence + ELO + PPG ──
async function updateRatings(home, away, homeGoals, awayGoals) {
  // Attack / defence
  const homeObsAttack = homeGoals / LEAGUE_AVG_HOME;
  const awayObsAttack = awayGoals / LEAGUE_AVG_AWAY;
  const homeObsDefence = awayGoals / LEAGUE_AVG_HOME;
  const awayObsDefence = homeGoals / LEAGUE_AVG_AWAY;

  const newHomeAttack = Math.max(0.3, Math.min(2.5, home.attack_rating * (1 - ALPHA) + homeObsAttack * ALPHA));
  const newHomeDefence = Math.max(0.3, Math.min(2.5, home.defence_rating * (1 - ALPHA) + homeObsDefence * ALPHA));
  const newAwayAttack = Math.max(0.3, Math.min(2.5, away.attack_rating * (1 - ALPHA) + awayObsAttack * ALPHA));
  const newAwayDefence = Math.max(0.3, Math.min(2.5, away.defence_rating * (1 - ALPHA) + awayObsDefence * ALPHA));

  // ELO
  const K = 30;
  const expHome = 1 / (1 + Math.pow(10, (away.elo_rating - home.elo_rating) / 400));
  const expAway = 1 - expHome;
  const homeResult = homeGoals > awayGoals ? 1 : homeGoals === awayGoals ? 0.5 : 0;
  const awayResult = 1 - homeResult;
  const newHomeElo = home.elo_rating + K * (homeResult - expHome);
  const newAwayElo = away.elo_rating + K * (awayResult - expAway);

  // Home/away PPG
  const PPG_ALPHA = 0.15;
  const homePts = homeGoals > awayGoals ? 3 : homeGoals === awayGoals ? 1 : 0;
  const awayPts = awayGoals > homeGoals ? 3 : awayGoals === homeGoals ? 1 : 0;
  const newHomePpg = Math.max(0, Math.min(3, home.home_ppg * (1 - PPG_ALPHA) + homePts * PPG_ALPHA));
  const newAwayPpg = Math.max(0, Math.min(3, away.away_ppg * (1 - PPG_ALPHA) + awayPts * PPG_ALPHA));

  await Team.updateOne(
    { _id: home._id },
    { $set: {
      attack_rating: newHomeAttack, defence_rating: newHomeDefence,
      elo_rating: newHomeElo, home_ppg: newHomePpg,
    }}
  );
  await Team.updateOne(
    { _id: away._id },
    { $set: {
      attack_rating: newAwayAttack, defence_rating: newAwayDefence,
      elo_rating: newAwayElo, away_ppg: newAwayPpg,
    }}
  );
}

// ── Fetch matches for a date range ──
async function fetchRange(dateFrom, dateTo) {
  const url = `${FOOTBALL_API}/matches`;
  const headers = { 'X-Auth-Token': process.env.FOOTBALL_API_KEY };
  try {
    const { data } = await axios.get(url, {
      headers,
      params: { dateFrom, dateTo },
      timeout: 20000,
    });
    return data.matches || [];
  } catch (err) {
    if (err.response?.status === 429) {
      console.warn('Rate limit — waiting 10s');
      await new Promise((r) => setTimeout(r, 10000));
      return [];
    }
    console.error('fetch error:', err.message);
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
    } else if (finished && existing.home_goals === null) {
      // Update finished result
      existing.home_goals = homeGoals;
      existing.away_goals = awayGoals;
      await existing.save();
    }

    if (finished && homeGoals !== null && awayGoals !== null) {
      await updateRatings(home, away, homeGoals, awayGoals);
    }
    stored++;
  }
  return stored;
}

// ── Main ingestion ──
async function runIngestion() {
  console.log('🚀 Formline ingestion started');
  const now = new Date();
  let total = 0;

  // Past 300 days (10-day chunks)
  for (let i = 0; i < 300; i += 10) {
    const start = new Date(now.getTime() - (300 - i) * 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 10 * 24 * 60 * 60 * 1000);
    const df = start.toISOString().slice(0, 10);
    const dt = end.toISOString().slice(0, 10);
    console.log(`  Past ${df} → ${dt}`);
    const matches = await fetchRange(df, dt);
    total += await storeMatches(matches);
    await new Promise((r) => setTimeout(r, 500));
  }

  // Future 20 days (7-day chunks)
  for (let i = 0; i < 20; i += 7) {
    const start = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
    const df = start.toISOString().slice(0, 10);
    const dt = end.toISOString().slice(0, 10);
    console.log(`  Future ${df} → ${dt}`);
    const matches = await fetchRange(df, dt);
    total += await storeMatches(matches);
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`✅ Ingestion done. ${total} matches stored/updated.`);
  return total;
}

module.exports = { runIngestion };