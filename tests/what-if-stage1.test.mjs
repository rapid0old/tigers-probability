import assert from 'node:assert/strict';
import test from 'node:test';

import {LEAGUE_SNAPSHOT_2026} from '../league-data-2026.mjs';
import {LeagueBaselineModel} from '../league-simulator-core.mjs';
import {
  createBaseContext,
  createBaseContextFromPrepared,
  validateBaseContext,
} from '../what-if-base-context.mjs';
import {
  WHAT_IF_ARTIFACT_TYPE,
  WHAT_IF_OUTCOMES,
  createScenario,
  renameScenario,
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

function sampleOfficialState() {
  return {
    wins: [1, 0],
    losses: [0, 1],
    ties: [0, 0],
    leagueWins: [1, 0],
    leagueLosses: [0, 1],
    leagueTies: [0, 0],
    h2hWins: [0, 1, 0, 0],
    h2hLosses: [0, 0, 1, 0],
    h2hTies: [0, 0, 0, 0],
  };
}

function sampleFixtures() {
  return [
    {
      game: {id: 'scheduled-1', date: '2026-09-24', homeTeamId: 'Tigers', awayTeamId: 'Giants', status: 'SCHEDULED'},
      homeIndex: 0,
      awayIndex: 1,
      sameLeague: true,
      probabilities: {homeWin: 0.52, awayWin: 0.42, tie: 0.06},
    },
    {
      game: {id: 'scheduled-2', date: '2026-09-25', homeTeamId: 'Giants', awayTeamId: 'Tigers', status: 'SCHEDULED'},
      homeIndex: 1,
      awayIndex: 0,
      sameLeague: true,
      probabilities: {homeWin: 0.48, awayWin: 0.46, tie: 0.06},
    },
    {
      game: {id: 'pending-1', date: null, homeTeamId: 'Giants', awayTeamId: 'Tigers', status: 'PENDING_RESCHEDULE'},
      homeIndex: 1,
      awayIndex: 0,
      sameLeague: true,
      probabilities: {homeWin: 0.48, awayWin: 0.46, tie: 0.06},
    },
  ];
}

function sampleBaseInput(normalOverrides = {
  'scheduled-1': {result: WHAT_IF_OUTCOMES.HOME_WIN},
  'scheduled-2': {result: WHAT_IF_OUTCOMES.TIE},
}) {
  return {
    baseSnapshotDate: '2026-09-17',
    baseDatasetId: 'npb-2026-20260917-v1',
    rulesetId: 'npb-2026',
    teams: [
      {id: 'Tigers', league: 'CENTRAL', previousRank: 1},
      {id: 'Giants', league: 'CENTRAL', previousRank: 2},
    ],
    officialState: sampleOfficialState(),
    remainingFixtures: sampleFixtures(),
    normalOverrides,
    modelSnapshot: {
      modelVersion: 'League Baseline Model v1',
      fixedRatingsThrough: '2026-09-17',
      ratings: {Tigers: 1510, Giants: 1490},
    },
  };
}

function fixedBase(normalOverrides) {
  return createBaseContextFromPrepared(sampleBaseInput(normalOverrides), {now: () => CREATED_AT});
}

function scenarioInput(baseContext = fixedBase()) {
  return {
    name: '残り試合の仮想結果',
    baseContext,
    league: 'CENTRAL',
    focusTeamId: 'Tigers',
    simulationSettings: {
      model_id: 'league-baseline-v1',
      ruleset_id: 'npb-2026',
      iterations: 50000,
      random_seed: 'what-if-test',
    },
  };
}

function fixedScenario(baseContext = fixedBase(), id = '11111111-1111-4111-8111-111111111111') {
  return createScenario(scenarioInput(baseContext), {
    idFactory: () => id,
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
  const base = fixedBase();
  const scenario = fixedScenario(base);
  assert.equal(scenario.artifact_type, WHAT_IF_ARTIFACT_TYPE);
  assert.equal(scenario.schema_version, 1);
  assert.equal(scenario.name, '残り試合の仮想結果');
  assert.equal(scenario.base_context_id, base.base_context_id);
  assert.equal(Object.hasOwn(scenario, 'base_context'), false);
});

test('2. crypto.randomUUID形式のIDが付与される', () => {
  const scenario = createScenario(scenarioInput(), {now: () => CREATED_AT});
  assert.match(scenario.scenario_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('2a. Scenario名をimmutableに変更できる', () => {
  const original = fixedScenario();
  const renamed = renameScenario(original, '阪神3連勝', {now: () => UPDATED_AT});
  assert.equal(original.name, '残り試合の仮想結果');
  assert.equal(renamed.name, '阪神3連勝');
  assert.equal(renamed.updated_at, UPDATED_AT);
  assert.throws(() => renameScenario(original, '   ', {now: () => UPDATED_AT}), /Scenario name is required/);
});

test('3-5. Repositoryでsave/get/list/deleteできる', () => {
  const repository = new LocalScenarioRepository({storage: new MemoryStorage()});
  const base = fixedBase();
  const scenario = fixedScenario(base);
  repository.save(scenario, base);
  assert.deepEqual(repository.get(scenario.scenario_id), scenario);
  assert.deepEqual(repository.list(), [scenario]);
  assert.equal(repository.delete(scenario.scenario_id), true);
  assert.equal(repository.get(scenario.scenario_id), null);
  assert.equal(repository.getBaseContext(base.base_context_id), null);
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
    const base = fixedBase();
    const updated = withScenarioOverride(fixedScenario(base), base, {game_id: 'scheduled-1', outcome}, {now: () => UPDATED_AT});
    assert.equal(getScenarioOverrideOutcome(updated, 'scheduled-1'), outcome);
    assert.equal(updated.game_overrides.length, 1);
  });
}

test('12. Base Contextは作成時点の集計・fixture・設定をfreezeする', () => {
  const input = sampleBaseInput();
  const base = createBaseContextFromPrepared(input, {now: () => CREATED_AT});
  input.officialState.wins[0] = 99;
  input.remainingFixtures[0].game.date = '2099-01-01';
  input.normalOverrides['scheduled-1'].result = WHAT_IF_OUTCOMES.AWAY_WIN;
  input.modelSnapshot.ratings.Tigers = 9999;
  assert.equal(base.official_state.wins[0], 1);
  assert.equal(base.remaining_fixtures[0].game.date, '2026-09-24');
  assert.equal(base.normal_overrides[0].outcome, WHAT_IF_OUTCOMES.HOME_WIN);
  assert.equal(base.model_snapshot.ratings.Tigers, 1510);
  assert.equal(Object.isFrozen(base.remaining_fixtures[0].game), true);
  assert.equal(validateBaseContext(base), true);
});

test('13. Base作成後の通常override変更は伝播しない', () => {
  const normalOverrides = {'scheduled-1': {result: WHAT_IF_OUTCOMES.HOME_WIN}};
  const base = fixedBase(normalOverrides);
  normalOverrides['scheduled-1'].result = WHAT_IF_OUTCOMES.AWAY_WIN;
  assert.equal(base.normal_overrides[0].outcome, WHAT_IF_OUTCOMES.HOME_WIN);
});

test('14. Scenario編集は元Scenario・共有Base・通常overrideを変更しない', () => {
  const normalOverrides = {'scheduled-1': {result: WHAT_IF_OUTCOMES.HOME_WIN}};
  const base = fixedBase(normalOverrides);
  const original = fixedScenario(base);
  const updated = withScenarioOverride(original, base, {game_id: 'scheduled-1', outcome: WHAT_IF_OUTCOMES.AWAY_WIN}, {now: () => UPDATED_AT});
  assert.equal(original.game_overrides.length, 0);
  assert.equal(base.normal_overrides[0].outcome, WHAT_IF_OUTCOMES.HOME_WIN);
  assert.equal(normalOverrides['scheduled-1'].result, WHAT_IF_OUTCOMES.HOME_WIN);
  assert.equal(updated.game_overrides[0].outcome, WHAT_IF_OUTCOMES.AWAY_WIN);
});

test('15. resolveはBase・通常override・Scenarioをmutationしない', () => {
  const base = fixedBase();
  const scenario = withScenarioOverride(fixedScenario(base), base, {game_id: 'scheduled-2', outcome: WHAT_IF_OUTCOMES.AWAY_WIN}, {now: () => UPDATED_AT});
  const baseBefore = JSON.stringify(base);
  const scenarioBefore = JSON.stringify(scenario);
  const resolved = resolveScenario(scenario, base);
  assert.throws(() => {
    resolved.official_state.wins[0] = 99;
  }, TypeError);
  assert.equal(JSON.stringify(base), baseBefore);
  assert.equal(JSON.stringify(scenario), scenarioBefore);
  assert.notEqual(resolved.official_state, base.official_state);
});

test('16. 同じgame_idの更新はoverrideとfixtureを二重化しない', () => {
  const base = fixedBase();
  let scenario = fixedScenario(base);
  scenario = withScenarioOverride(scenario, base, {game_id: 'scheduled-1', outcome: WHAT_IF_OUTCOMES.HOME_WIN}, {now: () => UPDATED_AT});
  scenario = withScenarioOverride(scenario, base, {game_id: 'scheduled-1', outcome: WHAT_IF_OUTCOMES.AWAY_WIN}, {now: () => UPDATED_AT});
  const resolved = resolveScenario(scenario, base);
  assert.equal(scenario.game_overrides.length, 1);
  assert.equal(resolved.remaining_fixtures.filter(entry => entry.game.id === 'scheduled-1').length, 1);
  assert.equal(resolved.overrides['scheduled-1'].result, WHAT_IF_OUTCOMES.AWAY_WIN);
});

test('17. PENDING_RESCHEDULEとCANCELEDは同じfixtureを未消化のまま維持する', () => {
  const base = fixedBase();
  const scenario = withScenarioOverride(fixedScenario(base), base, {game_id: 'pending-1', outcome: WHAT_IF_OUTCOMES.CANCELED}, {now: () => UPDATED_AT});
  const resolved = resolveScenario(scenario, base);
  const pending = resolved.remaining_fixtures.filter(entry => entry.game.id === 'pending-1');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].game.status, 'PENDING_RESCHEDULE');
  assert.equal(pending[0].game.date, null);
  assert.equal(resolved.overrides['pending-1'].result, WHAT_IF_OUTCOMES.CANCELED);
});

test('18. 既存localStorage keyを変更しない', () => {
  const storage = new MemoryStorage({
    tigersLeagueSimulatorOverridesV1: '{"existing":true}',
    observedLearningV1: '{"entries":[]}',
  });
  const repository = new LocalScenarioRepository({storage});
  const base = fixedBase();
  repository.save(fixedScenario(base), base);
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
  const futureStore = JSON.stringify({schema_version: 99, base_contexts: [], scenarios: [], last_opened_scenario_id: null});
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
  const base = fixedBase({'scheduled-1': {result: WHAT_IF_OUTCOMES.HOME_WIN}});
  const original = fixedScenario(base);
  assert.equal(resolveScenario(original, base).overrides['scheduled-1'].result, WHAT_IF_OUTCOMES.HOME_WIN);

  const explicitUnknown = withScenarioOverride(original, base, {game_id: 'scheduled-1', outcome: WHAT_IF_OUTCOMES.UNKNOWN}, {now: () => UPDATED_AT});
  assert.equal(Object.hasOwn(resolveScenario(explicitUnknown, base).overrides, 'scheduled-1'), false);

  const removed = withoutScenarioOverride(explicitUnknown, 'scheduled-1', {now: () => UPDATED_AT});
  assert.equal(resolveScenario(removed, base).overrides['scheduled-1'].result, WHAT_IF_OUTCOMES.HOME_WIN);
});

test('23. 同じBaseから2 Scenarioを保存してもBaseは重複しない', () => {
  const storage = new MemoryStorage();
  const repository = new LocalScenarioRepository({storage});
  const firstBase = createBaseContextFromPrepared(sampleBaseInput(), {now: () => CREATED_AT});
  const secondBase = createBaseContextFromPrepared(sampleBaseInput(), {now: () => UPDATED_AT});
  assert.equal(firstBase.base_context_id, secondBase.base_context_id);
  repository.save(fixedScenario(firstBase, 'scenario-a'), firstBase);
  repository.save(fixedScenario(secondBase, 'scenario-b'), secondBase);
  const persisted = JSON.parse(storage.getItem(WHAT_IF_STORE_KEY));
  assert.equal(persisted.base_contexts.length, 1);
  assert.equal(persisted.scenarios.length, 2);
});

test('24. 一方のScenario変更は他Scenarioと共有Baseへ影響しない', () => {
  const base = fixedBase();
  const first = fixedScenario(base, 'scenario-a');
  const second = fixedScenario(base, 'scenario-b');
  const changed = withScenarioOverride(first, base, {game_id: 'scheduled-1', outcome: WHAT_IF_OUTCOMES.AWAY_WIN}, {now: () => UPDATED_AT});
  assert.equal(changed.game_overrides.length, 1);
  assert.equal(second.game_overrides.length, 0);
  assert.equal(base.normal_overrides[0].outcome, WHAT_IF_OUTCOMES.HOME_WIN);
});

test('25. 作成後のlive official data変更は保存された計算入力を変えない', () => {
  const input = sampleBaseInput();
  const base = createBaseContextFromPrepared(input, {now: () => CREATED_AT});
  const scenario = fixedScenario(base);
  const before = JSON.stringify(resolveScenario(scenario, base));
  input.officialState.wins[0] = 100;
  input.remainingFixtures.length = 0;
  input.modelSnapshot.ratings.Tigers = 1;
  assert.equal(JSON.stringify(resolveScenario(scenario, base)), before);
});

test('26. 作成後の通常override変更は保存された計算入力を変えない', () => {
  const liveOverrides = {'scheduled-1': {result: WHAT_IF_OUTCOMES.HOME_WIN}};
  const base = fixedBase(liveOverrides);
  const scenario = fixedScenario(base);
  const before = JSON.stringify(resolveScenario(scenario, base));
  liveOverrides['scheduled-1'].result = WHAT_IF_OUTCOMES.AWAY_WIN;
  liveOverrides['scheduled-2'] = {result: WHAT_IF_OUTCOMES.CANCELED};
  assert.equal(JSON.stringify(resolveScenario(scenario, base)), before);
});

test('27. save → reload後も作成時点の世界を再現できる', () => {
  const storage = new MemoryStorage();
  const base = fixedBase();
  const scenario = withScenarioOverride(fixedScenario(base), base, {game_id: 'scheduled-2', outcome: WHAT_IF_OUTCOMES.AWAY_WIN}, {now: () => UPDATED_AT});
  const expected = resolveScenario(scenario, base);
  new LocalScenarioRepository({storage}).save(scenario, base);
  const bundle = new LocalScenarioRepository({storage}).getBundle(scenario.scenario_id);
  assert.deepEqual(resolveScenario(bundle.scenario, bundle.base_context), expected);
});

test('28. 共有Baseは参照中Scenarioがある限り削除されない', () => {
  const repository = new LocalScenarioRepository({storage: new MemoryStorage()});
  const base = fixedBase();
  repository.save(fixedScenario(base, 'scenario-a'), base);
  repository.save(fixedScenario(base, 'scenario-b'), base);
  assert.equal(repository.delete('scenario-a'), true);
  assert.notEqual(repository.getBaseContext(base.base_context_id), null);
  assert.equal(repository.delete('scenario-b'), true);
  assert.equal(repository.getBaseContext(base.base_context_id), null);
});

test('29. 公式確定済み試合はScenario override対象にならない', () => {
  const base = fixedBase();
  assert.throws(
    () => withScenarioOverride(fixedScenario(base), base, {game_id: 'final-1', outcome: WHAT_IF_OUTCOMES.AWAY_WIN}, {now: () => UPDATED_AT}),
    /Unknown fixture/,
  );
});

test('30. 実snapshotは784試合を集計し74fixtureだけをBaseへ保存する', () => {
  const liveSnapshot = structuredClone(LEAGUE_SNAPSHOT_2026);
  const base = createBaseContext({
    snapshot: liveSnapshot,
    probabilityModel: new LeagueBaselineModel(liveSnapshot),
    baseDatasetId: 'npb-2026-20260917-v1',
  }, {now: () => CREATED_AT});
  const finals = LEAGUE_SNAPSHOT_2026.games.filter(game => game.status === 'FINAL');
  const pending = base.remaining_fixtures.filter(entry => entry.game.status === 'PENDING_RESCHEDULE');
  assert.equal(finals.length, 784);
  assert.equal(LEAGUE_SNAPSHOT_2026.games.length, 858);
  assert.equal(base.remaining_fixtures.length, 74);
  assert.equal(pending.length, 2);
  assert.equal(base.teams.length, 12);
  const recordedGames = base.official_state.wins.reduce((sum, value) => sum + value, 0)
    + base.official_state.ties.reduce((sum, value) => sum + value, 0) / 2;
  assert.equal(recordedGames, 784);
  liveSnapshot.games[0].homeScore = 999;
  liveSnapshot.games.length = 0;
  assert.equal(base.remaining_fixtures.length, 74);
  assert.equal(validateBaseContext(base), true);
});
