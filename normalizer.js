/**
 * normalizer.js — CanliBet Scraper Service v11.24
 *
 * Converts any source adapter output → canonical match format.
 * v11.24: calibrated coverage/signal pipeline, stricter Flashscore noise control,
 * dynamic visible caps and explainable dual-layer validation.
 */
'use strict';

const { computeRealStatsSignals, generateRealSignals } = require('./signal-engine');

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeNum(v, fallback = null) {
  if (v == null || v === '' || v === '-') return fallback;
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}

function safeStr(v, fallback = '') {
  return (v != null && String(v).trim()) || fallback;
}

function safeScore(v, fallback = 0) {
  if (v == null) return fallback;
  const n = parseInt(String(v), 10);
  return isNaN(n) ? fallback : n;
}

function normTeamName(name) {
  if (!name) return '';
  return String(name).trim().replace(/\s+/g, ' ');
}

function asciiFold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’'`´]/g, '')
    .trim();
}

function compactText(s) {
  return asciiFold(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonicalTeamName(name) {
  return compactText(name)
    .replace(/\b(fc|sc|cf|afc|ac|as|fk|nk|sk|club|team|u\d{2}|women|w)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strict minute parsing — rejects NaN, booleans, timestamps, arrays, flags.
 * Returns integer 0-130 or null.
 */
function normMinute(raw) {
  if (raw == null || raw === '' || typeof raw === 'boolean') return null;
  if (Array.isArray(raw)) return null;
  const s = String(raw).replace(/['+\s].*/g, '').trim();  // strip +extras like '45+2'→'45'
  // Reject obvious timestamps (7+ digit numbers)
  if (/^\d{7,}$/.test(s)) return null;
  const n = parseInt(s, 10);
  if (isNaN(n) || n < 0 || n > 150) return null;
  return Math.min(n, 130);
}

function normOdds(v) {
  if (v == null || v === '-' || v === '') return null;
  const s = String(v).trim();
  if (s.includes('/')) {
    const [num, den] = s.split('/').map(Number);
    if (!isNaN(num) && !isNaN(den) && den !== 0) return +(num / den + 1).toFixed(3);
    return null;
  }
  if (s.startsWith('+') || s.startsWith('-')) {
    const n = Number(s);
    if (isNaN(n)) return null;
    return n >= 0 ? +(n / 100 + 1).toFixed(3) : +(100 / Math.abs(n) + 1).toFixed(3);
  }
  const n = Number(s);
  return (isNaN(n) || n < 1.01) ? null : +n.toFixed(3);
}

// ── Live status classification ────────────────────────────────────────────────

/**
 * Comprehensive live status set covering ESPN, Flashscore, FotMob, TheSportsDB,
 * OpenLigaDB and custom adapter values.
 * v11.22: expanded to cover STATUS_* ESPN variants, state:'in', period-based.
 */
const LIVE_STATUS_SET = new Set([
  // Generic
  'live', 'in play', 'in_play', 'inplay',
  // Period labels
  '1h', '2h', 'ht', 'halftime', 'half time', 'half_time', 'halfime',
  'et', 'extra time', 'extra_time', 'aet',
  'pen', 'penalty', 'penalties', 'penalty shootout',
  // ESPN STATUS_* values (uppercase and lowercase)
  'status_in_progress', 'status_halftime', 'status_half_time',
  'status_first_half', 'status_second_half',
  'status_end_period', 'status_extra_time', 'status_extra_time_half_time',
  'status_first_extra', 'status_second_extra',
  'status_overtime', 'status_penalty', 'status_penalties',
  'status_awaiting_penalties', 'status_penalty_shootout',
  'status_delayed', 'status_suspended', 'status_interrupted',
  // ESPN compact state values
  'in', 'in_progress',
  // Flashscore / other
  'delayed', 'suspended', 'interrupted',
]);

const FINAL_STATUS_SET = new Set([
  'ft', 'full_time', 'full time', 'finished', 'final', 'ended', 'completed',
  'status_full_time', 'status_final', 'status_final_pen', 'status_final_aet',
  'status_postponed', 'status_canceled', 'status_cancelled', 'status_abandoned',
  'postponed', 'canceled', 'cancelled', 'abandoned', 'walkover',
  'after pen', 'after extra time', 'aet', 'ap',
  'post',
]);

const SCHEDULED_STATUS_SET = new Set([
  'scheduled', 'pre', 'pregame', 'ns', 'not started', 'not_started', 'tbd',
  'status_scheduled', 'status_pregame',
]);

/**
 * Classify a raw status string into 'live' | 'final' | 'scheduled' | 'unknown'.
 * Handles ESPN STATUS_* values, Flashscore compact codes, and numeric minute strings.
 */
function classifyStatus(rawStatus) {
  if (!rawStatus && rawStatus !== 0) return 'unknown';
  const s = String(rawStatus).toLowerCase().trim();
  if (!s) return 'unknown';

  if (LIVE_STATUS_SET.has(s)) return 'live';
  if (FINAL_STATUS_SET.has(s)) return 'final';
  if (SCHEDULED_STATUS_SET.has(s)) return 'scheduled';

  // Numeric minute string (including '45+2' format) → live
  const n = parseInt(s.replace(/['+\s].*/g, ''), 10);
  if (!isNaN(n) && n > 0 && n <= 130) return 'live';

  // Regex patterns for edge cases
  if (/\b(in[_\s-]?progress|first[_\s-]?half|second[_\s-]?half|half[_\s-]?time|halftime|end[_\s-]?period|extra[_\s-]?time|penalt)\b/.test(s)) return 'live';
  if (/\b(full[_\s-]?time|final|finished|postponed|cancel|abandon)\b/.test(s)) return 'final';
  if (/\b(scheduled|pregame)\b/.test(s)) return 'scheduled';

  return 'unknown';
}

/**
 * Determine if a raw match object should be considered live.
 * Priority order:
 * 1. Explicit match_live='1' from adapter → live (adapter already decided)
 * 2. Explicit completed=true → final (ESPN)
 * 3. Status classification
 * 4. Minute-based fallback (only if not scheduled/final)
 */
function isLiveMatch(raw) {
  // ── Step 1: Hard final signals override EVERYTHING ────────────────────
  // completed=true (ESPN) is a hard reject regardless of match_live flag
  if (raw.completed === true) return false;
  const statusType = raw.statusType || raw.status_type || {};
  if (statusType.completed === true) return false;

  // ── Step 2: Status string classification (highest priority after completed) ──
  // This overrides match_live flag — adapters sometimes set match_live='1'
  // on FINISHED or SCHEDULED matches incorrectly.
  const statusRaw = raw.match_status ?? raw.status ?? raw.state ?? raw.match_state ?? '';
  const statusClass = classifyStatus(statusRaw);

  if (statusClass === 'final') return false;       // FINISHED/FT/FULL_TIME → never live
  if (statusClass === 'scheduled') return false;   // SCHEDULED/PRE → never live
  if (statusClass === 'live') return true;          // explicit live status → live

  // ── Step 3: status is 'unknown' — now trust match_live flag ──────────
  if (raw.match_live === '1' || raw.match_live === true) return true;

  // State field (ESPN state:'in')
  if (raw.state && String(raw.state).toLowerCase() === 'in') return true;

  // ── Step 4: Minute-based fallback (only for unknown status) ──────────
  const min = normMinute(raw.minute ?? raw.elapsed ?? raw.match_elapsed ?? raw.min);
  if (min != null && min > 0 && min < 130) return true;

  return false;
}

// ── Impossible count guard ────────────────────────────────────────────────────


// ── Canonical quality / betting relevance ───────────────────────────────────

const EXCLUDED_COMPETITION_RE = new RegExp([
  // Never include non-betting / artificial feeds
  '\\bu\\s?1[5-9]\\b','\\bu\\s?2[0-3]\\b','\\bu15\\b','\\bu16\\b','\\bu17\\b','\\bu18\\b','\\bu19\\b','\\bu20\\b','\\bu21\\b','\\bu23\\b',
  'u-17','u-19','under\\s?17','under\\s?19','youth','junior','juniors','academy','academia',
  'reserves?','reserve\\s?league','b team','women','womens','women\\s','female','feminine','\\bii\\b','\\b2\\b',
  'friendly','friendlies','club friendly','international friendly','pre-season','preseason',
  'virtual','esoccer','e-soccer','cyber','simulated','simulation','fifa\\s?e',
  'school','college','university','student',
  'state league','state league 1','state league 2','regional league','county league','amateur league',
  'npl queensland','npl victoria','npl western australia','npl nsw','npl south australia',
  'play offs','play-off','playoffs','relegation group','promotion group',
  'ю17','ю19','молод','младеж','юнош'
].join('|'), 'i');

function hasExcludedCompetitionText(m) {
  const txt = [m.league_name, m.match_hometeam_name, m.match_awayteam_name, m.competition, m.sourceLeague].map(v=>String(v||'')).join(' ');
  return EXCLUDED_COMPETITION_RE.test(txt);
}


const TRUSTED_FLASH_COMPETITION_RE = new RegExp([
  'premier league','championship','league one','league two','laliga','la liga','serie a','serie b',
  'bundesliga','ligue 1','ligue 2','eredivisie','primeira liga','super lig','süper lig',
  'pro league','jupiler','major league soccer','mls','us open cup','nwsl',
  'champions league','europa league','conference league','libertadores','sudamericana',
  'brasileiro','serie a','primera division','primera división','liga mx',
  'allsvenskan','eliteserien','superliga','a-league','j1 league','k league','saudi pro league'
].join('|'), 'i');

function isFlashscoreSource(m) {
  return String(m.source || m._mergeProvider || '').toLowerCase().includes('flashscore');
}

function isTrustedFlashCompetition(m) {
  const txt = [m.league_name, m.competition, m.sourceLeague].map(v=>String(v||'')).join(' ');
  return TRUSTED_FLASH_COMPETITION_RE.test(txt);
}


const NOISY_FLASH_COMPETITION_RE = new RegExp([
  'state league','npl queensland','npl victoria','npl western australia','npl nsw','npl south australia',
  'regional','county','amateur','lower league','reserve','reserves','youth','u17','u18','u19','u20','u21','u23',
  'women','friendly','play offs','play-off','qualification - play off','relegation','promotion',
  'bundesliga - conference league play offs','conference league play offs'
].join('|'), 'i');

function isNoisyFlashCompetition(m) {
  const txt = [m.league_name, m.competition, m.sourceLeague].map(v=>String(v||'')).join(' ');
  return NOISY_FLASH_COMPETITION_RE.test(txt);
}

function isFlashscoreBasicRow(m) {
  return isFlashscoreSource(m) && !m.hasStats && !m.hasOdds;
}

function flashscoreSeniorVisibleAllowed(m) {
  if (!isFlashscoreSource(m)) return true;
  if (!isFlashscoreBasicRow(m)) return true;
  if (isNoisyFlashCompetition(m)) return false;
  if (hasExcludedCompetitionText(m)) return false;
  if (hasMostlyNonLatinText(m)) return false;
  // For basic x-feed rows, require either a trusted named league or a broad senior/pro cue.
  return isTrustedFlashCompetition(m) || hasSeniorProfessionalSignal(m);
}

function hasMostlyNonLatinText(m) {
  const txt = [m.league_name, m.match_hometeam_name, m.match_awayteam_name].map(v=>String(v||'')).join(' ');
  const letters = (txt.match(/[A-Za-zÀ-ž\u0400-\u04FF\u0370-\u03FF]/g) || []).length;
  const latin = (txt.match(/[A-Za-zÀ-ž]/g) || []).length;
  const cyr = (txt.match(/[\u0400-\u04FF]/g) || []).length;
  if (letters < 6) return false;
  return cyr > 0 && (latin / Math.max(letters, 1)) < 0.35;
}

function hasBrokenTeamNames(m) {
  const home = String(m.match_hometeam_name || '');
  const away = String(m.match_awayteam_name || '');
  if (!home || !away) return true;
  if (home.length < 2 || away.length < 2) return true;
  // Reject protocol fragments or obvious parse corruption.
  if (/[÷¬~{}<>]/.test(home + away)) return true;
  // Do not hard reject all non-latin, but reject if there are almost no letters/numbers.
  const plain = (home + away).replace(/[\s\-_.()]/g, '');
  if (plain.length < 4) return true;
  return false;
}


function hasSeniorProfessionalSignal(m) {
  const txt = compactText([m.league_name, m.competition, m.sourceLeague].map(v=>String(v||'')).join(' '));
  if (!txt) return false;
  return /premier|serie a|serie b|la liga|laliga|bundesliga|ligue 1|ligue 2|championship|league one|league two|eredivisie|primeira|super lig|süper lig|pro league|jupiler|major league soccer|mls|allsvenskan|eliteserien|superliga|a league|j1 league|k league|saudi pro|libertadores|sudamericana|champions league|europa league|conference league|national league|primera division|primera división|liga mx|belgian|austrian|swiss|turkish|english|italian|spanish|german|french|dutch|portuguese|brazil|argentina|mexico|norway|sweden|denmark|finland|poland|czech|greek|croatia|serbia|romania|bulgaria|ireland|scotland|australia|japan|china|korea|india|indonesia|thailand|malaysia/.test(txt);
}

function hasRealLiveClock(m) {
  const minute = normMinute(m.minute);
  if (minute != null && minute > 0 && minute <= 130) return true;
  const st = String(m.match_status || '').toUpperCase();
  return /\b(1H|2H|HT|LIVE|IN_PROGRESS|HALFTIME|FIRST_HALF|SECOND_HALF|ET|DELAYED|SUSPENDED)\b/.test(st);
}

function validationReasonBucket(reasons) {
  const rs = Array.isArray(reasons) ? reasons : [];
  if (rs.some(r => /excluded_competition|youth|friendly|reserve|women|simulation/i.test(r))) return 'excluded_competition';
  if (rs.some(r => /final|completed/i.test(r))) return 'finished';
  if (rs.some(r => /scheduled/i.test(r))) return 'scheduled';
  if (rs.some(r => /invalid_team/i.test(r))) return 'invalid_team_names';
  if (rs.some(r => /missing_minute|invalid_minute|no_real_clock/i.test(r))) return 'missing_or_invalid_minute';
  if (rs.some(r => /flashscore_untrusted_basic|flashscore_noisy|flashscore_non_latin/i.test(r))) return 'flashscore_quality_rejected';
  if (rs.some(r => /quality_low|no_stats/i.test(r))) return 'quality_low';
  return rs[0] || 'unknown';
}

function isSignalEligibleMatch(m) {
  if (!m || m.match_live !== '1') return false;
  if ((m.validationScore || 0) >= 70 && (m.hasStats || (m.signalCount || 0) > 0)) return true;
  if (m.hasStats && (m.dataReliabilityScore || 0) >= 55 && (m.validationScore || 0) >= 55) return true;
  if ((m.signalCount || 0) > 0 || m.topSignal) return true;
  return false;
}

function splitLiveLayers(matches) {
  const visibleLiveMatches = [];
  const signalEligibleMatches = [];
  const rejectedMatches = [];
  const rejectedReasons = {};
  const providerCounts = {};
  const signalEligibleProviderCounts = {};
  const lowDataVisible = [];

  for (const m of (Array.isArray(matches) ? matches : [])) {
    const reasons = Array.isArray(m.validationReasons) ? m.validationReasons : [];
    const rejectReason = validationReasonBucket(reasons);
    if (!m || m.match_live !== '1' || (m.validationScore || 0) < 35) {
      rejectedMatches.push(m);
      rejectedReasons[rejectReason] = (rejectedReasons[rejectReason] || 0) + 1;
      continue;
    }
    visibleLiveMatches.push(m);
    const provider = m._mergeProvider || m.source || 'unknown';
    providerCounts[provider] = (providerCounts[provider] || 0) + 1;
    if (!m.hasStats) lowDataVisible.push(m);
    if (isSignalEligibleMatch(m)) {
      signalEligibleMatches.push(m);
      signalEligibleProviderCounts[provider] = (signalEligibleProviderCounts[provider] || 0) + 1;
    }
  }

  const visibleVsRawRatio = matches && matches.length ? visibleLiveMatches.length / matches.length : 0;
  const statsCoverageRatio = visibleLiveMatches.length ? visibleLiveMatches.filter(m=>m.hasStats).length / visibleLiveMatches.length : 0;
  const oddsCoverageRatio = visibleLiveMatches.length ? visibleLiveMatches.filter(m=>m.hasOdds).length / visibleLiveMatches.length : 0;
  const signalGenerationRate = visibleLiveMatches.length ? visibleLiveMatches.filter(m=>(m.signalCount||0)>0).length / visibleLiveMatches.length : 0;

  return {
    visibleLiveMatches,
    signalEligibleMatches,
    rejectedMatches,
    rejectedReasons,
    visibleProviderCounts: providerCounts,
    signalEligibleProviderCounts,
    lowDataVisibleCount: lowDataVisible.length,
    health: {
      providerCoverageScore: Math.min(100, visibleLiveMatches.length * 6),
      liveValidationScore: Math.round(visibleVsRawRatio * 100),
      signalGenerationRate: Number(signalGenerationRate.toFixed(3)),
      visibleVsRawRatio: Number(visibleVsRawRatio.toFixed(3)),
      rejectedRatio: matches && matches.length ? Number(((matches.length-visibleLiveMatches.length)/matches.length).toFixed(3)) : 0,
      duplicateRatio: 0,
      statsCoverageRatio: Number(statsCoverageRatio.toFixed(3)),
      oddsCoverageRatio: Number(oddsCoverageRatio.toFixed(3)),
    }
  };
}

function computeValidation(m) {
  const reasons = [];
  let score = 58;

  const statusClass = m._statusClass || classifyStatus(m.match_status);
  const minute = normMinute(m.minute);

  if (hasBrokenTeamNames(m)) { score -= 45; reasons.push('invalid_team_names'); }
  if (hasExcludedCompetitionText(m)) { score -= 70; reasons.push('excluded_competition'); }

  if (statusClass === 'final') { score -= 100; reasons.push('final_status'); }
  if (statusClass === 'scheduled') { score -= 100; reasons.push('scheduled_status'); }
  if (m.completed === true) { score -= 100; reasons.push('completed_true'); }

  if (minute == null) { score -= 32; reasons.push('missing_minute'); }
  else if (minute <= 0 || minute > 130) { score -= 60; reasons.push('invalid_minute'); }
  else { score += 15; reasons.push('valid_minute'); }

  if (m.hasStats) { score += 22; reasons.push('has_stats'); }
  else { score -= 4; reasons.push('no_stats'); }

  if (m.hasOdds) { score += 8; reasons.push('has_odds'); }
  if (m.source === 'espn' || m.source === 'espn_json') { score += 18; reasons.push('espn_verified'); }
  if (hasSeniorProfessionalSignal(m)) { score += 10; reasons.push('senior_professional_signal'); }
  if (isFlashscoreSource(m)) {
    score += 3; reasons.push('flashscore_feed');

    // v11.24: Flashscore/Livesport x-feed gives great coverage but can include
    // hundreds of low-value/noisy rows. Basic rows are visible only when they
    // have clear senior/pro competition cues; otherwise they are rejected before
    // they can inflate the dashboard to 95/153/666.
    if (isFlashscoreBasicRow(m)) {
      reasons.push('flashscore_basic_no_stats_odds');
      if (isTrustedFlashCompetition(m)) { score += 24; reasons.push('trusted_flash_competition'); }
      else if (hasSeniorProfessionalSignal(m)) { score += 8; reasons.push('senior_flash_competition'); }
      else { score -= 52; reasons.push('flashscore_untrusted_basic_rejected'); }

      if (isNoisyFlashCompetition(m)) { score -= 55; reasons.push('flashscore_noisy_competition_rejected'); }
      if (hasMostlyNonLatinText(m)) { score -= 35; reasons.push('flashscore_non_latin_rejected'); }
    } else {
      // Stats/odds-backed Flashscore rows are much more reliable.
      score += 14; reasons.push('flashscore_enriched');
      if (isTrustedFlashCompetition(m) || hasSeniorProfessionalSignal(m)) score += 10;
    }
  }

  // Flashscore rows without real minute/status are too noisy: require minute or explicit HT/LIVE text.
  if (isFlashscoreSource(m) && minute == null && !/\b(HT|LIVE|1H|2H|ET)\b/i.test(String(m.match_status||''))) {
    score -= 45; reasons.push('flashscore_no_real_clock');
  }

  // Senior Flashscore rows with a real clock can be visible even without stats,
  // but only if they pass the senior/pro allow-list above.
  if (isFlashscoreSource(m) && minute != null && minute > 0 && minute <= 120 && flashscoreSeniorVisibleAllowed(m)) {
    score += 18; reasons.push('flashscore_valid_clock_visible');
  }

  const validationScore = Math.max(0, Math.min(100, Math.round(score)));
  let tier = 'LOW';
  if (validationScore >= 75) tier = 'HIGH';
  else if (validationScore >= 55) tier = 'MEDIUM';
  else if (validationScore >= 40) tier = 'WATCH_ONLY';

  return { validationScore, validationTier:tier, validationReasons:reasons, statusClass, minute };
}

/**
 * Validates a batch of matches from a single provider.
 * Returns { ok, reason } — if !ok, provider should be quarantined.
 */
function validateProviderBatch(matches, providerName) {
  if (!Array.isArray(matches)) return { ok: true };
  const count = matches.length;
  if (count > 220) {
    return { ok: false, reason: `impossible_count:${count}>220`, quarantine: true };
  }
  if (providerName === 'flashscore' || providerName === 'flashscore_feed') {
    const weak = matches.filter(m => (m.validationScore || 0) < 35 || m.minute == null).length;
    if (count > 140 && weak / Math.max(count,1) > 0.75) {
      return { ok:false, reason:`flashscore_low_quality_batch:${weak}/${count}`, quarantine:true };
    }
  }
  // Do not quarantine a public live-score feed merely because it lacks stats.
  // Stats-less rows are visible-only; signal engine handles them safely.
  if (count > 240) {
    return { ok:false, reason:`impossible_provider_count:${count}>240`, quarantine:true };
  }
  return { ok: true };
}

// ── Canonical factory ─────────────────────────────────────────────────────────


function makeCanonical(raw, source) {
  const hg = safeScore(raw.match_hometeam_score ?? raw.home_score ?? raw.hg ?? raw.scoreHome);
  const ag = safeScore(raw.match_awayteam_score ?? raw.away_score ?? raw.ag ?? raw.scoreAway);

  const statusRaw = safeStr(raw.match_status ?? raw.status ?? raw.state ?? '');
  const live = isLiveMatch(raw);

  // Strict minute parsing
  const minute = normMinute(raw.minute ?? raw.elapsed ?? raw.match_elapsed ?? raw.min);

  // Validate: if live=true but minute is null AND status is empty → suspicious
  // We allow this (Flashscore may not always have minute)

  const rawStats = raw.stats || raw.statistics || {};
  const stats = {
    attacks:           safeNum(rawStats.attacks),
    dangerous_attacks: safeNum(rawStats.dangerous_attacks ?? rawStats.dangerousAttacks),
    shots_total:       safeNum(rawStats.shots_total ?? rawStats.shotsTotal),
    shots_on_target:   safeNum(rawStats.shots_on_target ?? rawStats.shotsOnTarget),
    corners:           safeNum(rawStats.corners ?? rawStats.won_corners ?? rawStats.corner_kicks ?? rawStats.cornerKicks),
    possession_home:   safeNum(rawStats.possession_home ?? rawStats.possessionHome ?? rawStats.home_possession),
    possession_away:   safeNum(rawStats.possession_away ?? rawStats.possessionAway ?? rawStats.away_possession),
    yellow_cards:      safeNum(rawStats.yellow_cards ?? rawStats.yellowCards),
    red_cards:         safeNum(rawStats.red_cards ?? rawStats.redCards),
  };

  const rawOdds = raw.odds || raw.markets || {};
  const odds = {
    home:    normOdds(rawOdds.home ?? rawOdds.win_home ?? rawOdds['1']),
    draw:    normOdds(rawOdds.draw ?? rawOdds.win_draw ?? rawOdds['X']),
    away:    normOdds(rawOdds.away ?? rawOdds.win_away ?? rawOdds['2']),
    over_05: normOdds(rawOdds.over_05 ?? rawOdds.over_0_5 ?? rawOdds['over0.5']),
    over_15: normOdds(rawOdds.over_15 ?? rawOdds.over_1_5 ?? rawOdds['over1.5']),
    over_25: normOdds(rawOdds.over_25 ?? rawOdds.over_2_5 ?? rawOdds['over2.5']),
    btts_yes:normOdds(rawOdds.btts_yes ?? rawOdds.btts ?? rawOdds['gg']),
  };

  const hasOdds = Object.values(odds).some(v => v !== null);
  const hasStats = Object.values(stats).some(v => v !== null);

  const canonical = {
    match_id:             safeStr(raw.match_id ?? raw.fixture_id ?? raw.id ?? ''),
    match_hometeam_name:  normTeamName(raw.match_hometeam_name ?? raw.home ?? raw.homeTeam ?? ''),
    match_awayteam_name:  normTeamName(raw.match_awayteam_name ?? raw.away ?? raw.awayTeam ?? ''),
    match_hometeam_score: hg,
    match_awayteam_score: ag,
    match_live:           live ? '1' : '0',
    match_status:         statusRaw,
    minute,
    league_name:          safeStr(raw.league_name ?? raw.competition ?? raw.league ?? ''),
    source:               safeStr(source ?? raw.source ?? 'unknown'),
    fetchedAt:            raw.fetchedAt ?? Date.now(),
    hasOdds,
    hasStats,
    stats,
    odds,
    // Carry through debug fields from adapter
    _statusClass:         classifyStatus(statusRaw),
    _liveReason:          live
      ? (raw.match_live === '1' ? 'adapter_set' : 'status_class:' + classifyStatus(statusRaw))
      : 'not_live',
    _rawSourceStatus:     raw.match_status ?? raw.status ?? raw.state ?? '',
    _rawSourceMinute:     raw.minute ?? raw.elapsed ?? raw.match_elapsed ?? raw.min ?? null,
  };

  const quality = computeValidation(canonical);
  canonical.validationScore = quality.validationScore;
  canonical.validationTier = quality.validationTier;
  canonical.validationReasons = quality.validationReasons;
  canonical.qualityRejected = quality.validationScore < 40;

  canonical.derived = computeRealStatsSignals(canonical);
  const signalPack = generateRealSignals(canonical);
  canonical.signals = signalPack.signals;
  canonical.topSignal = signalPack.topSignal;
  canonical.signalCount = signalPack.signalCount;
  canonical.actionabilityScore = signalPack.actionabilityScore;
  canonical.signalMode = signalPack.signalMode;
  canonical.signalBlockReasons = signalPack.signalBlockReasons;
  canonical.dataReliabilityScore = canonical.derived.dataReliabilityScore;
  canonical.pressureScore = canonical.derived.pressureScore;
  canonical.tempoScore = canonical.derived.tempoScore;
  canonical.momentumScore = canonical.derived.momentumScore;
  canonical.xgProxy = canonical.derived.xgProxy;
  canonical.transitionReadiness = canonical.derived.transitionReadiness;

  return canonical;
}

/**
 * Normalize an array of raw matches from one adapter.
 * Applies strict live filter, dedup, and impossible count guard.
 */
function normalizeMatches(rawMatches, source, { liveOnly = true, minValidationScore = 35 } = {}) {
  if (!Array.isArray(rawMatches)) return [];
  const seen = new Set();
  const out = [];
  const rejectReasons = {};
  const addReject = (r) => { rejectReasons[r] = (rejectReasons[r] || 0) + 1; };

  for (const raw of rawMatches) {
    if (!raw) { addReject('empty_raw'); continue; }
    const m = makeCanonical(raw, source);

    if (liveOnly && m.match_live !== '1') { addReject('not_live'); continue; }
    if (!m.match_hometeam_name || !m.match_awayteam_name) { addReject('missing_team'); continue; }
    if (m.validationScore < minValidationScore) {
      addReject((m.validationReasons || ['quality_low']).find(x => /excluded|scheduled|final|invalid|missing_minute|flashscore/.test(x)) || 'quality_low');
      continue;
    }

    // Dedup by match_id inside provider
    if (m.match_id) {
      if (seen.has(m.match_id)) { addReject('duplicate_id'); continue; }
      seen.add(m.match_id);
    }

    out.push(m);
  }

  // Impossible count guard per-source
  const guard = validateProviderBatch(out, source);
  if (!guard.ok) {
    console.warn(`[normalizer] QUARANTINE source=${source} reason=${guard.reason} count=${out.length}`);
    normalizeMatches.lastDebug = { source, raw:rawMatches.length, accepted:0, rejected:rawMatches.length, rejectReasons, quarantine:guard.reason };
    return []; // quarantine — return nothing
  }

  normalizeMatches.lastDebug = { source, raw:rawMatches.length, accepted:out.length, rejected:rawMatches.length-out.length, rejectReasons };
  return out;
}

/**
 * Merge results from multiple adapters.
 * First adapter with a given match_id wins; later adapters fill missing fields.
 * v11.22: adds provider confidence scoring for dedup tie-breaking.
 */
function matchQualityScore(m) {
  const providerPriority = {
    espn_json: 90, espn: 90,
    fotmob_json: 75, fotmob: 75,
    flashscore_feed: 60, flashscore: 60,
    thesportsdb_json: 50, openligadb_json: 45,
    aiscore_json: 35, mock: 0,
  };
  let score = (m.validationScore || 0) + (providerPriority[m._mergeProvider] || providerPriority[m.source] || 40);
  if (m.hasStats) score += 25;
  if (m.hasOdds) score += 10;
  if ((m.signalCount || 0) > 0) score += 8;
  if (m.minute != null) score += 5;
  return score;
}

function canonicalMatchKey(m) {
  const h = canonicalTeamName(m.match_hometeam_name);
  const a = canonicalTeamName(m.match_awayteam_name);
  if (!h || !a) return m.match_id ? 'id:' + m.match_id : '';
  // Team-pair key is intentionally league-agnostic. Provider league labels are
  // inconsistent (e.g. 'Premier League' vs 'English Premier League'), and two
  // same-team live matches at the same time are practically impossible for
  // senior betting-grade matches after youth/reserve filters.
  return [h, a].join('|');
}

/**
 * Merge results from multiple adapters using canonical team/league dedupe.
 * Higher quality/provider match wins; lower quality rows fill missing stats/odds only.
 */
function mergeAdapterResults(adapterResults) {
  const byKey = new Map();
  const duplicateReport = [];
  let rawIn = 0;

  for (const ar of (adapterResults || [])) {
    if (!ar || !ar.success || !Array.isArray(ar.matches)) continue;
    for (const row of ar.matches) {
      if (!row || row.match_live !== '1') continue;
      rawIn++;
      const m = Object.assign({}, row, { _mergeProvider: ar.provider });
      const key = canonicalMatchKey(m) || (m.match_id ? 'id:'+m.match_id : null);
      if (!key) continue;

      if (!byKey.has(key)) {
        byKey.set(key, m);
        continue;
      }

      const existing = byKey.get(key);
      const qNew = matchQualityScore(m);
      const qOld = matchQualityScore(existing);
      const winner = qNew > qOld ? m : existing;
      const loser  = qNew > qOld ? existing : m;

      if (!winner.hasStats && loser.hasStats) { winner.stats = Object.assign({}, loser.stats); winner.hasStats = true; }
      if (!winner.hasOdds && loser.hasOdds) { winner.odds = Object.assign({}, loser.odds); winner.hasOdds = true; }
      if (winner.minute == null && loser.minute != null) winner.minute = loser.minute;
      winner._mergedProviders = Array.from(new Set([...(winner._mergedProviders || [winner._mergeProvider || winner.source]), loser._mergeProvider || loser.source].filter(Boolean)));
      byKey.set(key, winner);
      duplicateReport.push({ key, kept:winner.match_id, dropped:loser.match_id, providers:winner._mergedProviders });
    }
  }

  let merged = [...byKey.values()].filter(m => (m.validationScore || 0) >= 35 && m.match_live === '1');

  // v11.24: Dynamic visible cap. A high raw count from a basic x-feed usually
  // means noisy global rows, not 150 truly useful senior betting matches. Keep
  // ESPN/stats-rich matches first, then the best senior Flashscore discovery rows.
  const statsRichCount = merged.filter(m => m.hasStats || (m.signalCount || 0) > 0 || m.source === 'espn' || m.source === 'espn_json').length;
  const basicFlashCount = merged.filter(m => isFlashscoreBasicRow(m)).length;
  let dynamicMaxVisible = 60;
  if (merged.length > 80 && basicFlashCount / Math.max(merged.length,1) > 0.55) {
    dynamicMaxVisible = Math.max(24, Math.min(45, statsRichCount * 4 + 20));
  }
  if (merged.length > 140) dynamicMaxVisible = Math.min(dynamicMaxVisible, 38);

  let capped = 0;
  if (merged.length > dynamicMaxVisible) {
    merged.sort((a,b) => matchQualityScore(b) - matchQualityScore(a));
    capped = merged.length - dynamicMaxVisible;
    merged = merged.slice(0, dynamicMaxVisible);
  }
  const layerDebug = splitLiveLayers(merged);
  mergeAdapterResults.lastDebug = {
    rawIn,
    dedupeAfter: merged.length,
    visibleLiveMatchesCount: layerDebug.visibleLiveMatches.length,
    signalEligibleMatchesCount: layerDebug.signalEligibleMatches.length,
    cappedBySafetyGuard: capped,
    dynamicMaxVisible: (typeof dynamicMaxVisible !== 'undefined' ? dynamicMaxVisible : null),
    duplicateRemoved: Math.max(0, rawIn - merged.length),
    duplicateSamples: duplicateReport.slice(0,20),
    rejectedReasons: layerDebug.rejectedReasons,
    lowDataVisibleCount: layerDebug.lowDataVisibleCount,
    qualityTiers: merged.reduce((a,m)=>{ const k=m.validationTier||'UNKNOWN'; a[k]=(a[k]||0)+1; return a; },{}),
    providerCounts: merged.reduce((a,m)=>{ const k=m._mergeProvider||m.source||'unknown'; a[k]=(a[k]||0)+1; return a; },{}),
    signalEligibleProviderCounts: layerDebug.signalEligibleProviderCounts,
    pipelineHealth: layerDebug.health,
  };
  return merged;
}

module.exports = {
  normalizeMatches,
  mergeAdapterResults,
  makeCanonical,
  normOdds,
  safeNum,
  safeStr,
  normMinute,
  classifyStatus,
  isLiveMatch,
  validateProviderBatch,
  computeValidation,
  canonicalMatchKey,
  matchQualityScore,
  isSignalEligibleMatch,
  splitLiveLayers,
  validationReasonBucket,
  flashscoreSeniorVisibleAllowed,
  isNoisyFlashCompetition,
};
