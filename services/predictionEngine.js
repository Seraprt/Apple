// ══════════════════════════════════════════════
// services/predictionEngine.js
// Port of the Python engine's predict() + league tier awareness
// ══════════════════════════════════════════════

const {
  computeMatchFactors,
  getWeatherMultiplier,
  getTierFactor,
} = require('./factors');

// ───── Same weights as Python ─────
const WEIGHTS = {
  form: 0.20,
  strength: 0.15,
  availability: 0.15,
  tournament: 0.05,
  coach: 0.05,
  home_away: 0.10,
  h2h: 0.05,
  weather: 0.05,
  fatigue: 0.10,
  news: 0.10,
};

const LEAGUE_AVG_HOME = 1.35;
const LEAGUE_AVG_AWAY = 1.05;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ══════════════════════════════════════════════
// Poisson helpers
// ══════════════════════════════════════════════
function poissonPmf(k, lambda) {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

function poissonCdf(k, lambda) {
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += poissonPmf(i, lambda);
  return sum;
}

// ══════════════════════════════════════════════
// xG from attack/defence ratings + league tier adjustment
// ══════════════════════════════════════════════
function computeXg(homeTeam, awayTeam, weatherMult = 1.0) {
  const homeAttack = homeTeam.attack_rating ?? 1.0;
  const homeDefence = homeTeam.defence_rating ?? 1.0;
  const awayAttack = awayTeam.attack_rating ?? 1.0;
  const awayDefence = awayTeam.defence_rating ?? 1.0;

  let homeXg = LEAGUE_AVG_HOME * homeAttack * awayDefence;
  let awayXg = LEAGUE_AVG_AWAY * awayAttack * homeDefence;

  // ── Cross-league tier adjustment ──
  const homeTier = getTierFactor(homeTeam.league);
  const awayTier = getTierFactor(awayTeam.league);

  if (homeTier !== awayTier) {
    const tierDiff = homeTier - awayTier; // approx -0.4 to +0.4
    // Higher-tier team gets xG boost, lower-tier team gets dampened
    homeXg *= 1 + tierDiff * 0.5;
    awayXg *= 1 - tierDiff * 0.5;
  }

  homeXg *= weatherMult;
  awayXg *= weatherMult;

  homeXg = clamp(homeXg, 0.3, 3.5);
  awayXg = clamp(awayXg, 0.3, 3.5);

  return { homeXg, awayXg };
}

// ══════════════════════════════════════════════
// 1X2 probabilities — from weighted factor diff
// ══════════════════════════════════════════════
function computeProbabilities(homeFactors, awayFactors, weatherMult) {
  let scoreDiff = 0;
  for (const key of Object.keys(WEIGHTS)) {
    if (key === 'weather') continue;
    const diff = (homeFactors[key] ?? 0.5) - (awayFactors[key] ?? 0.5);
    scoreDiff += WEIGHTS[key] * diff;
  }

  // Weather multiplier applied exactly as Python does
  if (weatherMult < 1.0) scoreDiff *= weatherMult - 0.1;
  else if (weatherMult > 1.0) scoreDiff *= weatherMult + 0.1;

  const scale = 1.8;
  let homeWin = 1 / (1 + Math.exp(-scoreDiff * scale));
  let awayWin = 1 / (1 + Math.exp(scoreDiff * scale));
  let draw = 1 - homeWin - awayWin;
  if (draw < 0) draw = 0;

  const total = homeWin + draw + awayWin;
  homeWin /= total;
  draw /= total;
  awayWin /= total;

  return { homeWin, draw, awayWin, scoreDiff };
}

// ══════════════════════════════════════════════
// Confidence — agreement × extremity (matches Python)
// ══════════════════════════════════════════════
function computeConfidence(homeFactors, awayFactors, scoreDiff) {
  const contributions = [];
  for (const key of Object.keys(WEIGHTS)) {
    if (key === 'weather') continue;
    const diff = (homeFactors[key] ?? 0.5) - (awayFactors[key] ?? 0.5);
    contributions.push(WEIGHTS[key] * diff);
  }

  const n = contributions.length;
  const mean = contributions.reduce((a, b) => a + b, 0) / n;
  const variance = contributions.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);

  const agreement = 1 / (1 + stdDev);
  const extremity = Math.min(1, Math.abs(scoreDiff) * 2);
  const confidence = Math.min(1, 0.5 * agreement + 0.5 * extremity);

  return confidence;
}

// ══════════════════════════════════════════════
// All markets — Poisson grid
// ══════════════════════════════════════════════
function computeAllMarketProbs(homeXg, awayXg) {
  const probs = {};

  let homeWin = 0,
    draw = 0,
    awayWin = 0;
  for (let h = 0; h <= 10; h++) {
    for (let a = 0; a <= 10; a++) {
      const p = poissonPmf(h, homeXg) * poissonPmf(a, awayXg);
      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;
    }
  }
  const sum = homeWin + draw + awayWin;
  homeWin /= sum;
  draw /= sum;
  awayWin /= sum;

  probs.home_win = homeWin;
  probs.draw = draw;
  probs.away_win = awayWin;
  probs['1X'] = homeWin + draw;
  probs['X2'] = draw + awayWin;
  probs['12'] = homeWin + awayWin;

  // Over / under
  for (const t of [0.5, 1.5, 2.5, 3.5, 4.5]) {
    let under = 0;
    for (let h = 0; h <= 10; h++) {
      for (let a = 0; a <= 10; a++) {
        if (h + a <= t) under += poissonPmf(h, homeXg) * poissonPmf(a, awayXg);
      }
    }
    probs[`under_${t}`] = under;
    probs[`over_${t}`] = 1 - under;
  }

  // BTTS
  const homeScores = 1 - poissonPmf(0, homeXg);
  const awayScores = 1 - poissonPmf(0, awayXg);
  probs.btts_yes = homeScores * awayScores;
  probs.btts_no = 1 - probs.btts_yes;

  // Handicaps (includes ±3 for smart selector)
  for (const hcap of [-3, -2, -1.5, -1, 1, 1.5, 2, 3]) {
    if (hcap < 0) {
      let p = 0;
      for (let h = 0; h <= 10; h++) {
        for (let a = 0; a <= 10; a++) {
          if (h + hcap > a) p += poissonPmf(h, homeXg) * poissonPmf(a, awayXg);
        }
      }
      probs[`home_${hcap}`] = p;
      probs[`away_+${Math.abs(hcap)}`] = 1 - p;
    } else {
      let p = 0;
      for (let h = 0; h <= 10; h++) {
        for (let a = 0; a <= 10; a++) {
          if (a - hcap > h) p += poissonPmf(h, homeXg) * poissonPmf(a, awayXg);
        }
      }
      probs[`away_-${hcap}`] = p;
      probs[`home_+${hcap}`] = 1 - p;
    }
  }

  return probs;
}

// ══════════════════════════════════════════════
// Most likely score
// ══════════════════════════════════════════════
function mostLikelyScore(homeXg, awayXg) {
  let best = '0-0',
    bestP = 0;
  for (let h = 0; h <= 6; h++) {
    for (let a = 0; a <= 6; a++) {
      const p = poissonPmf(h, homeXg) * poissonPmf(a, awayXg);
      if (p > bestP) {
        bestP = p;
        best = `${h}-${a}`;
      }
    }
  }
  return best;
}

// ══════════════════════════════════════════════
// Best market — prob × confidence
// ══════════════════════════════════════════════
function pickBestMarket(probs, confidence) {
  const excluded = [
    'under_0.5',
    'over_5.5',
    'under_5.5',
    'over_6.5',
    'under_6.5',
    'over_7.5',
    'under_7.5',
  ];
  let bestMarket = null,
    bestScore = 0,
    bestProb = 0;
  for (const [market, prob] of Object.entries(probs)) {
    if (excluded.includes(market)) continue;
    const score = prob * confidence;
    if (score > bestScore) {
      bestScore = score;
      bestMarket = market;
      bestProb = prob;
    }
  }
  return { bestMarket, bestProb, bestScore };
}

// ══════════════════════════════════════════════
// Reasons — plain-English using factor diffs
// ══════════════════════════════════════════════
function buildReasons(homeTeam, awayTeam, homeFactors, awayFactors, probs) {
  const reasons = [];
  const homeShort = homeTeam.short || homeTeam.name.slice(0, 3).toUpperCase();
  const awayShort = awayTeam.short || awayTeam.name.slice(0, 3).toUpperCase();

  // ── League tier gap (cross-league awareness) ──
  const homeTier = getTierFactor(homeTeam.league);
  const awayTier = getTierFactor(awayTeam.league);
  const tierDiff = homeTier - awayTier;

  if (Math.abs(tierDiff) >= 0.10) {
    const higher = tierDiff > 0 ? homeTeam : awayTeam;
    const lower = tierDiff > 0 ? awayTeam : homeTeam;
    const higherTier = tierDiff > 0 ? homeTier : awayTier;
    const lowerTier = tierDiff > 0 ? awayTier : homeTier;
    const gap = Math.abs(tierDiff);

    reasons.push({
      tone: tierDiff > 0 ? 'good' : 'warn',
      weight: clamp(gap * 2.0, 0.4, 0.95),
      tag: 'League quality',
      title: `${higher.name} play at a higher level`,
      text: `${higher.name} come from ${
        higher.league || 'a stronger league'
      } (tier ${higherTier.toFixed(2)}), while ${
        lower.name
      } play in ${
        lower.league || 'a lower-tier league'
      } (tier ${lowerTier.toFixed(2)}). This quality gap carries significant weight in our model.`,
    });
  }

  // ── Attack vs defence ──
  const homeAttack = homeTeam.attack_rating ?? 1.0;
  const homeDefence = homeTeam.defence_rating ?? 1.0;
  const awayAttack = awayTeam.attack_rating ?? 1.0;
  const awayDefence = awayTeam.defence_rating ?? 1.0;

  const hEdge = homeAttack - awayDefence;
  const aEdge = awayAttack - homeDefence;

  if (hEdge > 0.05) {
    reasons.push({
      tone: 'good',
      weight: clamp(hEdge * 1.7, 0.3, 0.95),
      tag: 'Attack vs defence',
      title: `${homeTeam.name} attack outmatches the ${awayTeam.name} defence`,
      text: `${homeShort} carry a ${Math.round(
        homeAttack * 100
      )} attack rating into a back line rated ${Math.round(
        awayDefence * 100
      )}. That gap is worth ~${(hEdge * 1.9).toFixed(2)} expected goals.`,
    });
  }
  if (aEdge > 0.05) {
    reasons.push({
      tone: 'warn',
      weight: clamp(aEdge * 1.7, 0.3, 0.95),
      tag: 'Counter threat',
      title: `${awayTeam.name} can hurt ${homeTeam.name} going forward`,
      text: `${awayShort} rate ${Math.round(
        awayAttack * 100
      )} in attack against a ${homeShort} defence at ${Math.round(
        homeDefence * 100
      )}. Expect them to create at least a couple of chances.`,
    });
  }

  // ── Form ──
  if (homeFactors.form > awayFactors.form + 0.15) {
    reasons.push({
      tone: 'good',
      weight: clamp(homeFactors.form - awayFactors.form + 0.3, 0.3, 0.9),
      tag: 'Recent form',
      title: `${homeTeam.name} arrive in better form`,
      text: `${homeShort} form rating ${Math.round(
        homeFactors.form * 100
      )} vs ${awayShort} ${Math.round(
        awayFactors.form * 100
      )} over the last 5 games.`,
    });
  } else if (awayFactors.form > homeFactors.form + 0.15) {
    reasons.push({
      tone: 'warn',
      weight: clamp(awayFactors.form - homeFactors.form + 0.3, 0.3, 0.9),
      tag: 'Recent form',
      title: `${awayTeam.name} arrive in better form`,
      text: `${awayShort} form rating ${Math.round(
        awayFactors.form * 100
      )} vs ${homeShort} ${Math.round(
        homeFactors.form * 100
      )} over the last 5 games.`,
    });
  }

  // ── Home advantage ──
  if (homeFactors.home_away > 0.65) {
    reasons.push({
      tone: 'good',
      weight: 0.78,
      tag: 'Home strength',
      title: `${homeTeam.name} are strong at home`,
      text: `Home strength ${homeFactors.home_away.toFixed(
        2
      )} — they convert chances at a higher rate at home.`,
    });
  }
  if (awayFactors.home_away < 0.35) {
    reasons.push({
      tone: 'bad',
      weight: 0.92,
      tag: 'Away form',
      title: `${awayTeam.name} are a poor travelling side`,
      text: `Away strength ${awayFactors.home_away.toFixed(
        2
      )} — below our 0.35 danger line. They drop points on the road.`,
    });
  }

  // ── Fatigue ──
  if (homeFactors.fatigue < 0.75) {
    reasons.push({
      tone: 'warn',
      weight: 0.7,
      tag: 'Fatigue',
      title: `${homeTeam.name} may be fatigued`,
      text: `Short rest between matches — could affect intensity.`,
    });
  }
  if (awayFactors.fatigue < 0.75) {
    reasons.push({
      tone: 'warn',
      weight: 0.7,
      tag: 'Fatigue',
      title: `${awayTeam.name} may be fatigued`,
      text: `Short rest between matches — could affect intensity.`,
    });
  }

  // ── H2H ──
  if (homeFactors.h2h > 0.7) {
    reasons.push({
      tone: 'good',
      weight: 0.6,
      tag: 'Head to head',
      title: `${homeTeam.name} dominate this fixture`,
      text: `${homeShort} have the better recent head-to-head record.`,
    });
  } else if (homeFactors.h2h < 0.3) {
    reasons.push({
      tone: 'warn',
      weight: 0.6,
      tag: 'Head to head',
      title: `${awayTeam.name} dominate this fixture`,
      text: `${awayShort} have the better recent head-to-head record.`,
    });
  }

  return reasons.sort((a, b) => b.weight - a.weight).slice(0, 5);
}

// ══════════════════════════════════════════════
// MAIN — analyze a single match
// ══════════════════════════════════════════════
async function analyzeMatch(match, homeTeam, awayTeam) {
  const { homeFactors, awayFactors } = await computeMatchFactors(
    match,
    homeTeam,
    awayTeam
  );

  const weatherMult = await getWeatherMultiplier(
    homeTeam.latitude,
    homeTeam.longitude,
    match.date
  );

  const { homeWin, draw, awayWin, scoreDiff } = computeProbabilities(
    homeFactors,
    awayFactors,
    weatherMult
  );
  const confidence = computeConfidence(homeFactors, awayFactors, scoreDiff);

  const { homeXg, awayXg } = computeXg(homeTeam, awayTeam, weatherMult);
  const probs = computeAllMarketProbs(homeXg, awayXg);

  const { bestMarket, bestProb, bestScore } = pickBestMarket(probs, confidence);
  const correctScore = mostLikelyScore(homeXg, awayXg);
  const reasons = buildReasons(homeTeam, awayTeam, homeFactors, awayFactors, probs);

  let pick;
  if (homeWin > awayWin && homeWin > draw) pick = `${homeTeam.name} win`;
  else if (awayWin > homeWin && awayWin > draw) pick = `${awayTeam.name} win`;
  else pick = 'Draw';

  return {
    home_win_prob: +homeWin.toFixed(4),
    draw_prob: +draw.toFixed(4),
    away_win_prob: +awayWin.toFixed(4),
    confidence: +confidence.toFixed(3),
    home_xg: +homeXg.toFixed(2),
    away_xg: +awayXg.toFixed(2),
    predicted_correct_score: correctScore,
    best_market: {
      market: bestMarket,
      probability: +bestProb.toFixed(4),
      score: +bestScore.toFixed(4),
    },
    pick,
    reasons,
    reason_short: reasons[0]
      ? `${reasons[0].title}. ${reasons[0].text}`
      : `Model picks ${pick}.`,
    markets: [
      { key: 'Result', value: pick.replace(' win', '') },
      { key: 'BTTS', value: probs.btts_yes > 0.5 ? 'Yes' : 'No' },
      { key: 'Goals', value: probs.over_2_5 > 0.5 ? 'Over 2.5' : 'Under 2.5' },
    ],
    home_factors: homeFactors,
    away_factors: awayFactors,
  };
}

// ══════════════════════════════════════════════
// Compare two teams
// ══════════════════════════════════════════════
async function compareTeams(home, away) {
  const fakeMatch = {
    date: new Date(),
    tournament: 'Friendly',
    stage: 'friendly',
    home_team_id: home._id,
    away_team_id: away._id,
  };
  const result = await analyzeMatch(fakeMatch, home, away);

  return {
    home_team: {
      id: home._id,
      name: home.name,
      short: home.short,
      logo: home.logo,
      color: home.color,
      league: home.league,
      attack_rating: home.attack_rating ?? 1.0,
      defence_rating: home.defence_rating ?? 1.0,
      home_ppg: home.home_ppg ?? 1.5,
      away_ppg: home.away_ppg ?? 1.0,
    },
    away_team: {
      id: away._id,
      name: away.name,
      short: away.short,
      logo: away.logo,
      color: away.color,
      league: away.league,
      attack_rating: away.attack_rating ?? 1.0,
      defence_rating: away.defence_rating ?? 1.0,
      home_ppg: away.home_ppg ?? 1.5,
      away_ppg: away.away_ppg ?? 1.0,
    },
    ...result,
  };
}

module.exports = {
  analyzeMatch,
  compareTeams,
  computeXg,
  computeAllMarketProbs,
  mostLikelyScore,
  pickBestMarket,
  computeProbabilities,
  computeConfidence,
  buildReasons,
  poissonPmf,
  poissonCdf,
};