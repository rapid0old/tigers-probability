import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WHAT_IF_ARTIFACT_TYPE,
  WHAT_IF_OUTCOMES,
  createScenario,
  getScenarioOverrideOutcome,
  isCalibrationEligibleArtifact,
  isWhatIfScenario,
  resolveScenario,
  withScenarioOverride,
  withoutScenarioOverride,
} from '../what-if-scenario.mjs';
import {
  LocalScenarioRepository,
  WHAT_IF_STORE_KEY,
} from '../scenario-store.mjs';

const CREATED_AT = '2026-09-23T00:00:00.000Z';
const UPDATED_AT = '2026-09-23T01:00:00.000Z';

function sampleSnapshot() {
  return {
    season: 2026,
    through: '2026-09-17',
    teams: [
      {id: 'Tigers', league: 'CENTRAL', previousRank: 1},
      {id: 'Giants', league: 'CENTRAL', previousRank: 2},
    ],
    games: [
      {id: 'final-1', date: '2026-09-17', homeTeamId: 'Tigers', awayTeamId: 'Giants', status: 'FINAL', homeScore: 4, awayScore: 2},
      {id: 'scheduled-1', date: '2026-09-24', homeTeamId: 'Tigers', awayTeamId: 'Giants', status: 'SCHEDULED'},
      {id: 'scheduled-2', date: '2026-09-25', homeTeamId: 'Giants', awayTeamId: 'Tigers', status: 'SCHEDULED'},
      {id: 'pending-1', date: null, homeTeamId: 'Giants', awayTeamId: 'Tigers', status: 'PENDING_RESCHEDULE'},
    ],
  };
}

function scenarioInput(overrides = {
  'scheduled-1': {result: WHAT_IF_OUTCOMES.HOME_WIN},
  'scheduled-2': {result: WHAT_IF_OUTCOMES.TIE},
}) {
  return {
    name: '残り試合の仮想結果',
    snapshot: sampleSnapshot(),
    baseSnapshotDate: '2026-09-17',
    baseDatasetId: 'npb-2026-20260917-v1',
    league: 'CENTRAL',
    focusTeamId: 'Tigers',
    normalOverrides: overrides,
    simulationSettings: {
      model_id: 'league-baseline-v1',
      ruleset_id: 'npb-2026',
      iterations: 50000,
      random_seed: 'what-if-test',
    },
  };
}

function fixedScenario(overrides) {
  return createScenario(scenarioInput(overrides), {
    idFactory: () => '11111111-1111-4111-8111-111111111111',
    now: () => CREATED_AT,
  });
}

class MemoryStorage {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
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

test('1. Scenarioを新規作成できる', () => {
  const scenario = fixedScenario();
  assert.equal(scenario.artifact_type, WHAT_IF_ARTIFACT_TYPE);
  assert.equal(scenario.schema_version, 1);
  assert.equal(scenario.name, '残り試合の仮想結果');
});

test('2. crypto.randomUUID形式のIDが付与される', () => {
  const scenario = createScenario(scenarioInput(), {now: () => CREATED_AT});
  assert.match(scenario.scenario_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('3-5. Repositoryでsave/get/list/deleteできる', () => {
  const repository = new LocalScenarioRepository({storage: new MemoryStorage()});
  const scenario = fixedScenario();
  repository.save(scenario);
  assert.deepEqual(repository.get(scenario.scenario_id), scenario);
  assert.deepEqual(repository.list(), [scenario]);
  assert.equal(repository.delete(scenario.scenario_id), true);
  assert.equal(repository.get(scenario.scenario_id), null);
  assert.deepEqual(repository.list(), []);
});

test('6. override未登録はUNKNOWNとして返る', () => {
  assert.equal(getScenarioOverrideOutcome(fixedScenario(), 'scheduled-1'), WHAT_IF_OUTCOMES.UNKNOWN);
});

for (const [number, outcome] of [
  [7, WHAT_IF_OUTCOMES.HOME_WIN],
  [8, WHAT_IF_OUTCOMES.AWAY_WIN],
  [9, WHAT_IF_OUTCOMES.TIE],
  [10, WHAT_IF_OUTCOMES.CANCELED],
  [11, WHAT_IF_OUTCOMES.UNKNOWN],
]) {
  test(`${number}. ${outcome}をScenario overrideとして保持できる`, () => {
    const updated = withScenarioOverride(fixedScenario(), {game_id: 'scheduled-1', outcome}, {now: () => UPDATED_AT});
    assert.equal(getScenarioOverrideOutcome(updated, 'scheduled-1'), outcome);
    assert.equal(updated.game_overrides.length, 1);
  });
}

test('12. base_contextは作成時点のsnapshotと設定をfreezeする', () => {
  const snapshot = sampleSnapshot();
  const normalOverrides = {'scheduled-1': {result: WHAT_IF_OUTCOMES.HOME_WIN}};
  const input = scenarioInput(normalOverrides);
  input.snapshot = snapshot;
  const scenario = createScenario(input, {idFactory: () => 'scenario-freeze', now: () => CREATED_AT});
  snapshot.games[1].date = '2099-01-01';
  normalOverrides['scheduled-1'].result = WHAT_IF_OUTCOMES.AWAY_WIN;
  input.simulationSettings.iterations = 1;
  assert.equal(scenario.base_context.snapshot.games[1].date, '2026-09-24');
  assert.equal(scenario.base_context.normal_overrides[0].outcome, WHAT_IF_OUTCOMES.HOME_WIN);
  assert.equal(scenario.simulation_settings.iterations, 50000);
  assert.equal(Object.isFrozen(scenario.base_context.snapshot.games[1]), true);
});

test('13. Scenario作成後の通常override変更はbase_contextへ伝播しない', () => {
  const normalOverrides = {'scheduled-1': {result: WHAT_IF_OUTCOMES.HOME_WIN}};
  const scenario = fixedScenario(normalOverrides);
  normalOverrides['scheduled-1'].result = WHAT_IF_OUTCOMES.AWAY_WIN;
  assert.equal(scenario.base_context.normal_overrides[0].outcome, WHAT_IF_OUTCOMES.HOME_WIN);
});

test('14. Scenario編集は元Scenarioと通常overrideを変更しない', () => {
  const normalOverrides = {'scheduled-1': {result: WHAT_IF_OUTCOMES.HOME_WIN}};
  const original = fixedScenario(normalOverrides);
  const updated = withScenarioOverride(original, {game_id: 'scheduled-1', outcome: WHAT_IF_OUTCOMES.AWAY_WIN}, {now: () => UPDATED_AT});
  assert.equal(original.game_overrides.length, 0);
  assert.equal(normalOverrides['scheduled-1'].result, WHAT_IF_OUTCOMES.HOME_WIN);
  assert.equal(updated.game_overrides[0].outcome, WHAT_IF_OUTCOMES.AWAY_WIN);
});

test('15. overlayはsnapshot・通常override・Scenarioをmutationしない', () => {
  const scenario = withScenarioOverride(fixedScenario(), {game_id: 'scheduled-2', outcome: WHAT_IF_OUTCOMES.AWAY_WIN}, {now: () => UPDATED_AT});
  const before = JSON.stringify(scenario);
  const resolved = resolveScenario(scenario);
  assert.throws(() => {
    resolved.snapshot.games[0].homeScore = 99;
  }, TypeError);
  assert.equal(JSON.stringify(scenario), before);
  assert.notEqual(resolved.snapshot, scenario.base_context.snapshot);
});

test('16. 同じgame_idの更新はoverrideとfixtureを二重化しない', () => {
  let scenario = fixedScenario();
  scenario = withScenarioOverride(scenario, {game_id: 'scheduled-1', outcome: WHAT_IF_OUTCOMES.HOME_WIN}, {now: () => UPDATED_AT});
  scenario = withScenarioOverride(scenario, {game_id: 'scheduled-1', outcome: WHAT_IF_OUTCOMES.AWAY_WIN}, {now: () => UPDATED_AT});
  const resolved = resolveScenario(scenario);
  assert.equal(scenario.game_overrides.length, 1);
  assert.equal(resolved.snapshot.games.filter(game => game.id === 'scheduled-1').length, 1);
  assert.equal(resolved.overrides['scheduled-1'].result, WHAT_IF_OUTCOMES.AWAY_WIN);
});

test('17. PENDING_RESCHEDULEとCANCELEDは同じfixtureを未消化のまま維持する', () => {
  const scenario = withScenarioOverride(fixedScenario(), {game_id: 'pending-1', outcome: WHAT_IF_OUTCOMES.CANCELED}, {now: () => UPDATED_AT});
  const resolved = resolveScenario(scenario);
  const pending = resolved.snapshot.games.filter(game => game.id === 'pending-1');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'PENDING_RESCHEDULE');
  assert.equal(pending[0].date, null);
  assert.equal(resolved.overrides['pending-1'].result, WHAT_IF_OUTCOMES.CANCELED);
});

test('18. 既存localStorage keyを変更しない', () => {
  const storage = new MemoryStorage({
    tigersLeagueSimulatorOverridesV1: '{"existing":true}',
    observedLearningV1: '{"entries":[]}',
  });
  const repository = new LocalScenarioRepository({storage});
  repository.save(fixedScenario());
  assert.equal(storage.getItem('tigersLeagueSimulatorOverridesV1'), '{"existing":true}');
  assert.equal(storage.getItem('observedLearningV1'), '{"entries":[]}');
  assert.notEqual(storage.getItem(WHAT_IF_STORE_KEY), null);
});

test('19. 壊れたstoreを安全に検出して空一覧を返す', () => {
  const repository = new LocalScenarioRepository({storage: new MemoryStorage({[WHAT_IF_STORE_KEY]: '{broken'})});
  assert.deepEqual(repository.list(), []);
  assert.deepEqual(repository.getStatus(), {ok: false, code: 'CORRUPT_STORE', message: 'Could not read the What-if store'});
  assert.throws(() => repository.save(fixedScenario()), error => error.code === 'CORRUPT_STORE');
});

test('20. schema_version不一致を安全に検出する', () => {
  const futureStore = JSON.stringify({schema_version: 99, scenarios: [], last_opened_scenario_id: null});
  const repository = new LocalScenarioRepository({storage: new MemoryStorage({[WHAT_IF_STORE_KEY]: futureStore})});
  assert.deepEqual(repository.list(), []);
  assert.equal(repository.getStatus().code, 'UNSUPPORTED_SCHEMA');
  assert.throws(() => repository.delete('anything'), error => error.code === 'UNSUPPORTED_SCHEMA');
});

test('21. What-if artifactはCalibration対象にならない', () => {
  const scenario = fixedScenario();
  assert.equal(isWhatIfScenario(scenario), true);
  assert.equal(isCalibrationEligibleArtifact(scenario), false);
  assert.equal(isCalibrationEligibleArtifact({artifact_type: 'OBSERVED_GAME_EVENT'}), true);
});

test('22. 明示UNKNOWNと未登録を保存上取り違えない', () => {
  const original = fixedScenario({'scheduled-1': {result: WHAT_IF_OUTCOMES.HOME_WIN}});
  const inherited = resolveScenario(original);
  assert.equal(original.game_overrides.length, 0);
  assert.equal(inherited.overrides['scheduled-1'].result, WHAT_IF_OUTCOMES.HOME_WIN);

  const explicitUnknown = withScenarioOverride(original, {game_id: 'scheduled-1', outcome: WHAT_IF_OUTCOMES.UNKNOWN}, {now: () => UPDATED_AT});
  const cleared = resolveScenario(explicitUnknown);
  assert.equal(explicitUnknown.game_overrides.length, 1);
  assert.equal(Object.hasOwn(cleared.overrides, 'scheduled-1'), false);

  const removed = withoutScenarioOverride(explicitUnknown, 'scheduled-1', {now: () => UPDATED_AT});
  assert.equal(resolveScenario(removed).overrides['scheduled-1'].result, WHAT_IF_OUTCOMES.HOME_WIN);
});

test('公式結果はScenario overrideより優先される', () => {
  const scenario = withScenarioOverride(fixedScenario(), {game_id: 'final-1', outcome: WHAT_IF_OUTCOMES.AWAY_WIN}, {now: () => UPDATED_AT});
  const resolved = resolveScenario(scenario);
  assert.equal(Object.hasOwn(resolved.overrides, 'final-1'), false);
  assert.deepEqual(resolved.resolution_report.find(item => item.game_id === 'final-1'), {
    game_id: 'final-1',
    status: 'OFFICIAL_RESULT_PRECEDENCE',
    outcome: WHAT_IF_OUTCOMES.AWAY_WIN,
  });
});
