import {
  prepareSeasonSimulation,
  simulatePreparedSeason,
} from './league-simulator-core.mjs?v=production-v4.0.0-1';
import {validateBaseContext} from './what-if-base-context.mjs';
import {
  resolveScenario,
  validateScenario,
} from './what-if-scenario.mjs';

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

function serializePrepared(prepared) {
  return {
    baseState: Object.fromEntries(Object.entries(prepared.baseState).map(([key, value]) => [key, Array.from(value)])),
    remaining: prepared.remaining.map(entry => ({
      game: cloneValue(entry.game),
      homeIndex: entry.homeIndex,
      awayIndex: entry.awayIndex,
      sameLeague: entry.sameLeague,
      probabilities: cloneValue(entry.probabilities),
    })),
    overrideReport: prepared.overrideReport.map(record => ({...record})),
  };
}

function normalizeSimulationSettings(settings = {}) {
  const iterations = Number(settings.iterations ?? 50000);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 200000) {
    throw new Error('iterations must be an integer from 1 to 200000');
  }
  return {
    iterations,
    seed: String(settings.random_seed ?? settings.seed ?? 'league-baseline-v1'),
  };
}

function overridesAsObject(records) {
  return Object.fromEntries(records.map(record => [record.game_id, {result: record.outcome}]));
}

function buildPreparedInput(baseContext, overrides, simulationSettings, scenarioId = null, scenarioResolutionReport = []) {
  const settings = normalizeSimulationSettings(simulationSettings);
  const prepared = prepareSeasonSimulation({
    teams: baseContext.teams,
    baseState: baseContext.official_state,
    remaining: baseContext.remaining_fixtures,
    overrides,
  });
  return deepFreeze({
    base_context_id: baseContext.base_context_id,
    scenario_id: scenarioId,
    base_snapshot_date: baseContext.base_snapshot_date,
    base_dataset_id: baseContext.base_dataset_id,
    ruleset_id: baseContext.ruleset_id,
    model_version: baseContext.model_snapshot.modelVersion || 'GameProbabilityModel',
    teams: cloneValue(baseContext.teams),
    ...serializePrepared(prepared),
    scenario_resolution_report: cloneValue(scenarioResolutionReport),
    iterations: settings.iterations,
    seed: settings.seed,
  });
}

export function buildBaseSimulationInput(baseContext, simulationSettings = {}) {
  validateBaseContext(baseContext);
  return buildPreparedInput(
    baseContext,
    overridesAsObject(baseContext.normal_overrides),
    simulationSettings,
  );
}

export function buildScenarioSimulationInput(baseContext, scenario) {
  validateBaseContext(baseContext);
  validateScenario(scenario);
  if (scenario.base_context_id !== baseContext.base_context_id) throw new Error('Scenario and base context do not match');
  const resolved = resolveScenario(scenario, baseContext);
  return buildPreparedInput(
    baseContext,
    resolved.overrides,
    scenario.simulation_settings,
    scenario.scenario_id,
    resolved.resolution_report,
  );
}

export function runWhatIfSimulationInput(input) {
  return simulatePreparedSeason({
    teams: input.teams,
    baseState: input.baseState,
    remaining: input.remaining,
    overrideReport: input.overrideReport,
    iterations: input.iterations,
    seed: input.seed,
    modelVersion: input.model_version,
    snapshotThrough: input.base_snapshot_date,
  });
}

export function simulateBaseContext(baseContext, simulationSettings = {}) {
  return runWhatIfSimulationInput(buildBaseSimulationInput(baseContext, simulationSettings));
}

export function simulateScenario(baseContext, scenario) {
  return runWhatIfSimulationInput(buildScenarioSimulationInput(baseContext, scenario));
}

function subtract(left, right) {
  return left - right;
}

export function buildSimulationDelta(baselineResult, scenarioResult) {
  const baselineByTeam = new Map(baselineResult.teams.map(team => [team.id, team]));
  const teams = scenarioResult.teams.map(scenarioTeam => {
    const baselineTeam = baselineByTeam.get(scenarioTeam.id);
    if (!baselineTeam) throw new Error(`Missing baseline team: ${scenarioTeam.id}`);
    return {
      team_id: scenarioTeam.id,
      champion_probability: subtract(scenarioTeam.championProbability, baselineTeam.championProbability),
      cs_probability: subtract(scenarioTeam.csProbability, baselineTeam.csProbability),
      rank_probabilities: scenarioTeam.rankProbabilities.map((value, index) => subtract(value, baselineTeam.rankProbabilities[index])),
      expected_wins: subtract(scenarioTeam.expectedWins, baselineTeam.expectedWins),
      expected_losses: subtract(scenarioTeam.expectedLosses, baselineTeam.expectedLosses),
      expected_ties: subtract(scenarioTeam.expectedTies, baselineTeam.expectedTies),
      expected_rank: subtract(scenarioTeam.expectedRank, baselineTeam.expectedRank),
    };
  });
  return deepFreeze({
    remaining_games: scenarioResult.remainingGames - baselineResult.remainingGames,
    teams,
  });
}

export function compareScenarioToBase(baseContext, scenario, {baselineResult = null} = {}) {
  validateScenario(scenario);
  const baseline = baselineResult || simulateBaseContext(baseContext, scenario.simulation_settings);
  const scenarioResult = simulateScenario(baseContext, scenario);
  if (baseline.iterations !== scenarioResult.iterations || baseline.seed !== scenarioResult.seed) {
    throw new Error('Baseline and Scenario must use the same iterations and seed');
  }
  return deepFreeze({
    base_context_id: baseContext.base_context_id,
    scenario_id: scenario.scenario_id,
    iterations: scenarioResult.iterations,
    seed: scenarioResult.seed,
    baseline_result: cloneValue(baseline),
    scenario_result: cloneValue(scenarioResult),
    delta: buildSimulationDelta(baseline, scenarioResult),
  });
}
