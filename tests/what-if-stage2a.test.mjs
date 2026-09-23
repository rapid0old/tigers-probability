import assert from 'node:assert/strict';
import test from 'node:test';

import {LEAGUE_SNAPSHOT_2026} from '../league-data-2026.mjs';
import {LeagueBaselineModel, SeasonSimulator} from '../league-simulator-core.mjs';
import {LocalScenarioRepository} from '../scenario-store.mjs';
import {createBaseContext, createBaseContextFromPrepared} from '../what-if-base-context.mjs';
import {
  WHAT_IF_OUTCOMES,
  createScenario,
  withScenarioOverride,
} from '../what-if-scenario.mjs';
import {
  buildBaseSimulationInput,
  buildScenarioSimulationInput,
  compareScenarioToBase,
  simulateBaseContext,
  simulateScenario,
} from '../what-if-simulator.mjs';

const CREATED_AT = '2026-09-23T00:00:00.000Z';
const UPDATED_AT = '2026-09-23T01:00:00.000Z';

function teams() {
  return [
    ...['T', 'DB', 'G', 'D', 'C', 'S'].map((id, index) => ({id, league: 'CENTRAL', previousRank: index + 1})),
    ...['H', 'F', 'B', 'E', 'L', 'M'].map((id, index) => ({id, league: 'PACIFIC', previousRank: index + 1})),
  ];
}

function emptyState() {
  return {
    wins: Array(12).fill(0),
    losses: Array(12).fill(0),
    ties: Array(12).fill(0),
    leagueWins: Array(12).fill(0),
    leagueLosses: Array(12).fill(0),
    leagueTies: Array(12).fill(0),
    h2hWins: Array(144).fill(0),
    h2hLosses: Array(144).fill(0),
    h2hTies: Array(144).fill(0),
  };
}

function fixture(id, homeTeamId = 'T', awayTeamId = 'G', status = 'SCHEDULED', probabilities = {homeWin: 0.45, awayWin: 0.45, tie: 0.1}) {
  const allTeams = teams();
  return {
    game: {id, date: status === 'PENDING_RESCHEDULE' ? null : '2026-09-24', homeTeamId, awayTeamId, status},
    homeIndex: allTeams.findIndex(team => team.id === homeTeamId),
    awayIndex: allTeams.findIndex(team => team.id === awayTeamId),
    sameLeague: allTeams.find(team => team.id === homeTeamId).league === allTeams.find(team => team.id === awayTeamId).league,
    probabilities,
  };
}

function controlledBase({fixtures = [fixture('game-1')], normalOverrides = {}} = {}) {
  return createBaseContextFromPrepared({
    baseSnapshotDate: '2026-09-17',
    baseDatasetId: 'stage2a-test',
    teams: teams(),
    officialState: emptyState(),
    remainingFixtures: fixtures,
    normalOverrides,
    modelSnapshot: {modelVersion: 'League Baseline Model v1', ratings: Object.fromEntries(teams().map(team => [team.id, 1500]))},
  }, {now: () => CREATED_AT});
}

function scenario(base, id = 'scenario-a', settings = {iterations: 200, random_seed: 'stage2a'}) {
  return createScenario({
    name: id,
    baseContext: base,
    league: 'CENTRAL',
    focusTeamId: 'T',
    simulationSettings: settings,
  }, {idFactory: () => id, now: () => CREATED_AT});
}

function override(base, sourceScenario, gameId, outcome) {
  return withScenarioOverride(sourceScenario, base, {game_id: gameId, outcome}, {now: () => UPDATED_AT});
}

function team(result, id) {
  return result.teams.find(entry => entry.id === id);
}

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

test('1. override 0件Scenarioは通常Simulatorと同一seedで完全一致する', () => {
  const snapshot = structuredClone(LEAGUE_SNAPSHOT_2026);
  const model = new LeagueBaselineModel(snapshot);
  const fixtureId = snapshot.games.find(game => game.status !== 'FINAL').id;
  const normalOverrides = {[fixtureId]: {result: WHAT_IF_OUTCOMES.HOME_WIN}};
  const base = createBaseContext({
    snapshot,
    probabilityModel: model,
    baseDatasetId: 'npb-2026-20260917-v1',
    normalOverrides,
  }, {now: () => CREATED_AT});
  const settings = {iterations: 1200, random_seed: 'same-seed'};
  const normal = new SeasonSimulator({snapshot, probabilityModel: model}).simulate({iterations: settings.iterations, seed: settings.random_seed, overrides: normalOverrides});
  const whatIf = simulateScenario(base, scenario(base, 'empty-scenario', settings));
  assert.deepEqual(whatIf, normal);
});

for (const [number, outcome, expected] of [
  [2, WHAT_IF_OUTCOMES.HOME_WIN, {homeWins: 1, homeLosses: 0, homeTies: 0, awayWins: 0}],
  [3, WHAT_IF_OUTCOMES.AWAY_WIN, {homeWins: 0, homeLosses: 1, homeTies: 0, awayWins: 1}],
  [4, WHAT_IF_OUTCOMES.TIE, {homeWins: 0, homeLosses: 0, homeTies: 1, awayWins: 0}],
]) {
  test(`${number}. ${outcome}は全iterationで確定結果になる`, () => {
    const base = controlledBase();
    const result = simulateScenario(base, override(base, scenario(base), 'game-1', outcome));
    assert.equal(result.remainingGames, 0);
    assert.equal(result.overriddenGames, 1);
    assert.equal(team(result, 'T').expectedWins, expected.homeWins);
    assert.equal(team(result, 'T').expectedLosses, expected.homeLosses);
    assert.equal(team(result, 'T').expectedTies, expected.homeTies);
    assert.equal(team(result, 'G').expectedWins, expected.awayWins);
  });
}

test('5. 明示UNKNOWNは保存済み確率による通常simulationへ戻る', () => {
  const base = controlledBase({fixtures: [fixture('game-1', 'T', 'G', 'SCHEDULED', {homeWin: 1, awayWin: 0, tie: 0})]});
  const original = scenario(base);
  const unknown = override(base, original, 'game-1', WHAT_IF_OUTCOMES.UNKNOWN);
  assert.deepEqual(simulateScenario(base, unknown), simulateScenario(base, original));
});

test('6. 明示UNKNOWNは作成時通常overrideを解除する', () => {
  const base = controlledBase({normalOverrides: {'game-1': {result: WHAT_IF_OUTCOMES.HOME_WIN}}});
  const baseline = simulateBaseContext(base, {iterations: 200, random_seed: 'stage2a'});
  const unknown = simulateScenario(base, override(base, scenario(base), 'game-1', WHAT_IF_OUTCOMES.UNKNOWN));
  assert.equal(baseline.remainingGames, 0);
  assert.equal(baseline.overriddenGames, 1);
  assert.equal(unknown.remainingGames, 1);
  assert.equal(unknown.overriddenGames, 0);
});

test('7. CANCELEDは確定W/L/Tを増やさない', () => {
  const base = controlledBase();
  const input = buildScenarioSimulationInput(base, override(base, scenario(base), 'game-1', WHAT_IF_OUTCOMES.CANCELED));
  assert.equal(input.baseState.wins.reduce((sum, value) => sum + value, 0), 0);
  assert.equal(input.baseState.losses.reduce((sum, value) => sum + value, 0), 0);
  assert.equal(input.baseState.ties.reduce((sum, value) => sum + value, 0), 0);
});

test('8. CANCELEDは未消化fixtureとしてsimulation対象に残る', () => {
  const base = controlledBase();
  const result = simulateScenario(base, override(base, scenario(base), 'game-1', WHAT_IF_OUTCOMES.CANCELED));
  assert.equal(result.remainingGames, 1);
  assert.equal(result.overriddenGames, 0);
  assert.equal(team(result, 'T').expectedWins + team(result, 'T').expectedLosses + team(result, 'T').expectedTies, 1);
  assert.deepEqual(result.overrideReport, [{gameId: 'game-1', status: 'PENDING_RESCHEDULE', override: 'CANCELED'}]);
});

test('9. PENDING_RESCHEDULEはCANCELED後も重複しない', () => {
  const base = controlledBase({fixtures: [fixture('pending-1', 'T', 'G', 'PENDING_RESCHEDULE')]});
  const input = buildScenarioSimulationInput(base, override(base, scenario(base), 'pending-1', WHAT_IF_OUTCOMES.CANCELED));
  assert.equal(input.remaining.filter(entry => entry.game.id === 'pending-1').length, 1);
  assert.equal(input.remaining[0].game.status, 'PENDING_RESCHEDULE');
});

test('10. 複数fixture overrideを同時に適用できる', () => {
  const base = controlledBase({fixtures: [fixture('game-1'), fixture('game-2', 'G', 'T')]});
  let changed = override(base, scenario(base), 'game-1', WHAT_IF_OUTCOMES.HOME_WIN);
  changed = override(base, changed, 'game-2', WHAT_IF_OUTCOMES.HOME_WIN);
  const result = simulateScenario(base, changed);
  assert.equal(result.remainingGames, 0);
  assert.equal(result.overriddenGames, 2);
  assert.equal(team(result, 'T').expectedWins, 1);
  assert.equal(team(result, 'T').expectedLosses, 1);
});

test('11. 阪神以外の試合overrideも正しく効く', () => {
  const base = controlledBase({fixtures: [fixture('game-1', 'DB', 'G')]});
  const result = simulateScenario(base, override(base, scenario(base), 'game-1', WHAT_IF_OUTCOMES.AWAY_WIN));
  assert.equal(team(result, 'G').expectedWins, 1);
  assert.equal(team(result, 'DB').expectedLosses, 1);
  assert.equal(team(result, 'T').expectedWins, 0);
});

test('12. Scenario結果で保存ratingを動的変更しない', () => {
  const base = controlledBase();
  const before = structuredClone(base.model_snapshot.ratings);
  simulateScenario(base, override(base, scenario(base), 'game-1', WHAT_IF_OUTCOMES.HOME_WIN));
  assert.deepEqual(base.model_snapshot.ratings, before);
  assert.equal(buildScenarioSimulationInput(base, scenario(base)).model_version, 'League Baseline Model v1');
});

test('13. live official data変更後も保存Scenario結果は変わらない', () => {
  const liveSnapshot = structuredClone(LEAGUE_SNAPSHOT_2026);
  const base = createBaseContext({
    snapshot: liveSnapshot,
    probabilityModel: new LeagueBaselineModel(liveSnapshot),
    baseDatasetId: 'npb-2026-20260917-v1',
  }, {now: () => CREATED_AT});
  const savedScenario = scenario(base, 'frozen', {iterations: 300, random_seed: 'frozen'});
  const before = simulateScenario(base, savedScenario);
  liveSnapshot.games[0].homeScore = 999;
  liveSnapshot.games.length = 0;
  assert.deepEqual(simulateScenario(base, savedScenario), before);
});

test('14. live normal override変更後も保存Scenario結果は変わらない', () => {
  const liveOverrides = {'game-1': {result: WHAT_IF_OUTCOMES.HOME_WIN}};
  const base = controlledBase({normalOverrides: liveOverrides});
  const savedScenario = scenario(base);
  const before = simulateScenario(base, savedScenario);
  liveOverrides['game-1'].result = WHAT_IF_OUTCOMES.AWAY_WIN;
  assert.deepEqual(simulateScenario(base, savedScenario), before);
});

test('15. simulationは通常データ・Base・Scenarioをmutationしない', () => {
  const base = controlledBase();
  const savedScenario = override(base, scenario(base), 'game-1', WHAT_IF_OUTCOMES.HOME_WIN);
  const baseBefore = JSON.stringify(base);
  const scenarioBefore = JSON.stringify(savedScenario);
  const inputBefore = JSON.stringify(buildBaseSimulationInput(base, savedScenario.simulation_settings));
  simulateScenario(base, savedScenario);
  assert.equal(JSON.stringify(base), baseBefore);
  assert.equal(JSON.stringify(savedScenario), scenarioBefore);
  assert.equal(JSON.stringify(buildBaseSimulationInput(base, savedScenario.simulation_settings)), inputBefore);
});

test('16. save → reload後も同一seedで同一結果になる', () => {
  const storage = new MemoryStorage();
  const repository = new LocalScenarioRepository({storage});
  const base = controlledBase();
  const savedScenario = override(base, scenario(base), 'game-1', WHAT_IF_OUTCOMES.TIE);
  const before = simulateScenario(base, savedScenario);
  repository.save(savedScenario, base);
  const bundle = new LocalScenarioRepository({storage}).getBundle(savedScenario.scenario_id);
  assert.deepEqual(simulateScenario(bundle.base_context, bundle.scenario), before);
});

test('17. Scenario Aの計算はScenario Bへ影響しない', () => {
  const base = controlledBase();
  const first = override(base, scenario(base, 'scenario-a'), 'game-1', WHAT_IF_OUTCOMES.HOME_WIN);
  const second = override(base, scenario(base, 'scenario-b'), 'game-1', WHAT_IF_OUTCOMES.AWAY_WIN);
  const secondBefore = simulateScenario(base, second);
  simulateScenario(base, first);
  assert.deepEqual(simulateScenario(base, second), secondBefore);
});

test('18. 通常Simulator core共有後も比較構造と確率合計が正常', () => {
  const base = controlledBase();
  const savedScenario = override(base, scenario(base), 'game-1', WHAT_IF_OUTCOMES.HOME_WIN);
  const comparison = compareScenarioToBase(base, savedScenario);
  assert.equal(comparison.base_context_id, base.base_context_id);
  assert.equal(comparison.scenario_id, savedScenario.scenario_id);
  assert.equal(comparison.seed, savedScenario.simulation_settings.random_seed);
  assert.ok(comparison.baseline_result);
  assert.ok(comparison.scenario_result);
  assert.equal(comparison.delta.teams.length, 12);
  for (const league of ['CENTRAL', 'PACIFIC']) {
    const leagueTeams = comparison.scenario_result.teams.filter(entry => entry.league === league);
    assert.equal(leagueTeams.reduce((sum, entry) => sum + entry.championProbability, 0), 100);
    assert.equal(leagueTeams.reduce((sum, entry) => sum + entry.csProbability, 0), 300);
  }
});
