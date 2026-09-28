// ══════════════════════════════════════════════
// services/predictionEngine.js
// Mirrors the Python engine's sure-bets logic for Formline
// ══════════════════════════════════════════════

const {
  computeMatchFactors,
  getWeatherMultiplier,
  getTierFactor,
  getMatchContext,
} = require('./factors');

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

// ── Markets always excluded from "best market" selection ──
// (mirrors Python's `excluded` list in get_sure_bets)
const EXCLUDED_MARKETS = [
  'under_0.5',
  'over_5.5',
  'under_5.5',
  'over_6.5',
  'under_6.5',
  'over_7.5',
  'under_7.5',
];

// ── Secondary-pick candidates (from Python) ──
const SECONDARY_CANDIDATES = [
  ['home_win', 'Home win'],
  ['away_win', 'Away win'],
  ['1X', 'Home or Draw'],
  ['X2', 'Draw or Away'],
  ['any_team_over_2.5_goals', 'Over 2.5 goals'],
  ['any_team_under_2.5_goals', 'Under 2.5 goals'],
  ['over_1.5', 'Over 1.5 goals'],
];

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
// xG with league tier awareness
// ══════════════════════════════════════════════
function computeXg(homeTeam, awayTeam, weatherMult = 1.0) {
  const homeAttack = homeTeam.attack_rating ?? 1.0;
  const homeDefence = homeTeam.defence_rating ?? 1.0;
  const awayAttack = awayTeam.attack_rating ?? 1.0;
  const awayDefence = awayTeam.defence_rating ?? 1.0;

  let homeXg = LEAGUE_AVG_HOME * homeAttack * awayDefence;
  let awayXg = LEAGUE_AVG_AWAY * awayAttack * homeDefence;

  const homeTier = getTierFactor(homeTeam.league);
  const awayTier = getTierFactor(awayTeam.league);
  if (homeTier !== awayTier) {
    const tierDiff = homeTier - awayTier;
    homeXg *= 1 + tierDiff * 0.5;
    awayXg *= 1 - tierDiff * 0.5;
  }

  homeXg *= weatherMult;
  awayXg *= weatherMult;

  return {
    homeXg: clamp(homeXg, 0.3, 3.5),
    awayXg: clamp(awayXg, 0.3, 3.5),
  };
}

// ══════════════════════════════════════════════
// 1X2 from weighted factor diff
// ══════════════════════════════════════════════
function computeProbabilities(homeFactors, awayFactors, weatherMult) {
  let scoreDiff = 0;
  for (const key of Object.keys(WEIGHTS)) {
    if (key === 'weather') continue;
    const diff = (homeFactors[key] ?? 0.5) - (awayFactors[key] ?? 0.5);
    scoreDiff += WEIGHTS[key] * diff;
  }

  if (weatherMult < 1.0) scoreDiff *= weatherMult - 0.1;
  else if (weatherMult > 1.0) scoreDiff *= weatherMult + 0.1;

  const scale = 1.8;
  let homeWin = 1 / (1 + Math.exp(-scoreDiff * scale));
  let awayWin = 1 / (1 + Math.exp(scoreDiff * scale));
  let draw = 1 - homeWin - awayWin;
  if (draw < 0) draw = 0;

  const total = homeWin + draw + awayWin;
  return {
    homeWin: homeWin / total,
    draw: draw / total,
    awayWin: awayWin / total,
    scoreDiff,
  };
}

// ══════════════════════════════════════════════
// Confidence
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
  const variance =
    contributions.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);

  const agreement = 1 / (1 + stdDev);
  const extremity = Math.min(1, Math.abs(scoreDiff) * 2);
  return Math.min(1, 0.5 * agreement + 0.5 * extremity);
}

// ══════════════════════════════════════════════
// All markets
// ══════════════════════════════════════════════
function computeAllMarketProbs(homeXg, awayXg) {
  const probs = {};

  let homeWin = 0, draw = 0, awayWin = 0;
  for (let h = 0; h <= 10; h++) {
    for (let a = 0; a <= 10; a++) {
      const p = poissonPmf(h, homeXg) * poissonPmf(a, awayXg);
      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;
    }
  }
  const sum = homeWin + draw + awayWin;
  homeWin /= sum; draw /= sum; awayWin /= sum;

  probs.home_win = homeWin;
  probs.draw = draw;
  probs.away_win = awayWin;
  probs['1X'] = homeWin + draw;
  probs['X2'] = draw + awayWin;
  probs['12'] = homeWin + awayWin;

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

  const hs = 1 - poissonPmf(0, homeXg);
  const as = 1 - poissonPmf(0, awayXg);
  probs.btts_yes = hs * as;
  probs.btts_no = 1 - probs.btts_yes;

  // Any-team over/under 2.5
  const pHomeLess3 = poissonCdf(2, homeXg);
  const pAwayLess3 = poissonCdf(2, awayXg);
  probs.any_team_over_2.5_goals = 1 - pHomeLess3 * pAwayLess3;
  probs.any_team_under_2.5_goals = pHomeLess3 * pAwayLess3;

  // Handicaps
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
// Most likely correct score
// ══════════════════════════════════════════════
function mostLikelyScore(homeXg, awayXg) {
  let best = '0-0', bestP = 0;
  for (let h = 0; h <= 6; h++) {
    for (let a = 0; a <= 6; a++) {
      const p = poissonPmf(h, homeXg) * poissonPmf(a, awayXg);
      if (p > bestP) { bestP = p; best = `${h}-${a}`; }
    }
  }
  return best;
}

// ══════════════════════════════════════════════
// Best market — same exclusions + derby logic as Python
// ══════════════════════════════════════════════
function pickBestMarket(probs, confidence, context = {}) {
  let bestMarket = null;
  let bestScore = 0;
  let bestProb = 0;

  for (const [market, prob] of Object.entries(probs)) {
    if (EXCLUDED_MARKETS.includes(market)) continue;
    // Derby: skip weak win markets (Python does the same)
    if (
      context.is_derby &&
      ['home_win', 'away_win'].includes(market) &&
      prob < 0.5
    ) {
      continue;
    }
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
// Secondary market (like Python's sure bets)
// ══════════════════════════════════════════════
function pickSecondaryMarket(probs, bestMarket, likelyResult, context = {}, minProb = 0.6) {
  let candidates = [...SECONDARY_CANDIDATES];

  // Remove contradicting markets
  if (likelyResult === 'home') {
    candidates = candidates.filter(([m]) => m !== 'X2');
  } else if (likelyResult === 'away') {
    candidates = candidates.filter(([m]) => m !== '1X');
  } else if (likelyResult === 'draw') {
    candidates = candidates.filter(([m]) => m !== '1X' && m !== 'X2');
  }

  let best = null;
  for (const [key, label] of candidates) {
    if (key === bestMarket) continue;
    const prob = probs[key];
    if (prob == null || prob < minProb) continue;
    if (context.is_derby && ['home_win', 'away_win'].includes(key) && prob < 0.5) continue;
    if (!best || prob > best.prob) best = { market: key, label, prob };
  }
  return best;
}

// ══════════════════════════════════════════════
// Reasons — plain-English
// ══════════════════════════════════════════════
function buildReasons(homeTeam, awayTeam, homeFactors, awayFactors, probs, context) {
  const reasons = [];
  const hs = homeTeam.short || homeTeam.name.slice(0, 3).toUpperCase();
  const as_ = awayTeam.short || awayTeam.name.slice(0, 3).toUpperCase();

  // ── Context (derby/final/knockout) ──
  if (context.is_final) {
    reasons.push({
      tone: 'warn',
      weight: 0.85,
      tag: 'Match context',
      title: 'This is a FINAL',
      text: 'High motivation and intensity expected. Form can be overridden by the occasion.',
    });
  } else if (context.is_knockout) {
    reasons.push({
      tone: 'warn',
      weight: 0.72,
      tag: 'Match context',
      title: 'Knockout stage',
      text: 'Teams will be extra cautious and motivated — expect a tight game.',
    });
  }
  if (context.is_derby) {
    reasons.push({
      tone: 'warn',
      weight: 0.8,
      tag: 'Derby',
      title: 'This is a derby',
      text: 'Rivalry and emotion can override form and statistics in this fixture.',
    });
  }

  // ── League tier gap ──
  const homeTier = getTierFactor(homeTeam.league);
  const awayTier = getTierFactor(awayTeam.league);
  const tierDiff = homeTier - awayTier;
  if (Math.abs(tierDiff) >= 0.1) {
    const higher = tierDiff > 0 ? homeTeam : awayTeam;
    const lower = tierDiff > 0 ? awayTeam : homeTeam;
    const higherTier = tierDiff > 0 ? homeTier : awayTier;
    const lowerTier = tierDiff > 0 ? awayTier : homeTier;
    reasons.push({
      tone: tierDiff > 0 ? 'good' : 'warn',
      weight: clamp(Math.abs(tierDiff) * 2, 0.4, 0.95),
      tag: 'League quality',
      title: `${higher.name} play at a higher level`,
      text: `${higher.name} come from ${higher.league || 'a stronger league'} (tier ${higherTier.toFixed(2)}), while ${lower.name} play in ${lower.league || 'a lower-tier league'} (tier ${lowerTier.toFixed(2)}).`,
    });
  }

  // ── Attack vs defence ──
  const hAtk = homeTeam.attack_rating ?? 1.0;
  const hDef = homeTeam.defence_rating ?? 1.0;
  const aAtk = awayTeam.attack_rating ?? 1.0;
  const aDef = awayTeam.defence_rating ?? 1.0;

  const hEdge = hAtk - aDef;
  const aEdge = aAtk - hDef;

  if (hEdge > 0.05) {
    reasons.push({
      tone: 'good',
      weight: clamp(hEdge * 1.7, 0.3, 0.95),
      tag: 'Attack vs defence',
      title: `${homeTeam.name} attack outmatches the ${awayTeam.name} defence`,
      text: `${hs} carry a ${Math.round(hAtk * 100)} attack rating into a back line rated ${Math.round(aDef * 100)}. That gap is worth ~${(hEdge * 1.9).toFixed(2)} xG.`,
    });
  }
  if (aEdge > 0.05) {
    reasons.push({
      tone: 'warn',
      weight: clamp(aEdge * 1.7, 0.3, 0.95),
      tag: 'Counter threat',
      title: `${awayTeam.name} can hurt ${homeTeam.name} going forward`,
      text: `${as_} rate ${Math.round(aAtk * 100)} in attack against a ${hs} defence at ${Math.round(hDef * 100)}.`,
    });
  }

  // ── Form ──
  if (homeFactors.form > awayFactors.form + 0.15) {
    reasons.push({
      tone: 'good',
      weight: clamp(homeFactors.form - awayFactors.form + 0.3, 0.3, 0.9),
      tag: 'Recent form',
      title: `${homeTeam.name} arrive in better form`,
      text: `${hs} form ${Math.round(homeFactors.form * 100)} vs ${as_} ${Math.round(awayFactors.form * 100)} over the last 5 games.`,
    });
  } else if (awayFactors.form > homeFactors.form + 0.15) {
    reasons.push({
      tone: 'warn',
      weight: clamp(awayFactors.form - homeFactors.form + 0.3, 0.3, 0.9),
      tag: 'Recent form',
      title: `${awayTeam.name} arrive in better form`,
      text: `${as_} form ${Math.round(awayFactors.form * 100)} vs ${hs} ${Math.round(homeFactors.form * 100)} over the last 5 games.`,
    });
  }

  // ── Home / away strength ──
  if (homeFactors.home_away > 0.65) {
    reasons.push({
      tone: 'good',
      weight: 0.78,
      tag: 'Home strength',
      title: `${homeTeam.name} are strong at home`,
      text: `Home strength ${homeFactors.home_away.toFixed(2)} — they convert chances at a higher rate at home.`,
    });
  }
  if (awayFactors.home_away < 0.35) {
    reasons.push({
      tone: 'bad',
      weight: 0.92,
      tag: 'Away form',
      title: `${awayTeam.name} are a poor travelling side`,
      text: `Away strength ${awayFactors.home_away.toFixed(2)} — below our 0.35 danger line.`,
    });
  }

  // ── Fatigue ──
  if (homeFactors.fatigue < 0.75) {
    reasons.push({
      tone: 'warn',
      weight: 0.7,
      tag: 'Fatigue',
      title: `${homeTeam.name} may be fatigued`,
      text: 'Short rest between matches — could affect intensity.',
    });
  }
  if (awayFactors.fatigue < 0.75) {
    reasons.push({
      tone: 'warn',
      weight: 0.7,
      tag: 'Fatigue',
      title: `${awayTeam.name} may be fatigued`,
      text: 'Short rest between matches — could affect intensity.',
    });
  }

  // ── H2H ──
  if (homeFactors.h2h > 0.7) {
    reasons.push({
      tone: 'good',
      weight: 0.6,
      tag: 'Head to head',
      title: `${homeTeam.name} dominate this fixture`,
      text: `${hs} have the better recent head-to-head record.`,
    });
  } else if (homeFactors.h2h < 0.3) {
    reasons.push({
      tone: 'warn',
      weight: 0.6,
      tag: 'Head to head',
      title: `${awayTeam.name} dominate this fixture`,
      text: `${as_} have the better recent head-to-head record.`,
    });
  }

  return reasons.sort((a, b) => b.weight - a.weight).slice(0, 5);
}

// ══════════════════════════════════════════════
// Analyze a match — mirrors Python's sure-bet flow
// ══════════════════════════════════════════════
async function analyzeMatch(match, homeTeam, awayTeam) {
  const context = getMatchContext(match);

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

  // Best market — same as Python's sure bets
  const { bestMarket, bestProb, bestScore } = pickBestMarket(
    probs,
    confidence,
    context
  );

  const correctScore = mostLikelyScore(homeXg, awayXg);

  // Likely result (for secondary pick sanity check)
  let likelyResult = 'draw';
  if (homeWin > awayWin && homeWin > draw) likelyResult = 'home';
  else if (awayWin > homeWin && awayWin > draw) likelyResult = 'away';

  // Secondary pick
  const secondary = pickSecondaryMarket(probs, bestMarket, likelyResult, context, 0.6);

  // Reasons
  const reasons = buildReasons(homeTeam, awayTeam, homeFactors, awayFactors, probs, context);

  // Add reason explaining the pick
  const pick =
    likelyResult === 'home'
      ? `${homeTeam.name} win`
      : likelyResult === 'away'
      ? `${awayTeam.name} win`
      : 'Draw';

  // Format best market for display
  const marketLabel = formatMarketLabel(bestMarket);

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
      label: marketLabel,
      probability: +bestProb.toFixed(4),
      score: +bestScore.toFixed(4),
    },
    pick: marketLabel || pick,
    secondary_pick: secondary
      ? {
          market: secondary.market,
          label: secondary.label,
          probability: +secondary.prob.toFixed(4),
        }
      : null,
    reasons,
    reason_short: reasons[0]
      ? `${reasons[0].title}. ${reasons[0].text}`
      : `Model picks ${marketLabel || pick}.`,
    markets: [
      { key: 'Result', value: pick.replace(' win', '') },
      { key: 'BTTS', value: probs.btts_yes > 0.5 ? 'Yes' : 'No' },
      { key: 'Goals', value: probs.over_2.5 > 0.5 ? 'Over 2.5' : 'Under 2.5' },
    ],
    home_factors: homeFactors,
    away_factors: awayFactors,
  };
}

// ══════════════════════════════════════════════
// Human-readable market labels
// ══════════════════════════════════════════════
function formatMarketLabel(market) {
  if (!market) return '';
  const map = {
    home_win: 'Home win',
    away_win: 'Away win',
    draw: 'Draw',
    '1X': 'Home or Draw',
    'X2': 'Draw or Away',
    '12': 'Home or Away',
    btts_yes: 'BTTS – Yes',
    btts_no: 'BTTS – No',
    over_0_5: 'Over 0.5',
    over_1_5: 'Over 1.5',
    over_2_5: 'Over 2.5',
    over_3_5: 'Over 3.5',
    under_0_5: 'Under 0.5',
    under_1_5: 'Under 1.5',
    under_2_5: 'Under 2.5',
    under_3_5: 'Under 3.5',
    'any_team_over_2.5_goals': 'Any team Over 2.5',
    'any_team_under_2.5_goals': 'Any team Under 2.5',
    home__1: 'Home -1',
    home__2: 'Home -2',
    home__3: 'Home -3',
    away__1: 'Away -1',
    away__2: 'Away -2',
    away__3: 'Away -3',
  };
  // Normalize dots to underscores
  const key = market.replace(/\./g, '_');
  if (map[key]) return map[key];
  // Handle home_+2 style
  if (/^home_\+\d/.test(market)) return `Home +${market.split('+')[1]}`;
  if (/^away_\+\d/.test(market)) return `Away +${market.split('+')[1]}`;
  if (/^home_-\d/.test(market)) return `Home ${market.split('home')[1]}`;
  if (/^away_-\d/.test(market)) return `Away ${market.split('away')[1]}`;
  return market.replace(/_/g, ' ');
}

// ══════════════════════════════════════════════
// Compare teams
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
  formatMarketLabel,
  poissonPmf,
  poissonCdf,
};