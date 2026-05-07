/**
 * source_mock.js v10.81 — HTTP-only, no Playwright.
 * fetch() receives (browser=null, options) — never uses browser arg.
 */
'use strict';

const { normalizeMatches } = require('../normalizer');

const MOCK_MATCHES = [
  { match_id:'mock_001', home:'Fenerbahçe', away:'Beşiktaş', hg:1, ag:0, status:'2H', minute:67, league_name:'Süper Lig', stats:{ attacks:52, dangerous_attacks:18, shots_total:9, shots_on_target:4, corners:5, possession_home:54, possession_away:46 }, odds:{ home:1.75, draw:3.40, away:4.50, over_25:1.85, btts_yes:1.90 } },
  { match_id:'mock_002', home:'Bayern München', away:'Borussia Dortmund', hg:2, ag:1, status:'HT', minute:45, league_name:'Bundesliga', stats:{ attacks:68, dangerous_attacks:24, shots_total:14, shots_on_target:6, corners:7, possession_home:61, possession_away:39 }, odds:{ home:1.45, draw:4.20, away:6.50, over_25:1.55, btts_yes:1.70 } },
  { match_id:'mock_003', home:'Arsenal', away:'Chelsea', hg:0, ag:0, status:'1H', minute:28, league_name:'Premier League', stats:{ attacks:31, dangerous_attacks:11, shots_total:5, shots_on_target:2, corners:3, possession_home:48, possession_away:52 }, odds:{ home:2.10, draw:3.30, away:3.40, over_25:2.00, btts_yes:1.80 } },
];

async function fetch(_browser, _options) {
  // _browser is always null for this adapter — HTTP-only
  await new Promise(r => setTimeout(r, 20));
  const fetchedAt = Date.now();
  const matches = MOCK_MATCHES.map(m => ({
    ...m, match_live:'1', match_status:m.status,
    match_id:m.match_id, match_hometeam_name:m.home, match_awayteam_name:m.away,
    match_hometeam_score:m.hg, match_awayteam_score:m.ag, fetchedAt,
  }));
  return {
    provider:'mock', success:true,
    matches: normalizeMatches(matches, 'mock'),
    error:null, fetchedAt,
  };
}

module.exports = { fetch, provider:'mock', needsPlaywright:false };
