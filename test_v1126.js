'use strict';
const assert = require('assert');
const { normalizeMatches, mergeAdapterResults, splitLiveLayers, isStaleRiskMatch, monitorReason } = require('./normalizer');
function m(id, home, away, opts={}) { return Object.assign({match_id:id, match_hometeam_name:home, match_awayteam_name:away, match_hometeam_score:0, match_awayteam_score:0, match_live:'1', match_status:'1H', minute:20, league_name:'Major League Soccer', stats:{shots_total:5, shots_on_target:2, corners:3, possession_home:55, possession_away:45}, odds:{over_25:2.1}}, opts); }
// 1 visible/signal split
let espn = normalizeMatches([m('e1','Alpha FC','Beta FC'), m('e2','Gamma FC','Delta FC',{stats:{}, odds:{}, source:'espn'})], 'espn');
assert(espn.length>=1);
let split = splitLiveLayers(espn);
assert(split.visibleLiveMatches.length >= 1);
assert(split.signalEligibleMatches.length >= 1);
// 2 stale risk
let stale = normalizeMatches([m('s1','Echo FC','Foxtrot FC',{minute:91, stats:{}, odds:{}, league_name:'Major League Soccer'})], 'espn');
assert.strictEqual(isStaleRiskMatch(stale[0]), true);
assert.strictEqual(monitorReason(stale[0]), 'stale_risk_90_plus');
// 3 finished reject
assert.strictEqual(normalizeMatches([m('f1','Green FC','Harbor FC',{match_status:'FT', minute:90})], 'espn').length, 0);
// 4 scheduled reject
assert.strictEqual(normalizeMatches([m('p1','Green FC','Harbor FC',{match_status:'SCHEDULED', minute:null})], 'espn').length, 0);
// 5 youth reject
assert.strictEqual(normalizeMatches([m('u1','Team U17','Other U17',{league_name:'U17 Cup'})], 'flashscore').length, 0);
// 6 low-data senior visible basic flashscore
let flash = normalizeMatches([m('fl1','Columbus Crew','New York City FC',{stats:{}, odds:{}, league_name:'Major League Soccer', source:'flashscore', minute:16})], 'flashscore');
assert(flash.length === 1, 'senior low-data flashscore should remain visible');
split = splitLiveLayers(flash);
assert.strictEqual(split.visibleLiveMatches.length, 1);
assert.strictEqual(split.signalEligibleMatches.length, 0);
assert.strictEqual(split.lowDataVisibleCount, 1);
// 7 duplicate merge ESPN wins/enriches
const r1 = {provider:'espn_json', success:true, matches:normalizeMatches([m('x1','Boston River','OHiggins',{league_name:'ESPN Soccer'})], 'espn')};
const r2 = {provider:'flashscore_feed', success:true, matches:normalizeMatches([m('x2','Boston River','O Higgins',{league_name:'Primera Division', stats:{}, odds:{}, source:'flashscore'})], 'flashscore')};
let merged = mergeAdapterResults([r1,r2]);
assert.strictEqual(merged.length, 1);
// 8 noisy batch should cap/not explode
let noisy=[]; for(let i=0;i<180;i++) noisy.push(m('n'+i,'Team'+i,'Club'+i,{league_name:'State League', source:'flashscore', stats:{}, odds:{}}));
let nr = normalizeMatches(noisy,'flashscore');
assert(nr.length === 0, 'noisy state league should be rejected');
console.log('v11.26 backend tests PASS');
