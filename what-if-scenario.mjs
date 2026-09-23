export const WHAT_IF_ARTIFACT_TYPE = 'LEAGUE_WHAT_IF_SCENARIO';
export const WHAT_IF_SCHEMA_VERSION = 1;

export const WHAT_IF_OUTCOMES = Object.freeze({
  HOME_WIN: 'HOME_WIN',
  AWAY_WIN: 'AWAY_WIN',
  TIE: 'TIE',
  CANCELED: 'CANCELED',
  UNKNOWN: 'UNKNOWN',
});

const VALID_OUTCOMES = new Set(Object.values(WHAT_IF_OUTCOMES));
const CALIBRATION_ARTIFACT_TYPES = new Set([
  'OBSERVED_GAME_EVENT',
  'OFFICIAL_GAME_EVENT',
  'CANONICAL_GAME_EVENT',
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

function immutableClone(value) {
  return deepFreeze(cloneValue(value));
}

function createUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues) throw new Error('A cryptographic UUID source is required');
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

function assertTimestamp(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp`);
}

function assertOutcome(outcome) {
  if (!VALID_OUTCOMES.has(outcome)) throw new Error(`Unsupported What-if outcome: ${outcome}`);
}

function assertSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.teams) || !Array.isArray(snapshot.games)) throw new Error('base_context.snapshot must contain teams and games');
  const ids = new Set();
  for (const game of snapshot.games) {
    if (!game?.id || ids.has(game.id)) throw new Error(`Duplicate or missing fixture id: ${game?.id || ''}`);
    ids.add(game.id);
  }
}

function normalizeOverrideRecord(record, fallbackGameId = '') {
  const gameId = record?.game_id || fallbackGameId;
  const outcome = typeof record === 'string' ? record : record?.outcome ?? record?.result;
  if (!gameId) throw new Error('game_id is required for a What-if override');
  assertOutcome(outcome);
  const normalized = {game_id: gameId, outcome};
  for (const field of ['home_team_id', 'away_team_id', 'scheduled_date', 'updated_at']) {
    if (record && Object.hasOwn(record, field)) normalized[field] = record[field];
  }
  return normalized;
}

function normalizeOverrideCollection(overrides) {
  if (!overrides) return [];
  if (Array.isArray(overrides)) return overrides.map(record => normalizeOverrideRecord(record));
  if (typeof overrides !== 'object') throw new Error('Overrides must be an array or object');
  return Object.entries(overrides).map(([gameId, record]) => normalizeOverrideRecord(record, gameId));
}

function assertUniqueOverrides(overrides) {
  const ids = new Set();
  for (const record of overrides) {
    if (ids.has(record.game_id)) throw new Error(`Duplicate What-if override: ${record.game_id}`);
    ids.add(record.game_id);
  }
}

export function validateScenario(scenario) {
  if (!scenario || scenario.artifact_type !== WHAT_IF_ARTIFACT_TYPE) throw new Error('Invalid What-if artifact_type');
  if (scenario.schema_version !== WHAT_IF_SCHEMA_VERSION) throw new Error(`Unsupported What-if schema_version: ${scenario.schema_version}`);
  if (typeof scenario.scenario_id !== 'string' || !scenario.scenario_id) throw new Error('scenario_id is required');
  if (typeof scenario.name !== 'string' || !scenario.name.trim()) throw new Error('Scenario name is required');
  assertTimestamp(scenario.created_at, 'created_at');
  assertTimestamp(scenario.updated_at, 'updated_at');
  if (typeof scenario.base_snapshot_date !== 'string' || !scenario.base_snapshot_date) throw new Error('base_snapshot_date is required');
  if (typeof scenario.base_dataset_id !== 'string' || !scenario.base_dataset_id) throw new Error('base_dataset_id is required');
  if (typeof scenario.league !== 'string' || !scenario.league) throw new Error('league is required');
  if (typeof scenario.focus_team_id !== 'string' || !scenario.focus_team_id) throw new Error('focus_team_id is required');
  if (!scenario.base_context || typeof scenario.base_context !== 'object') throw new Error('base_context is required');
  assertSnapshot(scenario.base_context.snapshot);
  const baseOverrides = normalizeOverrideCollection(scenario.base_context.normal_overrides);
  const scenarioOverrides = normalizeOverrideCollection(scenario.game_overrides);
  assertUniqueOverrides(baseOverrides);
  assertUniqueOverrides(scenarioOverrides);
  if (!scenario.simulation_settings || typeof scenario.simulation_settings !== 'object') throw new Error('simulation_settings is required');
  return true;
}

export function createScenario({
  name,
  snapshot,
  baseSnapshotDate,
  baseDatasetId,
  league,
  focusTeamId,
  normalOverrides = {},
  simulationSettings,
}, {idFactory = createUuid, now = () => new Date().toISOString()} = {}) {
  assertSnapshot(snapshot);
  const timestamp = now();
  assertTimestamp(timestamp, 'created_at');
  const baseNormalOverrides = normalizeOverrideCollection(normalOverrides);
  assertUniqueOverrides(baseNormalOverrides);
  const scenario = {
    artifact_type: WHAT_IF_ARTIFACT_TYPE,
    schema_version: WHAT_IF_SCHEMA_VERSION,
    scenario_id: idFactory(),
    name: String(name || '').trim(),
    created_at: timestamp,
    updated_at: timestamp,
    base_snapshot_date: baseSnapshotDate,
    base_dataset_id: baseDatasetId,
    league,
    focus_team_id: focusTeamId,
    base_context: {
      snapshot: cloneValue(snapshot),
      normal_overrides: cloneValue(baseNormalOverrides),
    },
    game_overrides: [],
    simulation_settings: cloneValue(simulationSettings),
  };
  validateScenario(scenario);
  return deepFreeze(scenario);
}

export function getScenarioOverrideOutcome(scenario, gameId) {
  validateScenario(scenario);
  return scenario.game_overrides.find(record => record.game_id === gameId)?.outcome ?? WHAT_IF_OUTCOMES.UNKNOWN;
}

export function withScenarioOverride(scenario, override, {now = () => new Date().toISOString()} = {}) {
  validateScenario(scenario);
  const timestamp = now();
  assertTimestamp(timestamp, 'updated_at');
  const normalized = normalizeOverrideRecord({...override, updated_at: override.updated_at ?? timestamp});
  const knownIds = new Set(scenario.base_context.snapshot.games.map(game => game.id));
  if (!knownIds.has(normalized.game_id)) throw new Error(`Unknown fixture in Scenario: ${normalized.game_id}`);
  const gameOverrides = scenario.game_overrides.filter(record => record.game_id !== normalized.game_id);
  gameOverrides.push(normalized);
  const updated = cloneValue(scenario);
  updated.updated_at = timestamp;
  updated.game_overrides = gameOverrides;
  validateScenario(updated);
  return deepFreeze(updated);
}

export function withoutScenarioOverride(scenario, gameId, {now = () => new Date().toISOString()} = {}) {
  validateScenario(scenario);
  const timestamp = now();
  assertTimestamp(timestamp, 'updated_at');
  const updated = cloneValue(scenario);
  updated.updated_at = timestamp;
  updated.game_overrides = updated.game_overrides.filter(record => record.game_id !== gameId);
  validateScenario(updated);
  return deepFreeze(updated);
}

export function resolveScenarioInput(frozenBaseContext, scenarioOverrides, simulationSettings = {}) {
  if (!frozenBaseContext || typeof frozenBaseContext !== 'object') throw new Error('frozenBaseContext is required');
  assertSnapshot(frozenBaseContext.snapshot);
  const baseOverrides = normalizeOverrideCollection(frozenBaseContext.normal_overrides);
  const overlays = normalizeOverrideCollection(scenarioOverrides);
  assertUniqueOverrides(baseOverrides);
  assertUniqueOverrides(overlays);

  const snapshot = cloneValue(frozenBaseContext.snapshot);
  const gameById = new Map(snapshot.games.map(game => [game.id, game]));
  const resolved = new Map(baseOverrides.map(record => [record.game_id, record.outcome]));
  const resolutionReport = [];

  for (const record of overlays) {
    const game = gameById.get(record.game_id);
    if (!game) {
      resolutionReport.push({game_id: record.game_id, status: 'UNKNOWN_GAME', outcome: record.outcome});
      continue;
    }
    if (game.status === 'FINAL') {
      resolved.delete(record.game_id);
      resolutionReport.push({game_id: record.game_id, status: 'OFFICIAL_RESULT_PRECEDENCE', outcome: record.outcome});
      continue;
    }
    if (record.outcome === WHAT_IF_OUTCOMES.UNKNOWN) {
      resolved.delete(record.game_id);
      resolutionReport.push({game_id: record.game_id, status: 'BASE_OVERRIDE_CLEARED', outcome: record.outcome});
    } else {
      resolved.set(record.game_id, record.outcome);
      resolutionReport.push({game_id: record.game_id, status: record.outcome === WHAT_IF_OUTCOMES.CANCELED ? 'PENDING_RESCHEDULE' : 'APPLIED', outcome: record.outcome});
    }
  }

  for (const game of snapshot.games) {
    if (game.status === 'FINAL') resolved.delete(game.id);
  }

  const overrides = Object.fromEntries([...resolved].map(([gameId, outcome]) => [gameId, {result: outcome}]));
  return immutableClone({
    snapshot,
    overrides,
    simulation_settings: cloneValue(simulationSettings),
    resolution_report: resolutionReport,
  });
}

export function resolveScenario(scenario) {
  validateScenario(scenario);
  return resolveScenarioInput(scenario.base_context, scenario.game_overrides, scenario.simulation_settings);
}

export function isCalibrationEligibleArtifact(record) {
  return CALIBRATION_ARTIFACT_TYPES.has(record?.artifact_type);
}

export function isWhatIfScenario(record) {
  return record?.artifact_type === WHAT_IF_ARTIFACT_TYPE;
}

export function cloneScenario(scenario) {
  validateScenario(scenario);
  return immutableClone(scenario);
}
