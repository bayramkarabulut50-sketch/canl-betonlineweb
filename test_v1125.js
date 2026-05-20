const { normalizeMatches, mergeAdapterResults, splitLiveLayers } = require('./normalizer');
function m(id,home,away,source,status='1H',minute=10,league='Premier League', extra={}){return Object.assign({match_id:id,match_hometeam_name:home,match_awayteam_name:away,match_hometeam_score:0,match_awayteam_score:0,match_live:'1',match_status:status,minute,league_name:league,source,hasStats:false,hasOdds:false,stats:{}},extra)}
function assert(cond,msg){if(!cond){throw new Error(msg)}}
// Test 1: 13 senior raw => visible around 10-13
let raw=[]; for(let i=0;i<13;i++) raw.push(m('s'+i,'Team '+i,'Club '+i,'flashscore','1H',10+i,'Premier League'));
let norm=normalizeMatches(raw,'flashscore');
let merged=mergeAdapterResults([{provider:'flashscore_feed',success:true,matches:norm}]);
let split=splitLiveLayers(merged);
assert(split.visibleLiveMatches.length>=10 && split.visibleLiveMatches.length<=13,'13 senior should keep 10-13, got '+split.visibleLiveMatches.length);
// Test 2: noisy 180 gets capped/quarantined safely not 153/666
let noisy=[]; for(let i=0;i<180;i++) noisy.push(m('n'+i,'Модбери '+i,'Аделаида '+i,'flashscore','1',1,'АВСТРАЛИЯ: SA State League'));
let n2=normalizeMatches(noisy,'flashscore');
let mg2=mergeAdapterResults([{provider:'flashscore_feed',success:true,matches:n2}]);
assert(mg2.length < 70, 'noisy 180 should not remain high, got '+mg2.length);
// Test 3: stats ESPN is signal eligible
let e=normalizeMatches([m('e1','Nacional','Universitario','espn','2H',70,'ESPN Soccer',{hasStats:true,hasOdds:true,stats:{shots_total:18,shots_on_target:6,corners:8,possession_home:55,possession_away:45}})],'espn');
let sp=splitLiveLayers(e);
assert(sp.visibleLiveMatches.length===1,'ESPN stats visible');
assert(sp.signalEligibleMatches.length===1,'ESPN stats signal eligible');
// Test 4 reject final/scheduled/youth
let bad=normalizeMatches([m('f','A','B','espn','FT',90,'Premier League'), m('sch','C','D','espn','SCHEDULED',null,'Premier League'), m('u','U17 A','U17 B','flashscore','1H',30,'AFC Asian Cup U17')],'mixed');
assert(bad.length===0,'bad rows rejected got '+bad.length);
// Test 5 duplicate merge
let a=normalizeMatches([m('a','Boston River','OHiggins','flashscore','2H',70,'Primera Division')],'flashscore');
let b=normalizeMatches([m('b','Boston River','O\'Higgins','espn','2H',70,'ESPN Soccer',{hasStats:true,stats:{shots_total:{home:1,away:1}}})],'espn');
let mg=mergeAdapterResults([{provider:'flashscore_feed',success:true,matches:a},{provider:'espn_json',success:true,matches:b}]);
assert(mg.length===1,'duplicate merge expected 1 got '+mg.length);
console.log('v11.25 backend tests PASS', {senior:split.visibleLiveMatches.length,noisy:mg2.length,espnSignal:sp.signalEligibleMatches.length,duplicate:mg.length});
