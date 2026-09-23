import {SeasonSimulator} from './league-simulator-core.mjs';
import {WHAT_IF_OUTCOMES} from './what-if-scenario.mjs';

export const WHAT_IF_BASE_ARTIFACT_TYPE = 'LEAGUE_WHAT_IF_BASE_CONTEXT';
export const WHAT_IF_BASE_SCHEMA_VERSION = 1;

const VALID_OUTCOMES = new Set(Object.values(WHAT_IF_OUTCOMES));
const STATE_KEYS = Object.freeze([
  'wins',
  'losses',
  'ties',
  'leagueWins',
  'leagueLosses',
  'leagueTies',
  'h2hWins',
  'h2hLosses',
  'h2hTies',
]);

function cloneValue(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function canonicalString(value) {
  return JSON.stringify(canonicalize(value));
}

function fnv1a64(value) {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function normalizeOverrideRecord(record, fallbackGameId = '') {
  const gameId = record?.game_id || fallbackGameId;
  const outcome = typeof record === 'string' ? record : record?.outcome ?? record?.result;
  if (!gameId) throw new Error('game_id is required for a frozen normal override');
  if (!VALID_OUTCOMES.has(outcome)) throw new Error(`Unsupported frozen normal override: ${outcome}`);
  return {game_id: gameId, outcome};
}

function normalizeOverrides(overrides) {
  if (!overrides) return [];
  const normalized = Array.isArray(overrides)
    ? overrides.map(record => normalizeOverrideRecord(record))
    : Object.entries(overrides).map(([gameId, record]) => normalizeOverrideRecord(record, gameId));
  const ids = new Set();
  for (const record of normalized) {
    if (ids.has(record.game_id)) throw new Error(`Duplicate frozen normal override: ${record.game_id}`);
    ids.add(record.game_id);
  }
  return normalized.sort((a, b) => a.game_id.localeCompare(b.game_id));
}

function serializeOfficialState(state, teamCount) {
  const serialized = {};
  for (const key of STATE_KEYS) {
    const expectedLength = key.startsWith('h2h') ? teamCount * teamCount : teamCount;
    const values = Array.from(state?.[key] || []);
    if (values.length !== expectedLength || values.some(value => !Number.isInteger(value) || value < 0)) {
      throw new Error(`Invalid official state: ${key}`);
    }
    serialized[key] = values;
  }
  return serialized;
}

function normalizeFixture(entry) {
  const game = cloneValue(entry.game || entry);
  const probabilities = cloneValue(entry.probabilities);
  if (!game?.id || !['SCHEDULED', 'PENDING_RESCHEDULE'].includes(game.status)) throw new Error(`Invalid remaining fixture: ${game?.id || ''}`);
  if (!probabilities || !['homeWin', 'awayWin', 'tie'].every(key => Number.isFinite(probabilities[key]) && probabilities[key] >= 0)) {
    throw new Error(`Invalid probabilities for remaining fixture: ${game.id}`);
  }
  const total = probabilities.homeWin + probabilities.awayWin + probabilities.tie;
  if (Math.abs(total - 1) > 1e-10) throw new Error(`Probabilities do not sum to one: ${game.id}`);
  return {
    game,
    home_index: entry.home_index ?? entry.homeIndex,
    away_index: entry.away_index ?? entry.awayIndex,
    same_league: entry.same_league ?? entry.sameLeague,
    probabilities,
  };
}

function basePayload(baseContext) {
  return {
    base_snapshot_date: baseContext.base_snapshot_date,
    base_dataset_id: baseContext.base_dataset_id,
    ruleset_id: baseContext.ruleset_id,
    teams: baseContext.teams,
    official_state: baseContext.official_state,
    remaining_fixtures: baseContext.remaining_fixtures,
    normal_overrides: baseContext.normal_overrides,
    model_snapshot: baseContext.model_snapshot,
    ignored_normal_overrides: baseContext.ignored_normal_overrides,
  };
}

function baseIdFor(baseContext) {
  return `base-${fnv1a64(canonicalString(basePayload(baseContext)))}`;
}

export function validateBaseContext(baseContext) {
  if (!baseContext || baseContext.artifact_type !== WHAT_IF_BASE_ARTIFACT_TYPE) throw new Error('Invalid What-if base artifact_type');
  if (baseContext.schema_version !== WHAT_IF_BASE_SCHEMA_VERSION) throw new Error(`Unsupported What-if base schema_version: ${baseContext.schema_version}`);
  if (typeof baseContext.base_context_id !== 'string' || !baseContext.base_context_id) throw new Error('base_context_id is required');
  if (typeof baseContext.created_at !== 'string' || !Number.isFinite(Date.parse(baseContext.created_at))) throw new Error('Base created_at must be an ISO timestamp');
  if (typeof baseContext.base_snapshot_date !== 'string' || !baseContext.base_snapshot_date) throw new Error('base_snapshot_date is required');
  if (typeof baseContext.base_dataset_id !== 'string' || !baseContext.base_dataset_id) throw new Error('base_dataset_id is required');
  if (typeof baseContext.ruleset_id !== 'string' || !baseContext.ruleset_id) throw new Error('ruleset_id is required');
  if (!Array.isArray(baseContext.teams) || !baseContext.teams.length) throw new Error('Base teams are required');
  const teamIds = new Set(baseContext.teams.map(team => team.id));
  if (teamIds.size !== baseContext.teams.length || teamIds.has(undefined)) throw new Error('Base teams must have unique ids');
  serializeOfficialState(baseContext.official_state, baseContext.teams.length);
  if (!Array.isArray(baseContext.remaining_fixtures)) throw new Error('remaining_fixtures must be an array');
  const fixtureIds = new Set();
  for (const entry of baseContext.remaining_fixtures) {
    const fixture = normalizeFixture(entry);
    if (fixtureIds.has(fixture.game.id)) throw new Error(`Duplicate remaining fixture: ${fixture.game.id}`);
    fixtureIds.add(fixture.game.id);
    if (!teamIds.has(fixture.game.homeTeamId) || !teamIds.has(fixture.game.awayTeamId)) throw new Error(`Unknown fixture team: ${fixture.game.id}`);
  }
  normalizeOverrides(baseContext.normal_overrides);
  if (!Array.isArray(baseContext.ignored_normal_overrides)) throw new Error('ignored_normal_overrides must be an array');
  if (baseContext.base_context_id !== baseIdFor(baseContext)) throw new Error('base_context_id does not match frozen content');
  return true;
}

export function createBaseContextFromPrepared({
  baseSnapshotDate,
  baseDatasetId,
  rulesetId = 'npb-2026',
  teams,
  officialState,
  remainingFixtures,
  normalOverrides = {},
  modelSnapshot = {},
  ignoredNormalOverrides = [],
}, {now = () => new Date().toISOString()} = {}) {
  const createdAt = now();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('Base created_at must be an ISO timestamp');
  const draft = {
    artifact_type: WHAT_IF_BASE_ARTIFACT_TYPE,
    schema_version: WHAT_IF_BASE_SCHEMA_VERSION,
    base_context_id: '',
    created_at: createdAt,
    base_snapshot_date: baseSnapshotDate,
    base_dataset_id: baseDatasetId,
    ruleset_id: rulesetId,
    teams: cloneValue(teams),
    official_state: serializeOfficialState(officialState, teams.length),
    remaining_fixtures: remainingFixtures.map(normalizeFixture),
    normal_overrides: normalizeOverrides(normalOverrides),
    model_snapshot: cloneValue(modelSnapshot),
    ignored_normal_overrides: cloneValue(ignoredNormalOverrides),
  };
  draft.base_context_id = baseIdFor(draft);
  validateBaseContext(draft);
  return deepFreeze(draft);
}

export function createBaseContext({
  snapshot,
  probabilityModel,
  baseSnapshotDate = snapshot?.through,
  baseDatasetId,
  rulesetId = 'npb-2026',
  normalOverrides = {},
}, options = {}) {
  const simulator = new SeasonSimulator({snapshot, probabilityModel});
  const prepared = simulator.prepare({});
  const remainingIds = new Set(prepared.remaining.map(entry => entry.game.id));
  const normalizedOverrides = normalizeOverrides(normalOverrides);
  const applicableOverrides = normalizedOverrides.filter(record => remainingIds.has(record.game_id));
  const ignoredNormalOverrides = normalizedOverrides
    .filter(record => !remainingIds.has(record.game_id))
    .map(record => ({...record, reason: 'NOT_A_REMAINING_FIXTURE'}));
  return createBaseContextFromPrepared({
    baseSnapshotDate,
    baseDatasetId,
    rulesetId,
    teams: snapshot.teams,
    officialState: prepared.baseState,
    remainingFixtures: prepared.remaining,
    normalOverrides: applicableOverrides,
    modelSnapshot: typeof probabilityModel.describe === 'function'
      ? probabilityModel.describe()
      : {modelVersion: probabilityModel.modelVersion || 'unknown'},
    ignoredNormalOverrides,
  }, options);
}

export function cloneBaseContext(baseContext) {
  validateBaseContext(baseContext);
  return deepFreeze(cloneValue(baseContext));
}

export function baseContextsEqual(left, right) {
  validateBaseContext(left);
  validateBaseContext(right);
  return canonicalString(basePayload(left)) === canonicalString(basePayload(right));
}

export function baseFixtureIds(baseContext) {
  validateBaseContext(baseContext);
  return new Set(baseContext.remaining_fixtures.map(entry => entry.game.id));
}
