// services/predictionEngine.js
// Smarter version: opponent-adjusted home/away ratings + Dixon-Coles + factor-adjusted lambdas

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
const NEUTRAL_BASELINE = 1.20;

// Dixon-Coles parameters (classic values work well)
const DC_RHO = -0.13;   // negative correlation for low scores
const DC_TAU = 0.01;    // small time-decay if you ever want it

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function describeAttack(v) {
  if (v >= 1.5) return 'elite';
  if (v >= 1.2) return 'strong';
  if (v >= 0.9) return 'average';
  if (v >= 0.7) return 'weak';
  return 'very weak';
}
function describeDefence(v) {
  if (v <= 0.7) return 'elite';
  if (v <= 0.9) return 'strong';
  if (v <= 1.1) return 'average';
  if (v <= 1.3) return 'weak';
  return 'very weak';
}

const EXCLUDED_FROM_BEST = new Set([
  'under_0.5', 'over_5.5', 'under_5.5',
  'over_6.5', 'under_6.5', 'over_7.5', 'under_7.5',
  'home_-3', 'home_-2', 'away_-3', 'away_-2',
  'home_+3', 'home_+2', 'away_+3', 'away_+2',
  'home_-1.5', 'away_-1.5', 'home_+1.5', 'away_+1.5',
  'no_goals',
  'home_over_2.5', 'away_over_2.5',
  'home_win_by_3plus', 'away_win_by_3plus',
  'home_clean_sheet', 'away_clean_sheet',
  'home_win_to_nil', 'away_win_to_nil',
  'any_team_over_2.5_goals', 'any_team_under_2.5_goals',
  'home_over_1.5', 'away_over_1.5', 'home_over_0.5', 'away_over_0.5',
]);

const SECONDARY_CANDIDATES = [
  ['home_win', 'Home win'],
  ['away_win', 'Away win'],
  ['1X', 'Home or Draw'],
  ['X2', 'Draw or Away'],
  ['dnb_home', 'Draw No Bet – Home'],
  ['dnb_away', 'Draw No Bet – Away'],
  ['over_1.5', 'Over 1.5 goals'],
  ['under_3.5', 'Under 3.5 goals'],
  ['btts_yes', 'BTTS – Yes'],
];

// ══════════════════════════════════════════════
// Poisson + Dixon-Coles helpers
// ══════════════════════════════════════════════
function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

function poissonCdf(k, lambda) {
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += poissonPmf(i, lambda);
  return sum;
}

// Dixon-Coles tau correction for low scores
function dixonColesTau(h, a, lambdaH, lambdaA, rho = DC_RHO) {
  if (h === 0 && a === 0) return 1 - lambdaH * lambdaA * rho;
  if (h === 0 && a === 1) return 1 + lambdaH * rho;
  if (h === 1 && a === 0) return 1 + lambdaA * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}

// ══════════════════════════════════════════════
// xG with home/away ratings + factor adjustment
// ══════════════════════════════════════════════
function computeXg(homeTeam, awayTeam, weatherMult = 1.0, neutral = false, factorAdj = 0) {
  // Prefer the new home/away ratings, fall back to overall
  const homeAttack = neutral
    ? ((homeTeam.attack_rating_home ?? homeTeam.attack_rating ?? 1) +
       (homeTeam.attack_rating_away ?? homeTeam.attack_rating ?? 1)) / 2
    : (homeTeam.attack_rating_home ?? homeTeam.attack_rating ?? 1);

  const homeDefence = neutral
    ? ((homeTeam.defence_rating_home ?? homeTeam.defence_rating ?? 1) +
       (homeTeam.defence_rating_away ?? homeTeam.defence_rating ?? 1)) / 2
    : (homeTeam.defence_rating_home ?? homeTeam.defence_rating ?? 1);

  const awayAttack = neutral
    ? ((awayTeam.attack_rating_home ?? awayTeam.attack_rating ?? 1) +
       (awayTeam.attack_rating_away ?? awayTeam.attack_rating ?? 1)) / 2
    : (awayTeam.attack_rating_away ?? awayTeam.attack_rating ?? 1);

  const awayDefence = neutral
    ? ((awayTeam.defence_rating_home ?? awayTeam.defence_rating ?? 1) +
       (awayTeam.defence_rating_away ?? awayTeam.defence_rating ?? 1)) / 2
    : (awayTeam.defence_rating_away ?? awayTeam.defence_rating ?? 1);

  const homeBaseline = neutral ? NEUTRAL_BASELINE : LEAGUE_AVG_HOME;
  const awayBaseline = neutral ? NEUTRAL_BASELINE : LEAGUE_AVG_AWAY;

  let homeXg = homeBaseline * homeAttack * awayDefence;
  let awayXg = awayBaseline * awayAttack * homeDefence;

  // Tier adjustment
  const homeTier = getTierFactor(homeTeam.league);
  const awayTier = getTierFactor(awayTeam.league);
  if (homeTier !== awayTier) {
    const tierDiff = homeTier - awayTier;
    homeXg *= 1 + tierDiff * 0.45;
    awayXg *= 1 - tierDiff * 0.45;
  }

  // Weather
  homeXg *= weatherMult;
  awayXg *= weatherMult;

  // Factor signal now directly nudges the lambdas (much cleaner than post-hoc probability shift)
  // factorAdj is roughly in [-0.4 … +0.4]
  const adj = clamp(factorAdj * 0.22, -0.28, 0.28);
  homeXg *= 1 + adj;
  awayXg *= 1 - adj;

  return {
    homeXg: clamp(homeXg, 0.25, 4.2),
    awayXg: clamp(awayXg, 0.25, 4.2),
  };
}

// ══════════════════════════════════════════════
// 1X2 signal (used only to produce factorAdj)
// ══════════════════════════════════════════════
function computeFactorSignal(homeFactors, awayFactors, weatherMult) {
  let scoreDiff = 0;
  for (const key of Object.keys(WEIGHTS)) {
    if (key === 'weather') continue;
    const diff = (homeFactors[key] ?? 0.5) - (awayFactors[key] ?? 0.5);
    scoreDiff += WEIGHTS[key] * diff;
  }
  if (weatherMult < 1.0) scoreDiff *= weatherMult - 0.08;
  else if (weatherMult > 1.0) scoreDiff *= weatherMult + 0.08;
  return scoreDiff; // typically ~[-0.6 … 0.6]
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
  const variance = contributions.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);
  const agreement = 1 / (1 + stdDev * 1.8);
  const extremity = Math.min(1, Math.abs(scoreDiff) * 1.7);
  return clamp(0.42 * agreement + 0.58 * extremity, 0.15, 0.97);
}

// ══════════════════════════════════════════════
// ALL MARKETS — with Dixon-Coles
// ══════════════════════════════════════════════
function computeAllMarketProbs(homeXg, awayXg) {
  const probs = {};
  const grid = [];
  let gridSum = 0;

  // Build joint distribution with Dixon-Coles correction
  for (let h = 0; h <= 10; h++) {
    grid[h] = [];
    for (let a = 0; a <= 10; a++) {
      const raw = poissonPmf(h, homeXg) * poissonPmf(a, awayXg);
      const tau = dixonColesTau(h, a, homeXg, awayXg);
      grid[h][a] = raw * tau;
      gridSum += grid[h][a];
    }
  }
  // Normalise
  for (let h = 0; h <= 10; h++) {
    for (let a = 0; a <= 10; a++) grid[h][a] /= gridSum;
  }

  // 1X2
  let homeWin = 0, draw = 0, awayWin = 0;
  for (let h = 0; h <= 10; h++) {
    for (let a = 0; a <= 10; a++) {
      const p = grid[h][a];
      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;
    }
  }
  probs.home_win = homeWin;
  probs.draw = draw;
  probs.away_win = awayWin;
  probs['1X'] = homeWin + draw;
  probs['X2'] = draw + awayWin;
  probs['12'] = homeWin + awayWin;

  // Draw No Bet
  const dnbTotal = homeWin + awayWin;
  probs.dnb_home = dnbTotal > 0 ? homeWin / dnbTotal : 0.5;
  probs.dnb_away = dnbTotal > 0 ? awayWin / dnbTotal : 0.5;

  // Goals O/U
  for (const t of [0.5, 1.5, 2.5, 3.5, 4.5]) {
    let under = 0;
    for (let h = 0; h <= 10; h++) {
      for (let a = 0; a <= 10; a++) {
        if (h + a <= t) under += grid[h][a];
      }
    }
    probs[`under_${t}`] = under;
    probs[`over_${t}`] = 1 - under;
  }

  // BTTS
  let bttsYes = 0;
  for (let h = 1; h <= 10; h++) {
    for (let a = 1; a <= 10; a++) bttsYes += grid[h][a];
  }
  probs.btts_yes = bttsYes;
  probs.btts_no = 1 - bttsYes;

  // Odd / Even
  let odd = 0, even = 0;
  for (let h = 0; h <= 10; h++) {
    for (let a = 0; a <= 10; a++) {
      if ((h + a) % 2 === 1) odd += grid[h][a];
      else even += grid[h][a];
    }
  }
  probs.odd = odd;
  probs.even = even;

  // Team totals
  for (const t of [0.5, 1.5, 2.5]) {
    probs[`home_over_${t}`] = 1 - poissonCdf(Math.floor(t), homeXg);
    probs[`home_under_${t}`] = poissonCdf(Math.floor(t), homeXg);
    probs[`away_over_${t}`] = 1 - poissonCdf(Math.floor(t), awayXg);
    probs[`away_under_${t}`] = poissonCdf(Math.floor(t), awayXg);
  }

  // Any team 2.5+
  const pHomeLess3 = poissonCdf(2, homeXg);
  const pAwayLess3 = poissonCdf(2, awayXg);
  probs['any_team_over_2.5_goals'] = 1 - pHomeLess3 * pAwayLess3;
  probs['any_team_under_2.5_goals'] = pHomeLess3 * pAwayLess3;

  // Clean sheets
  probs.home_clean_sheet = 0;
  probs.away_clean_sheet = 0;
  for (let h = 0; h <= 10; h++) {
    probs.home_clean_sheet += grid[h][0];
    probs.away_clean_sheet += grid[0][h];
  }

  // Win to nil
  let hwtl = 0, awtl = 0;
  for (let h = 1; h <= 10; h++) hwtl += grid[h][0];
  for (let a = 1; a <= 10; a++) awtl += grid[0][a];
  probs.home_win_to_nil = hwtl;
  probs.away_win_to_nil = awtl;

  // Winning margin
  let hw1 = 0, hw2 = 0, hw3p = 0;
  let aw1 = 0, aw2 = 0, aw3p = 0;
  for (let h = 0; h <= 10; h++) {
    for (let a = 0; a <= 10; a++) {
      const diff = h - a;
      const p = grid[h][a];
      if (diff === 1) hw1 += p;
      else if (diff === 2) hw2 += p;
      else if (diff >= 3) hw3p += p;
      else if (diff === -1) aw1 += p;
      else if (diff === -2) aw2 += p;
      else if (diff <= -3) aw3p += p;
    }
  }
  probs.home_win_by_1 = hw1;
  probs.home_win_by_2 = hw2;
  probs.home_win_by_3plus = hw3p;
  probs.away_win_by_1 = aw1;
  probs.away_win_by_2 = aw2;
  probs.away_win_by_3plus = aw3p;

  // Team to score first (exponential approximation)
  const pNoGoals = grid[0][0];
  const firstGoalTotal = 1 - pNoGoals;
  const totalXg = homeXg + awayXg;
  if (totalXg > 0) {
    probs.home_score_first = (homeXg / totalXg) * firstGoalTotal;
    probs.away_score_first = (awayXg / totalXg) * firstGoalTotal;
  } else {
    probs.home_score_first = 0;
    probs.away_score_first = 0;
  }
  probs.no_goals = pNoGoals;

  // Result + BTTS
  let hw_btts_yes = 0, d_btts_yes = 0, aw_btts_yes = 0;
  for (let h = 1; h <= 10; h++) {
    for (let a = 1; a <= 10; a++) {
      const p = grid[h][a];
      if (h > a) hw_btts_yes += p;
      else if (h === a) d_btts_yes += p;
      else aw_btts_yes += p;
    }
  }
  probs.home_win_btts_yes = hw_btts_yes;
  probs.home_win_btts_no = homeWin - hw_btts_yes;
  probs.draw_btts_yes = d_btts_yes;
  probs.draw_btts_no = draw - d_btts_yes;
  probs.away_win_btts_yes = aw_btts_yes;
  probs.away_win_btts_no = awayWin - aw_btts_yes;

  // BTTS + O/U 2.5
  let bttsOver25 = 0, bttsUnder25 = 0;
  for (let h = 1; h <= 10; h++) {
    for (let a = 1; a <= 10; a++) {
      if (h + a > 2.5) bttsOver25 += grid[h][a];
      else bttsUnder25 += grid[h][a];
    }
  }
  probs.btts_and_over_2_5 = bttsOver25;
  probs.btts_and_under_2_5 = bttsUnder25;
  probs.no_btts_and_over_2_5 = probs.over_2_5 - bttsOver25;
  probs.no_btts_and_under_2_5 = probs.under_2_5 - bttsUnder25;

  // Handicaps
  for (const hcap of [-3, -2, -1.5, -1, 1, 1.5, 2, 3]) {
    if (hcap < 0) {
      let p = 0;
      for (let h = 0; h <= 10; h++) {
        for (let a = 0; a <= 10; a++) {
          if (h + hcap > a) p += grid[h][a];
        }
      }
      probs[`home_${hcap}`] = p;
      probs[`away_+${Math.abs(hcap)}`] = 1 - p;
    } else {
      let p = 0;
      for (let h = 0; h <= 10; h++) {
        for (let a = 0; a <= 10; a++) {
          if (a - hcap > h) p += grid[h][a];
        }
      }
      probs[`away_-${hcap}`] = p;
      probs[`home_+${hcap}`] = 1 - p;
    }
  }

  return probs;
}

// ══════════════════════════════════════════════
// Correct score grid + most likely
// ══════════════════════════════════════════════
function correctScoreGrid(homeXg, awayXg, top = 20) {
  const entries = [];
  for (let h = 0; h <= 7; h++) {
    for (let a = 0; a <= 7; a++) {
      const raw = poissonPmf(h, homeXg) * poissonPmf(a, awayXg);
      const tau = dixonColesTau(h, a, homeXg, awayXg);
      entries.push({
        score: `${h}-${a}`,
        home: h,
        away: a,
        probability: +(raw * tau).toFixed(5),
      });
    }
  }
  // We need to re-normalise because of tau
  const sum = entries.reduce((s, e) => s + e.probability, 0);
  entries.forEach(e => e.probability = +(e.probability / sum).toFixed(4));
  entries.sort((x, y) => y.probability - x.probability);
  return entries.slice(0, top);
}

function mostLikelyScore(homeXg, awayXg) {
  let best = '0-0', bestP = 0;
  for (let h = 0; h <= 7; h++) {
    for (let a = 0; a <= 7; a++) {
      const raw = poissonPmf(h, homeXg) * poissonPmf(a, awayXg);
      const p = raw * dixonColesTau(h, a, homeXg, awayXg);
      if (p > bestP) { bestP = p; best = `${h}-${a}`; }
    }
  }
  return best;
}

// ══════════════════════════════════════════════
// Best market (now edge-oriented)
// ══════════════════════════════════════════════
function pickBestMarket(probs, confidence, context = {}) {
  let bestMarket = null;
  let bestScore = -Infinity;
  let bestProb = 0;

  for (const [market, prob] of Object.entries(probs)) {
    if (market.startsWith('correct_')) continue;
    if (EXCLUDED_FROM_BEST.has(market)) continue;
    if (context.is_derby && ['home_win', 'away_win'].includes(market) && prob < 0.48) continue;

    // Score = probability × confidence × slight preference for higher-probability markets
    // (when you later have real odds you can replace this with true edge)
    const score = prob * confidence * (0.85 + 0.15 * prob);

    if (score > bestScore) {
      bestScore = score;
      bestMarket = market;
      bestProb = prob;
    }
  }
  return { bestMarket, bestProb, bestScore };
}

function pickSecondaryMarket(probs, bestMarket, likelyResult, context = {}, minProb = 0.58) {
  let candidates = [...SECONDARY_CANDIDATES];
  if (likelyResult === 'home') candidates = candidates.filter(([m]) => m !== 'X2');
  else if (likelyResult === 'away') candidates = candidates.filter(([m]) => m !== '1X');
  else if (likelyResult === 'draw') candidates = candidates.filter(([m]) => m !== '1X' && m !== 'X2');

  let best = null;
  for (const [key, label] of candidates) {
    if (key === bestMarket) continue;
    const prob = probs[key];
    if (prob == null || prob < minProb) continue;
    if (context.is_derby && ['home_win', 'away_win'].includes(key) && prob < 0.48) continue;
    if (!best || prob > best.prob) best = { market: key, label, prob };
  }
  return best;
}

// ══════════════════════════════════════════════
// Reasons (unchanged logic, minor polish)
// ══════════════════════════════════════════════
function buildReasons(homeTeam, awayTeam, homeFactors, awayFactors, probs, context) {
  const reasons = [];
  const hs = homeTeam.short || homeTeam.name.slice(0, 3).toUpperCase();
  const as_ = awayTeam.short || awayTeam.name.slice(0, 3).toUpperCase();

  if (context.is_final) {
    reasons.push({ tone: 'warn', weight: 0.85, tag: 'Match context',
      title: 'This is a FINAL',
      text: 'High motivation and intensity expected. Form can be overridden by the occasion.' });
  } else if (context.is_knockout) {
    reasons.push({ tone: 'warn', weight: 0.72, tag: 'Match context',
      title: 'Knockout stage',
      text: 'Teams will be extra cautious and motivated — expect a tight game.' });
  }
  if (context.is_derby) {
    reasons.push({ tone: 'warn', weight: 0.8, tag: 'Derby',
      title: 'This is a derby',
      text: 'Rivalry and emotion can override form and statistics in this fixture.' });
  }

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

  const hAtk = homeTeam.attack_rating_home ?? homeTeam.attack_rating ?? 1.0;
  const hDef = homeTeam.defence_rating_home ?? homeTeam.defence_rating ?? 1.0;
  const aAtk = awayTeam.attack_rating_away ?? awayTeam.attack_rating ?? 1.0;
  const aDef = awayTeam.defence_rating_away ?? awayTeam.defence_rating ?? 1.0;
  const hEdge = hAtk - aDef;
  const aEdge = aAtk - hDef;

  if (hEdge > 0.05) {
    reasons.push({
      tone: 'good', weight: clamp(hEdge * 1.7, 0.3, 0.95),
      tag: 'Attack vs defence',
      title: `${homeTeam.name} attack outmatches the ${awayTeam.name} defence`,
      text: `${hs} bring a ${describeAttack(hAtk)} attack against a ${describeDefence(aDef)} back line.`,
    });
  }
  if (aEdge > 0.05) {
    reasons.push({
      tone: 'warn', weight: clamp(aEdge * 1.7, 0.3, 0.95),
      tag: 'Counter threat',
      title: `${awayTeam.name} can hurt ${homeTeam.name} going forward`,
      text: `${as_} bring a ${describeAttack(aAtk)} attack against a ${describeDefence(hDef)} back line.`,
    });
  }

  if (homeFactors.form > awayFactors.form + 0.15) {
    reasons.push({ tone: 'good', weight: clamp(homeFactors.form - awayFactors.form + 0.3, 0.3, 0.9),
      tag: 'Recent form',
      title: `${homeTeam.name} arrive in better form`,
      text: `${hs} form ${Math.round(homeFactors.form * 100)} vs ${as_} ${Math.round(awayFactors.form * 100)} over the last 5 games.` });
  } else if (awayFactors.form > homeFactors.form + 0.15) {
    reasons.push({ tone: 'warn', weight: clamp(awayFactors.form - homeFactors.form + 0.3, 0.3, 0.9),
      tag: 'Recent form',
      title: `${awayTeam.name} arrive in better form`,
      text: `${as_} form ${Math.round(awayFactors.form * 100)} vs ${hs} ${Math.round(homeFactors.form * 100)} over the last 5 games.` });
  }

  if (!context.neutral) {
    if (homeFactors.home_away > 0.65) {
      reasons.push({ tone: 'good', weight: 0.78, tag: 'Home strength',
        title: `${homeTeam.name} are strong at home`,
        text: `Home strength ${homeFactors.home_away.toFixed(2)} — they convert chances at a higher rate at home.` });
    }
    if (awayFactors.home_away < 0.35) {
      reasons.push({ tone: 'bad', weight: 0.92, tag: 'Away form',
        title: `${awayTeam.name} are a poor travelling side`,
        text: `Away strength ${awayFactors.home_away.toFixed(2)} — below our 0.35 danger line.` });
    }
  } else {
    reasons.push({ tone: 'ok', weight: 0.5, tag: 'Neutral venue',
      title: 'Neutral venue comparison',
      text: 'Home advantage is ignored for this comparison.' });
  }

  if (homeFactors.fatigue < 0.75) {
    reasons.push({ tone: 'warn', weight: 0.7, tag: 'Fatigue',
      title: `${homeTeam.name} may be fatigued`,
      text: 'Short rest between matches — could affect intensity.' });
  }
  if (awayFactors.fatigue < 0.75) {
    reasons.push({ tone: 'warn', weight: 0.7, tag: 'Fatigue',
      title: `${awayTeam.name} may be fatigued`,
      text: 'Short rest between matches — could affect intensity.' });
  }

  if (homeFactors.h2h > 0.7) {
    reasons.push({ tone: 'good', weight: 0.6, tag: 'Head to head',
      title: `${homeTeam.name} dominate this fixture`,
      text: `${hs} have the better recent head-to-head record.` });
  } else if (homeFactors.h2h < 0.3) {
    reasons.push({ tone: 'warn', weight: 0.6, tag: 'Head to head',
      title: `${awayTeam.name} dominate this fixture`,
      text: `${as_} have the better recent head-to-head record.` });
  }

  return reasons.sort((a, b) => b.weight - a.weight).slice(0, 5);
}

// ══════════════════════════════════════════════
// Analyze a match
// ══════════════════════════════════════════════
async function analyzeMatch(match, homeTeam, awayTeam) {
  const context = getMatchContext(match);
  context.neutral = match.neutral === true;

  const { homeFactors, awayFactors } = await computeMatchFactors(match, homeTeam, awayTeam);

  const weatherMult = await getWeatherMultiplier(
    homeTeam.latitude,
    homeTeam.longitude,
    match.date
  );

  const scoreDiff = computeFactorSignal(homeFactors, awayFactors, weatherMult);
  const confidence = computeConfidence(homeFactors, awayFactors, scoreDiff);

  // Factor signal now directly influences the expected goals
  const { homeXg, awayXg } = computeXg(
    homeTeam,
    awayTeam,
    weatherMult,
    context.neutral === true,
    scoreDiff
  );

  const probs = computeAllMarketProbs(homeXg, awayXg);

  // Final 1X2 probabilities come from the (Dixon-Coles) grid
  let homeWin = probs.home_win;
  let draw = probs.draw;
  let awayWin = probs.away_win;

  // Tiny safety: if most-likely score is a draw but draw prob is very low, gently lift it
  const correctScore = mostLikelyScore(homeXg, awayXg);
  const [csH, csA] = correctScore.split('-').map(Number);
  if (csH === csA && draw < 0.18) {
    const need = 0.18 - draw;
    draw += need;
    const total = homeWin + awayWin;
    if (total > 0) {
      homeWin -= need * (homeWin / total);
      awayWin -= need * (awayWin / total);
    }
  }

  const sum = homeWin + draw + awayWin;
  homeWin /= sum;
  draw /= sum;
  awayWin /= sum;

  const { bestMarket, bestProb, bestScore } = pickBestMarket(probs, confidence, context);

  let likelyResult = 'draw';
  if (homeWin > awayWin && homeWin > draw) likelyResult = 'home';
  else if (awayWin > homeWin && awayWin > draw) likelyResult = 'away';

  const secondary = pickSecondaryMarket(probs, bestMarket, likelyResult, context, 0.58);
  const reasons = buildReasons(homeTeam, awayTeam, homeFactors, awayFactors, probs, context);

  const pickText =
    likelyResult === 'home' ? `${homeTeam.name} win`
    : likelyResult === 'away' ? `${awayTeam.name} win`
    : 'Draw';

  const marketLabel = formatMarketLabel(bestMarket);
  const over25 = probs['over_2.5'] || 0;

  const conf = +confidence.toFixed(3);
  const handicapHighlights = {
    home_plus_2: { probability: +(probs['home_+2'] ?? 0).toFixed(4), confidence: conf },
    home_plus_3: { probability: +(probs['home_+3'] ?? 0).toFixed(4), confidence: conf },
    away_plus_2: { probability: +(probs['away_+2'] ?? 0).toFixed(4), confidence: conf },
    away_plus_3: { probability: +(probs['away_+3'] ?? 0).toFixed(4), confidence: conf },
  };

  return {
    home_win_prob: +homeWin.toFixed(4),
    draw_prob: +draw.toFixed(4),
    away_win_prob: +awayWin.toFixed(4),
    confidence: conf,
    home_xg: +homeXg.toFixed(2),
    away_xg: +awayXg.toFixed(2),
    predicted_correct_score: correctScore,
    best_market: {
      market: bestMarket,
      label: marketLabel,
      probability: +bestProb.toFixed(4),
      score: +bestScore.toFixed(4),
    },
    pick: marketLabel || pickText,
    secondary_pick: secondary
      ? { market: secondary.market, label: secondary.label, probability: +secondary.prob.toFixed(4) }
      : null,
    reasons,
    reason_short: reasons[0] ? `${reasons[0].title}. ${reasons[0].text}` : `Model picks ${marketLabel || pickText}.`,
    markets: [
      { key: 'Result', value: pickText.replace(' win', '') },
      { key: 'BTTS', value: probs.btts_yes > 0.5 ? 'Yes' : 'No' },
      { key: 'Goals', value: over25 > 0.5 ? 'Over 2.5' : 'Under 2.5' },
    ],
    home_factors: homeFactors,
    away_factors: awayFactors,
    markets_full: probs,
    correct_score_grid: correctScoreGrid(homeXg, awayXg, 20),
    handicap_highlights: handicapHighlights,
  };
}

// ══════════════════════════════════════════════
// Market labels
// ══════════════════════════════════════════════
function formatMarketLabel(market) {
  if (!market) return '';
  const map = {
    home_win: 'Home win', away_win: 'Away win', draw: 'Draw',
    '1X': 'Home or Draw', 'X2': 'Draw or Away', '12': 'Home or Away',
    dnb_home: 'Draw No Bet – Home', dnb_away: 'Draw No Bet – Away',
    btts_yes: 'BTTS – Yes', btts_no: 'BTTS – No',
    over_0_5: 'Over 0.5', over_1_5: 'Over 1.5', over_2_5: 'Over 2.5', over_3_5: 'Over 3.5', over_4_5: 'Over 4.5',
    under_0_5: 'Under 0.5', under_1_5: 'Under 1.5', under_2_5: 'Under 2.5', under_3_5: 'Under 3.5', under_4_5: 'Under 4.5',
    odd: 'Total goals – Odd', even: 'Total goals – Even',
    home_clean_sheet: 'Home clean sheet', away_clean_sheet: 'Away clean sheet',
    home_win_to_nil: 'Home win to nil', away_win_to_nil: 'Away win to nil',
    home_win_by_1: 'Home win by 1', home_win_by_2: 'Home win by 2', home_win_by_3plus: 'Home win by 3+',
    away_win_by_1: 'Away win by 1', away_win_by_2: 'Away win by 2', away_win_by_3plus: 'Away win by 3+',
    home_score_first: 'Home scores first', away_score_first: 'Away scores first', no_goals: 'No goals',
    btts_and_over_2_5: 'BTTS & Over 2.5', btts_and_under_2_5: 'BTTS & Under 2.5',
    no_btts_and_over_2_5: 'No BTTS & Over 2.5', no_btts_and_under_2_5: 'No BTTS & Under 2.5',
    home_win_btts_yes: 'Home win & BTTS', home_win_btts_no: 'Home win & No BTTS',
    draw_btts_yes: 'Draw & BTTS', draw_btts_no: 'Draw & No BTTS',
    away_win_btts_yes: 'Away win & BTTS', away_win_btts_no: 'Away win & No BTTS',
    'any_team_over_2.5_goals': 'Any team Over 2.5',
    'any_team_under_2.5_goals': 'Any team Under 2.5',
  };
  if (map[market]) return map[market];
  if (/^home_\+\d/.test(market)) return `Home +${market.split('+')[1]}`;
  if (/^away_\+\d/.test(market)) return `Away +${market.split('+')[1]}`;
  if (/^home_-\d/.test(market)) return `Home ${market.split('home')[1]}`;
  if (/^away_-\d/.test(market)) return `Away ${market.split('away')[1]}`;
  if (/^home_over_/.test(market)) return `Home ${market.replace('home_', '').replace('_', ' ')}`;
  if (/^away_over_/.test(market)) return `Away ${market.replace('away_', '').replace('_', ' ')}`;
  if (/^home_under_/.test(market)) return `Home ${market.replace('home_', '').replace('_', ' ')}`;
  if (/^away_under_/.test(market)) return `Away ${market.replace('away_', '').replace('_', ' ')}`;
  return market.replace(/_/g, ' ');
}

// ══════════════════════════════════════════════
// Compare teams
// ══════════════════════════════════════════════
async function compareTeams(home, away, neutral = false) {
  const fakeMatch = {
    date: new Date(),
    tournament: neutral ? 'Neutral Friendly' : 'Friendly',
    stage: 'friendly',
    home_team_id: home._id,
    away_team_id: away._id,
    neutral,
  };
  const result = await analyzeMatch(fakeMatch, home, away);

  return {
    neutral,
    home_team: {
      id: home._id, name: home.name, short: home.short, logo: home.logo, color: home.color,
      league: home.league,
      attack_rating: home.attack_rating ?? 1.0,
      defence_rating: home.defence_rating ?? 1.0,
      attack_rating_home: home.attack_rating_home ?? home.attack_rating ?? 1.0,
      attack_rating_away: home.attack_rating_away ?? home.attack_rating ?? 1.0,
      defence_rating_home: home.defence_rating_home ?? home.defence_rating ?? 1.0,
      defence_rating_away: home.defence_rating_away ?? home.defence_rating ?? 1.0,
      home_ppg: home.home_ppg ?? 1.5,
      away_ppg: home.away_ppg ?? 1.0,
    },
    away_team: {
      id: away._id, name: away.name, short: away.short, logo: away.logo, color: away.color,
      league: away.league,
      attack_rating: away.attack_rating ?? 1.0,
      defence_rating: away.defence_rating ?? 1.0,
      attack_rating_home: away.attack_rating_home ?? away.attack_rating ?? 1.0,
      attack_rating_away: away.attack_rating_away ?? away.attack_rating ?? 1.0,
      defence_rating_home: away.defence_rating_home ?? away.defence_rating ?? 1.0,
      defence_rating_away: away.defence_rating_away ?? away.defence_rating ?? 1.0,
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
  correctScoreGrid,
  mostLikelyScore,
  pickBestMarket,
  computeFactorSignal,
  computeConfidence,
  buildReasons,
  formatMarketLabel,
  poissonPmf,
  poissonCdf,
};