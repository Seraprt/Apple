// ══════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════
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
// xG from team ratings
// ══════════════════════════════════════════════
function computeXg(home, away) {
  let homeXg = LEAGUE_AVG_HOME * (home.attack_rating || 1.0) * (away.defence_rating || 1.0);
  let awayXg = LEAGUE_AVG_AWAY * (away.attack_rating || 1.0) * (home.defence_rating || 1.0);

  // Small home-advantage adjustment based on home_ppg
  const homeBoost = 0.9 + (home.home_ppg || 1.5) * 0.1;
  const awayBoost = 0.9 + (away.away_ppg || 1.0) * 0.1;

  homeXg *= homeBoost;
  awayXg *= awayBoost;

  homeXg = clamp(homeXg, 0.3, 3.5);
  awayXg = clamp(awayXg, 0.3, 3.5);

  return { homeXg, awayXg };
}

// ══════════════════════════════════════════════
// All market probabilities via Poisson
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

  probs['home_win'] = homeWin;
  probs['draw'] = draw;
  probs['away_win'] = awayWin;

  probs['1X'] = homeWin + draw;
  probs['X2'] = draw + awayWin;
  probs['12'] = homeWin + awayWin;

  // Over/under totals
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
  probs['btts_yes'] = homeScores * awayScores;
  probs['btts_no'] = 1 - probs['btts_yes'];

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
// Pick best market (highest prob × confidence)
// ══════════════════════════════════════════════
function pickBestMarket(probs, confidence) {
  const excluded = ['under_0.5', 'over_5.5', 'under_5.5', 'over_6.5', 'under_6.5', 'over_7.5', 'under_7.5'];
  let bestMarket = null, bestScore = 0, bestProb = 0;

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
// Build reasons (plain English, two-line style)
// ══════════════════════════════════════════════
function buildReasons(home, away, probs) {
  const reasons = [];

  const homeAttack = home.attack_rating || 1.0;
  const homeDefence = home.defence_rating || 1.0;
  const awayAttack = away.attack_rating || 1.0;
  const awayDefence = away.defence_rating || 1.0;

  const hEdge = homeAttack - awayDefence;
  const aEdge = awayAttack - homeDefence;

  if (hEdge > 0.05) {
    reasons.push({
      tone: 'good',
      weight: clamp(hEdge * 1.7, 0.3, 0.95),
      tag: 'Attack vs defence',
      title: `${home.name} attack outmatches ${away.name} defence`,
      text: `${home.name} carry a ${Math.round(homeAttack * 100)} attack rating into a back line rated ${Math.round(awayDefence * 100)}. That gap is worth roughly ${(hEdge * 1.9).toFixed(2)} expected goals.`,
    });
  }

  if (aEdge > 0.05) {
    reasons.push({
      tone: 'warn',
      weight: clamp(aEdge * 1.7, 0.3, 0.95),
      tag: 'Counter threat',
      title: `${away.name} can hurt ${home.name} going forward`,
      text: `${away.name} rate ${Math.round(awayAttack * 100)} in attack against a ${home.name} defence at ${Math.round(homeDefence * 100)}. Expect at least a couple of clear chances.`,
    });
  }

  if ((away.away_ppg || 1.0) < 0.35) {
    reasons.push({
      tone: 'bad',
      weight: 0.92,
      tag: 'Away form',
      title: `${away.name} are a poor travelling side`,
      text: `Away strength of ${(away.away_ppg || 0).toFixed(2)} sits below our 0.35 danger line. They drop points on the road and concede early — the model prices that in heavily.`,
    });
  }

  if ((home.home_ppg || 1.5) > 0.82) {
    reasons.push({
      tone: 'good',
      weight: 0.78,
      tag: 'Home strength',
      title: `${home.name} are strong at home`,
      text: `Home strength of ${(home.home_ppg || 0).toFixed(2)} puts them in the top bracket. They convert chances at a much higher rate in front of their own crowd.`,
    });
  }

  return reasons.sort((a, b) => b.weight - a.weight).slice(0, 4);
}

// ══════════════════════════════════════════════
// Full compare function
// ══════════════════════════════════════════════
function compareTeams(home, away) {
  const { homeXg, awayXg } = computeXg(home, away);
  const probs = computeAllMarketProbs(homeXg, awayXg);

  // Confidence heuristic — same style as Python
  const ratingSpread = Math.abs(
    (home.attack_rating || 1) - (away.attack_rating || 1)
  ) + Math.abs((home.defence_rating || 1) - (away.defence_rating || 1));
  const maxProb = Math.max(probs.home_win, probs.draw, probs.away_win);
  const confidence = clamp(0.5 + ratingSpread * 0.3 + (maxProb - 0.33) * 0.5, 0.35, 0.95);

  const { bestMarket, bestProb } = pickBestMarket(probs, confidence);
  const correctScore = mostLikelyScore(homeXg, awayXg);

  let winner = 'Draw';
  if (probs.home_win > probs.away_win && probs.home_win > probs.draw) winner = home.name;
  else if (probs.away_win > probs.home_win && probs.away_win > probs.draw) winner = away.name;

  const reasons = buildReasons(home, away, probs);

  const pick =
    winner === 'Draw' ? 'Draw' : `${winner} win`;

  // Two-line reason short
  const top = reasons[0];
  const reasonShort = top
    ? `${top.title}. ${top.text}`
    : `Model gives ${pick} with ${(Math.max(probs.home_win, probs.draw, probs.away_win) * 100).toFixed(0)}% probability.`;

  // Markets summary (for card chips)
  const markets = [
    { key: 'Result', value: winner === 'Draw' ? 'Draw' : winner.split(' ')[0] },
    { key: 'BTTS', value: probs.btts_yes > 0.5 ? 'Yes' : 'No' },
    { key: 'Goals', value: probs.over_2_5 > 0.5 ? 'Over 2.5' : 'Under 2.5' },
    {
      key: 'Double',
      value: winner === home.name
        ? (probs.draw > probs.away_win ? '1X' : '12')
        : winner === away.name
        ? (probs.draw > probs.home_win ? 'X2' : '12')
        : (probs.home_win > probs.away_win ? '1X' : 'X2'),
    },
  ];

  return {
    home_team: {
      id: home._id, name: home.name, short: home.short,
      logo: home.logo, color: home.color,
    },
    away_team: {
      id: away._id, name: away.name, short: away.short,
      logo: away.logo, color: away.color,
    },
    home_xg: +homeXg.toFixed(2),
    away_xg: +awayXg.toFixed(2),
    home_win_prob: +probs.home_win.toFixed(4),
    draw_prob: +probs.draw.toFixed(4),
    away_win_prob: +probs.away_win.toFixed(4),
    winner,
    pick,
    confidence: +confidence.toFixed(3),
    predicted_correct_score: correctScore,
    best_market: { market: bestMarket, probability: +bestProb.toFixed(4) },
    markets,
    reasons,
    reason_short: reasonShort,
  };
}

module.exports = {
  computeXg,
  computeAllMarketProbs,
  mostLikelyScore,
  pickBestMarket,
  buildReasons,
  compareTeams,
  poissonPmf,
  poissonCdf,
};