import {LEAGUE_SNAPSHOT_2026} from './league-data-2026.mjs';
import {CANCELED_OVERRIDE, GAME_RESULTS, LEAGUES, LeagueBaselineModel, SeasonSimulator} from './league-simulator-core.mjs?v=production-v4.0.0-1';
import {createBaseContext} from './what-if-base-context.mjs';
import {
  WHAT_IF_OUTCOMES,
  createScenario,
  renameScenario,
  withScenarioOverride,
  withoutScenarioOverride,
} from './what-if-scenario.mjs';
import {LocalScenarioRepository} from './scenario-store.mjs';
import {compareScenarioToBase, simulateBaseContext} from './what-if-simulator.mjs';

const STORAGE_KEY = 'tigersLeagueSimulatorOverridesV1';
const TEAM_TIGERS = 'T';
const teamById = new Map(LEAGUE_SNAPSHOT_2026.teams.map(team => [team.id, team]));
const model = new LeagueBaselineModel(LEAGUE_SNAPSHOT_2026);
const simulator = new SeasonSimulator({snapshot: LEAGUE_SNAPSHOT_2026, probabilityModel: model});
const scenarioRepository = new LocalScenarioRepository();
let activeLeague = LEAGUES.CENTRAL;
let latestResult = null;
let latestResultInputFingerprint = '';
let runTimer = 0;
let activeScenario = null;
let activeBaseContext = null;
let whatIfComparison = null;
let whatIfDirty = false;
let whatIfFilter = 'tigers';
let whatIfCalculating = false;
let whatIfCalculationState = 'idle';
const baselineCache = new Map();
const fixtureExpansion = new Map();
const whatIfFixtureExpansion = new Map();

const byId = id => document.getElementById(id);

function loadOverrides() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return parsed?.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
  } catch {
    return {};
  }
}

let overrides = loadOverrides();

function saveOverrides() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({schemaVersion: 1, snapshotThrough: LEAGUE_SNAPSHOT_2026.through, entries: overrides}));
}

function stableOverrideEntries(source) {
  return Object.entries(source || {})
    .map(([gameId, value]) => [gameId, typeof value === 'string' ? value : value?.result])
    .filter(([, value]) => value)
    .sort(([left], [right]) => left.localeCompare(right));
}

function normalInputFingerprint(iterations, seed, sourceOverrides) {
  return JSON.stringify({iterations: Number(iterations), seed: String(seed), overrides: stableOverrideEntries(sourceOverrides)});
}

function setAppView(view) {
  const leagueActive = view === 'league';
  document.body.classList.toggle('leagueSimulatorMode', leagueActive);
  byId('gameProbabilityView').hidden = leagueActive;
  byId('leagueSimulatorView').hidden = !leagueActive;
  byId('gameProbabilityTab').classList.toggle('active', !leagueActive);
  byId('leagueSimulatorTab').classList.toggle('active', leagueActive);
  byId('gameProbabilityTab').setAttribute('aria-selected', String(!leagueActive));
  byId('leagueSimulatorTab').setAttribute('aria-selected', String(leagueActive));
  if (leagueActive && !latestResult) runSimulation();
}

function setLeague(league) {
  activeLeague = league;
  const central = league === LEAGUES.CENTRAL;
  byId('centralLeagueTab').classList.toggle('active', central);
  byId('pacificLeagueTab').classList.toggle('active', !central);
  byId('centralLeagueTab').setAttribute('aria-selected', String(central));
  byId('pacificLeagueTab').setAttribute('aria-selected', String(!central));
  byId('leagueResultsTitle').textContent = central ? 'セ・リーグ' : 'パ・リーグ';
  renderResults();
  renderFixtures();
}

function percent(value) {
  if (value > 0 && value < 0.05) return '<0.1%';
  return `${value.toFixed(1)}%`;
}

function teamName(teamId) {
  return teamById.get(teamId)?.name || teamId;
}

function leagueGames() {
  return LEAGUE_SNAPSHOT_2026.games.filter(game => teamById.get(game.homeTeamId)?.league === activeLeague && teamById.get(game.awayTeamId)?.league === activeLeague);
}

function overrideCountForLeague() {
  const ids = new Set(leagueGames().map(game => game.id));
  return Object.keys(overrides).filter(id => ids.has(id)).length;
}

function renderResults() {
  if (!latestResult) return;
  const teams = latestResult.teams.filter(team => team.league === activeLeague).sort((a, b) => a.expectedRank - b.expectedRank || b.championProbability - a.championProbability);
  byId('leagueSummaryBody').innerHTML = teams.map(team => `
    <tr class="${team.id === TEAM_TIGERS ? 'tigersRow' : ''}">
      <th><span class="leagueTeamMark">${team.id === TEAM_TIGERS ? 'T' : team.previousRank}</span>${team.name}</th>
      <td class="leagueProbabilityStrong">${percent(team.championProbability)}</td><td>${percent(team.csProbability)}</td><td>${team.expectedRank.toFixed(2)}位</td>
      <td>${team.expectedWins.toFixed(1)}勝 ${team.expectedLosses.toFixed(1)}敗 ${team.expectedTies.toFixed(1)}分</td>
    </tr>`).join('');
  byId('leagueRankBody').innerHTML = teams.map(team => `
    <tr class="${team.id === TEAM_TIGERS ? 'tigersRow' : ''}"><th>${team.name}</th>${team.rankProbabilities.map(value => `<td>${percent(value)}</td>`).join('')}</tr>`).join('');
  byId('leagueOverrideBadge').textContent = `速報入力 ${overrideCountForLeague()}試合`;
}

function fixtureDate(game) {
  if (game.status === 'PENDING_RESCHEDULE') return '<span class="pendingDate">振替日未定</span>';
  const [, month, day] = game.date.split('-');
  return `${Number(month)}/${Number(day)}`;
}

function renderFixtures() {
  byId('leagueFixtureList').querySelectorAll('[data-fixture-section]').forEach(details => fixtureExpansion.set(details.dataset.fixtureSection, details.open));
  const fixtures = leagueGames().filter(game => game.status !== 'FINAL').sort((a, b) => (a.date || '9999-12-31').localeCompare(b.date || '9999-12-31') || a.id.localeCompare(b.id));
  const count = overrideCountForLeague();
  byId('leagueRemainingCount').textContent = `（残り${fixtures.length}試合・入力${count}）`;
  byId('clearLeagueOverrides').disabled = count === 0;
  const renderRows = games => games.map(game => {
    const value = overrides[game.id]?.result || '';
    return `<div class="leagueFixtureRow ${value ? 'hasOverride' : ''} ${value === CANCELED_OVERRIDE ? 'isCanceled' : ''}">
      <div class="leagueFixtureMeta"><time>${fixtureDate(game)}</time><span>${teamName(game.homeTeamId)} <b>vs</b> ${teamName(game.awayTeamId)}</span><small>${game.venue || '球場未定'}</small></div>
      <label><span class="srOnly">${teamName(game.homeTeamId)}対${teamName(game.awayTeamId)}の結果</span><select class="leagueOverrideSelect" data-game-id="${game.id}">
        <option value="" ${!value ? 'selected' : ''}>未指定</option><option value="HOME_WIN" ${value === GAME_RESULTS.HOME_WIN ? 'selected' : ''}>${teamName(game.homeTeamId)} 勝ち</option>
        <option value="AWAY_WIN" ${value === GAME_RESULTS.AWAY_WIN ? 'selected' : ''}>${teamName(game.awayTeamId)} 勝ち</option><option value="TIE" ${value === GAME_RESULTS.TIE ? 'selected' : ''}>引き分け</option>
        <option value="${CANCELED_OVERRIDE}" ${value === CANCELED_OVERRIDE ? 'selected' : ''}>中止（未消化）</option></select></label>
    </div>`;
  }).join('');
  const today = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Tokyo'}).format(new Date());
  const months = new Map();
  const pending = [];
  for (const game of fixtures) {
    if (game.status === 'PENDING_RESCHEDULE' || !game.date) { pending.push(game); continue; }
    const month = game.date.slice(0, 7);
    if (!months.has(month)) months.set(month, new Map());
    const days = months.get(month);
    if (!days.has(game.date)) days.set(game.date, []);
    days.get(game.date).push(game);
  }
  const section = (key, title, games, content, defaultOpen, kind) => {
    const stateKey = `${activeLeague}:${key}`;
    const open = fixtureExpansion.get(stateKey) ?? defaultOpen;
    const entered = games.filter(game => overrides[game.id]?.result).length;
    return `<details class="leagueFixtureGroup ${kind}" data-fixture-section="${stateKey}" ${open ? 'open' : ''}><summary><span>${title}</span><small>入力済 ${entered} / ${games.length}</small></summary><div class="leagueFixtureGroupBody">${content}</div></details>`;
  };
  byId('leagueFixtureList').innerHTML = [...months].map(([month, days]) => {
    const content = [...days].map(([date, games]) => {
      const [, m, d] = date.split('-');
      const weekday = new Intl.DateTimeFormat('ja-JP', {weekday: 'short', timeZone: 'Asia/Tokyo'}).format(new Date(`${date}T12:00:00+09:00`));
      return section(date, `${Number(m)}/${Number(d)}（${weekday}）`, games, renderRows(games), date === today, 'leagueFixtureDay');
    }).join('');
    return section(month, `${Number(month.slice(5))}月`, [...days.values()].flat(), content, month === today.slice(0, 7), 'leagueFixtureMonth');
  }).join('') + (pending.length ? section('pending', '振替日未定', pending, renderRows(pending), false, 'leagueFixturePending') : '');
  byId('leagueFixtureList').querySelectorAll('[data-fixture-section]').forEach(details => details.addEventListener('toggle', () => {
    if (details.isConnected) fixtureExpansion.set(details.dataset.fixtureSection, details.open);
  }));
}

function renderModelDetails() {
  const detail = model.describe();
  const [year, month, day] = LEAGUE_SNAPSHOT_2026.through.split('-').map(Number);
  const completedGames = LEAGUE_SNAPSHOT_2026.games.filter(game => game.status === 'FINAL').length;
  const ratingRows = LEAGUE_SNAPSHOT_2026.teams.map(team => `<div><span>${team.name}</span><strong>${detail.ratings[team.id].toFixed(1)}</strong></div>`).join('');
  byId('leagueModelDetails').innerHTML = `
    <p><strong>方式</strong> ${year}年${month}月${day}日までの公式${completedGames}試合を時系列に学習したElo。初期1500、K=20、ホーム補正+35。残り試合の計算中はratingを更新しない固定方式です。</p>
    <p><strong>引分</strong> 各リーグの2026年実績を、当季全球団の実績へ120試合分だけ縮約して推定。セ ${percent(detail.tieProbabilities.CENTRAL * 100)}、パ ${percent(detail.tieProbabilities.PACIFIC * 100)}。</p>
    <p><strong>順位</strong> 勝率は引分を除外。セは勝率、勝数、直接対戦、リーグ内勝率、前年順位。パは勝率、直接対戦、リーグ内勝率、前年順位の順です。</p>
    <div class="leagueRatingGrid">${ratingRows}</div><p class="leagueSources"><a href="https://npb.jp/games/2026/" target="_blank" rel="noopener noreferrer">NPB公式 2026試合日程・結果</a> ／ <a href="https://npb.jp/games/2026/info_cs.html" target="_blank" rel="noopener noreferrer">2026年CS規定</a> ／ <a href="https://npb.jp/games/2025/info_cscl.html" target="_blank" rel="noopener noreferrer">セ順位決定方法</a> ／ <a href="https://npb.jp/games/2022/info_cspl.html" target="_blank" rel="noopener noreferrer">パ順位決定方法</a></p>`;
}

async function runSimulation() {
  const button = byId('runLeagueSimulation');
  const status = byId('leagueRunStatus');
  button.disabled = true;
  status.textContent = '計算中...';
  await new Promise(resolve => setTimeout(resolve, 0));
  const started = performance.now();
  try {
    const iterations = Number(byId('leagueIterations').value);
    const seed = byId('leagueRandomSeed').value || 'league-baseline-v1';
    latestResult = simulator.simulate({iterations, seed, overrides});
    latestResultInputFingerprint = normalInputFingerprint(iterations, seed, overrides);
    renderResults(); renderFixtures();
    const conflicts = latestResult.overrideReport.filter(item => item.status === 'CONFLICTS_WITH_OFFICIAL').length;
    status.textContent = `${latestResult.iterations.toLocaleString('ja-JP')}回・残り${latestResult.remainingGames}試合・${((performance.now() - started) / 1000).toFixed(2)}秒${conflicts ? `・公式結果と不一致 ${conflicts}件` : ''}`;
  } catch (error) {
    console.error(error); status.textContent = `計算できませんでした：${error.message}`;
  } finally { button.disabled = false; }
}

function scheduleSimulation() { clearTimeout(runTimer); runTimer = setTimeout(runSimulation, 120); }

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[character]));
}

function defaultScenarioName() {
  const date = new Intl.DateTimeFormat('ja-JP', {timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
  return `What-if ${date}`;
}

function assumptionCount(scenario = activeScenario) {
  return scenario?.game_overrides.filter(record => [WHAT_IF_OUTCOMES.HOME_WIN, WHAT_IF_OUTCOMES.AWAY_WIN, WHAT_IF_OUTCOMES.TIE].includes(record.outcome)).length || 0;
}

function conditionChangeCount(scenario = activeScenario) { return scenario?.game_overrides.length || 0; }

function scenarioSettings() {
  return {model_id: 'league-baseline-v1', ruleset_id: 'npb-2026', iterations: Number(byId('leagueIterations').value), random_seed: byId('leagueRandomSeed').value || 'league-baseline-v1'};
}

function baselineKey(baseContext, settings) { return `${baseContext.base_context_id}|${settings.iterations}|${settings.random_seed || settings.seed}`; }

function cacheCurrentNormalResult(baseContext, settings) {
  const currentFingerprint = normalInputFingerprint(settings.iterations, settings.random_seed, overrides);
  if (latestResult && latestResultInputFingerprint === currentFingerprint) baselineCache.set(baselineKey(baseContext, settings), latestResult);
}

function confirmUnsaved(message = '未保存の変更があります。保存せずに移動しますか？') { return !whatIfDirty || window.confirm(message); }

function scenarioCalculationFingerprint(scenario, baseContext) {
  return JSON.stringify({
    base_context_id: baseContext?.base_context_id,
    game_overrides: scenario?.game_overrides,
    simulation_settings: scenario?.simulation_settings,
  });
}

function setWhatIfDialogStatus(message = '', isError = false) {
  const status = byId('whatIfDialogStatus');
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function reportWhatIfError(action, error) {
  console.error(error);
  const message = `${action}できませんでした。保存データは変更されていません。`;
  byId('whatIfRunStatus').textContent = message;
  byId('whatIfRunStatus').classList.add('error');
  setWhatIfDialogStatus(message, true);
}

function markWhatIfDirty({affectsCalculation = true} = {}) {
  whatIfDirty = true;
  if (affectsCalculation) {
    whatIfCalculationState = 'stale';
    byId('whatIfRunStatus').textContent = '条件が変更されています。再計算してください';
    byId('whatIfRunStatus').classList.remove('error');
  }
  renderWhatIfSummary(); renderWhatIfComparison();
}

function enterWhatIf(baseContext, scenario, {dirty = false} = {}) {
  activeBaseContext = baseContext; activeScenario = scenario; whatIfDirty = dirty;
  whatIfComparison = null; whatIfFilter = 'tigers';
  whatIfCalculationState = 'idle'; whatIfFixtureExpansion.clear();
  document.body.classList.add('whatIfMode');
  byId('leagueNormalContent').hidden = true; byId('whatIfView').hidden = false;
  byId('whatIfScenarioName').value = scenario.name;
  byId('whatIfRunStatus').textContent = '条件を選んで再計算してください';
  byId('whatIfRunStatus').classList.remove('error');
  byId('whatIfComparison').hidden = true;
  renderWhatIf(); window.scrollTo({top: 0, behavior: 'auto'});
}

function exitWhatIf({force = false} = {}) {
  if (!activeScenario) return true;
  if (!force && !confirmUnsaved()) return false;
  activeScenario = null; activeBaseContext = null; whatIfComparison = null;
  whatIfDirty = false;
  whatIfCalculationState = 'idle'; whatIfFixtureExpansion.clear();
  document.body.classList.remove('whatIfMode');
  byId('whatIfView').hidden = true; byId('leagueNormalContent').hidden = false;
  renderResults(); renderFixtures();
  return true;
}

function createNewWhatIf() {
  if (activeScenario && !confirmUnsaved('保存していない変更があります。破棄して新しいWhat-ifを作成しますか？')) return;
  const name = byId('newWhatIfName').value.trim() || defaultScenarioName();
  const settings = scenarioSettings();
  const baseContext = createBaseContext({snapshot: LEAGUE_SNAPSHOT_2026, probabilityModel: model, baseDatasetId: `npb-2026-${LEAGUE_SNAPSHOT_2026.through.replaceAll('-', '')}-v1`, normalOverrides: overrides});
  const scenario = createScenario({name, baseContext, league: teamById.get(TEAM_TIGERS).league, focusTeamId: TEAM_TIGERS, simulationSettings: settings});
  cacheCurrentNormalResult(baseContext, settings);
  byId('whatIfStartDialog').close(); enterWhatIf(baseContext, scenario, {dirty: true});
}

function openSavedScenario(scenarioId) {
  if (activeScenario && !confirmUnsaved('保存していない変更があります。破棄して保存済みScenarioを開きますか？')) return;
  try {
    const bundle = scenarioRepository.getBundle(scenarioId);
    const status = scenarioRepository.getStatus();
    if (!status.ok) throw new Error(status.message);
    if (!bundle) throw new Error('Scenarioが見つかりません');
    setWhatIfDialogStatus();
    byId('whatIfStartDialog').close(); enterWhatIf(bundle.base_context, bundle.scenario);
  } catch (error) {
    reportWhatIfError('Scenarioを読み込み', error);
  }
}

function saveActiveScenario() {
  if (!activeScenario || !activeBaseContext) return;
  try {
    scenarioRepository.save(activeScenario, activeBaseContext); whatIfDirty = false;
    byId('whatIfRunStatus').classList.remove('error');
    byId('whatIfRunStatus').textContent = whatIfCalculationState === 'stale' ? '保存しました。条件を再計算してください' : 'Scenarioを保存しました';
    setWhatIfDialogStatus(); renderWhatIfSummary(); renderSavedScenarios();
  } catch (error) {
    reportWhatIfError('Scenarioを保存', error);
    renderWhatIfSummary();
  }
}

function deleteSavedScenario(scenarioId) {
  try {
    const saved = scenarioRepository.get(scenarioId);
    const status = scenarioRepository.getStatus();
    if (!status.ok) throw new Error(status.message);
    if (!saved || !window.confirm(`「${saved.name}」を削除しますか？`)) return;
    const deletingActive = activeScenario?.scenario_id === scenarioId;
    scenarioRepository.delete(scenarioId);
    if (deletingActive) { whatIfDirty = false; exitWhatIf({force: true}); }
    setWhatIfDialogStatus(); renderSavedScenarios();
  } catch (error) {
    reportWhatIfError('Scenarioを削除', error);
  }
}

function renameSavedScenario(scenarioId) {
  try {
    const saved = scenarioRepository.get(scenarioId);
    const status = scenarioRepository.getStatus();
    if (!status.ok) throw new Error(status.message);
    if (!saved) throw new Error('Scenarioが見つかりません');
    const name = window.prompt('Scenario名', activeScenario?.scenario_id === scenarioId ? activeScenario.name : saved.name)?.trim();
    if (!name || name === saved.name && activeScenario?.name === name) return;
    const baseContext = scenarioRepository.getBaseContext(saved.base_context_id);
    scenarioRepository.save(renameScenario(saved, name), baseContext);
    if (activeScenario?.scenario_id === scenarioId) {
      activeScenario = renameScenario(activeScenario, name);
      byId('whatIfScenarioName').value = activeScenario.name;
    }
    setWhatIfDialogStatus(); renderSavedScenarios(); renderWhatIfSummary(); renderWhatIfComparison();
  } catch (error) {
    reportWhatIfError('Scenario名を変更', error);
  }
}

function renderSavedScenarios() {
  const status = scenarioRepository.getStatus();
  if (!status.ok) {
    setWhatIfDialogStatus('保存データを読み込めません。既存データは上書きされません。', true);
    byId('whatIfSavedList').innerHTML = '<div class="whatIfSavedEmpty whatIfSavedError">保存データが破損しているため一覧を表示できません。</div>';
    return;
  }
  setWhatIfDialogStatus();
  const scenarios = scenarioRepository.list().sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  byId('whatIfSavedList').innerHTML = scenarios.length ? scenarios.map(scenario => `
    <div class="whatIfSavedRow" data-scenario-id="${scenario.scenario_id}"><div class="whatIfSavedMeta"><strong>${escapeHtml(scenario.name)}</strong><span>作成 ${new Date(scenario.created_at).toLocaleString('ja-JP')}・基準 ${escapeHtml(scenario.base_snapshot_date)}・仮定 ${assumptionCount(scenario)}試合・条件 ${conditionChangeCount(scenario)}件</span></div>
      <div class="whatIfSavedActions"><button type="button" data-saved-action="open">開く</button><button type="button" data-saved-action="rename">名前変更</button><button type="button" class="danger" data-saved-action="delete">削除</button></div></div>`).join('') : '<div class="whatIfSavedEmpty">保存済みScenarioはありません</div>';
}

function openWhatIfDialog() {
  byId('newWhatIfName').value = defaultScenarioName(); renderSavedScenarios(); byId('whatIfStartDialog').showModal();
}

function baseOverrideOutcome(gameId) { return activeBaseContext.normal_overrides.find(record => record.game_id === gameId)?.outcome || null; }
function scenarioOverride(gameId) { return activeScenario.game_overrides.find(record => record.game_id === gameId) || null; }

function setScenarioOutcome(gameId, outcome) {
  const current = scenarioOverride(gameId);
  const baseOutcome = baseOverrideOutcome(gameId);
  if (outcome === WHAT_IF_OUTCOMES.UNKNOWN) {
    if (!baseOutcome && !current) return;
    activeScenario = baseOutcome ? withScenarioOverride(activeScenario, activeBaseContext, {game_id: gameId, outcome}) : withoutScenarioOverride(activeScenario, gameId);
  } else {
    if ((!current && baseOutcome === outcome) || current?.outcome === outcome) return;
    activeScenario = withScenarioOverride(activeScenario, activeBaseContext, {game_id: gameId, outcome});
  }
  markWhatIfDirty(); renderWhatIfFixtures();
}

function scenarioDateText(game) {
  if (!game.date) return '振替日未定';
  const [, month, day] = game.date.split('-');
  return `${Number(month)}/${Number(day)}`;
}

function outcomeLabel(outcome, game) {
  if (outcome === WHAT_IF_OUTCOMES.HOME_WIN) return `${teamName(game.homeTeamId)} 勝ち`;
  if (outcome === WHAT_IF_OUTCOMES.AWAY_WIN) return `${teamName(game.awayTeamId)} 勝ち`;
  if (outcome === WHAT_IF_OUTCOMES.TIE) return '引き分け';
  if (outcome === WHAT_IF_OUTCOMES.CANCELED) return '中止（振替対象）';
  return '未指定';
}

function renderWhatIfFixtureRow(entry) {
  const {game} = entry;
  const record = scenarioOverride(game.id);
  const baseOutcome = baseOverrideOutcome(game.id);
  const effective = record?.outcome || baseOutcome || WHAT_IF_OUTCOMES.UNKNOWN;
  const isTigers = game.homeTeamId === TEAM_TIGERS || game.awayTeamId === TEAM_TIGERS;
  const button = (outcome, label) => `<button type="button" class="${effective === outcome ? 'active' : ''}" data-game-id="${game.id}" data-what-if-outcome="${outcome}">${label}</button>`;
  return `<div class="whatIfFixtureRow ${isTigers ? 'tigersFixture' : ''} ${record ? 'hasAssumption' : ''} ${record?.outcome === WHAT_IF_OUTCOMES.CANCELED ? 'isCanceled' : ''}">
    <div class="whatIfFixtureTop"><div class="whatIfFixtureTeams">${teamName(game.homeTeamId)} vs ${teamName(game.awayTeamId)}<small>${game.venue || '球場未定'}</small></div><span class="whatIfFixtureDate">${scenarioDateText(game)}</span></div>
    ${baseOutcome ? `<span class="whatIfBaseOverride">作成時入力：${outcomeLabel(baseOutcome, game)}${record ? '（Scenarioで変更）' : ''}</span>` : ''}
    <div class="whatIfOutcomeGrid">${button(WHAT_IF_OUTCOMES.HOME_WIN, `${teamName(game.homeTeamId)} 勝ち`)}${button(WHAT_IF_OUTCOMES.AWAY_WIN, `${teamName(game.awayTeamId)} 勝ち`)}${button(WHAT_IF_OUTCOMES.TIE, '引き分け')}${button(WHAT_IF_OUTCOMES.UNKNOWN, '未指定')}</div>
    <button type="button" class="whatIfCancelButton ${effective === WHAT_IF_OUTCOMES.CANCELED ? 'active' : ''}" data-game-id="${game.id}" data-what-if-outcome="${WHAT_IF_OUTCOMES.CANCELED}">中止（振替対象・試合は残ります）</button>
  </div>`;
}

function renderWhatIfFixtures() {
  if (!activeBaseContext || !activeScenario) return;
  byId('whatIfFixtureList').querySelectorAll('[data-what-if-section]').forEach(details => whatIfFixtureExpansion.set(details.dataset.whatIfSection, details.open));
  const entries = activeBaseContext.remaining_fixtures.filter(entry => whatIfFilter === 'all' || entry.game.homeTeamId === TEAM_TIGERS || entry.game.awayTeamId === TEAM_TIGERS)
    .sort((left, right) => (left.game.date || '9999-12-31').localeCompare(right.game.date || '9999-12-31') || left.game.id.localeCompare(right.game.id));
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.game.date?.slice(0, 7) || 'pending';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  byId('whatIfFixtureList').innerHTML = [...groups].map(([key, fixtures], index) => {
    const title = key === 'pending' ? '振替日未定' : `${Number(key.slice(5))}月`;
    const stateKey = `${whatIfFilter}:${key}`;
    const open = whatIfFixtureExpansion.get(stateKey) ?? index === 0;
    const entered = fixtures.filter(entry => scenarioOverride(entry.game.id)).length;
    return `<details class="whatIfFixtureGroup" data-what-if-section="${stateKey}" ${open ? 'open' : ''}><summary>${title}<small>条件 ${entered} / ${fixtures.length}</small></summary><div class="whatIfFixtureGroupBody">${fixtures.map(renderWhatIfFixtureRow).join('')}</div></details>`;
  }).join('');
  byId('whatIfFixtureList').querySelectorAll('[data-what-if-section]').forEach(details => details.addEventListener('toggle', () => {
    if (details.isConnected) whatIfFixtureExpansion.set(details.dataset.whatIfSection, details.open);
  }));
  byId('whatIfTigersOnly').classList.toggle('active', whatIfFilter === 'tigers');
  byId('whatIfAllGames').classList.toggle('active', whatIfFilter === 'all');
}

function renderWhatIfSummary() {
  if (!activeScenario || !activeBaseContext) return;
  byId('whatIfBaseMeta').textContent = `基準：${activeScenario.base_snapshot_date}・${whatIfDirty ? '未保存の変更あり' : '保存済み'}`;
  byId('whatIfAssumptionCount').textContent = `仮定：${assumptionCount()}試合・条件変更：${conditionChangeCount()}件`;
  byId('whatIfSimulationMeta').textContent = `${Number(activeScenario.simulation_settings.iterations).toLocaleString('ja-JP')}回・seed ${activeScenario.simulation_settings.random_seed}`;
  byId('saveWhatIfScenario').disabled = !whatIfDirty;
}

function deltaText(value, suffix = 'pt') {
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}${suffix}`;
}
function deltaClass(value) { return value > 0.05 ? 'positive' : value < -0.05 ? 'negative' : ''; }

function renderWhatIfComparison() {
  if (!whatIfComparison) { byId('whatIfComparison').hidden = true; return; }
  const baseline = whatIfComparison.baseline_result;
  const result = whatIfComparison.scenario_result;
  const deltaByTeam = new Map(whatIfComparison.delta.teams.map(team => [team.team_id, team]));
  const baselineByTeam = new Map(baseline.teams.map(team => [team.id, team]));
  const scenarioByTeam = new Map(result.teams.map(team => [team.id, team]));
  const tigersBase = baselineByTeam.get(TEAM_TIGERS);
  const tigersScenario = scenarioByTeam.get(TEAM_TIGERS);
  const tigersDelta = deltaByTeam.get(TEAM_TIGERS);
  byId('whatIfComparison').hidden = false;
  const stateLabel = {calculated: '再計算済み', stale: '条件変更あり', calculating: '計算中', failed: '計算失敗'};
  byId('whatIfResultState').textContent = stateLabel[whatIfCalculationState] || '未計算';
  byId('whatIfResultState').classList.toggle('stale', whatIfCalculationState !== 'calculated');
  byId('whatIfHeadlineResults').innerHTML = [
    ['優勝確率', percent(tigersScenario.championProbability), deltaText(tigersDelta.champion_probability)],
    ['CS確率', percent(tigersScenario.csProbability), deltaText(tigersDelta.cs_probability)],
    ['予想順位', `${tigersScenario.expectedRank.toFixed(1)}位`, deltaText(tigersDelta.expected_rank, '位')],
  ].map(([label, value, delta]) => `<div class="whatIfHeadlineItem"><span>${label}</span><strong>${value}</strong><small>通常から ${delta}</small></div>`).join('');
  const teams = result.teams.filter(team => team.league === activeScenario.league).sort((a, b) => a.expectedRank - b.expectedRank);
  byId('whatIfComparisonBody').innerHTML = teams.map(current => {
    const normal = baselineByTeam.get(current.id);
    const delta = deltaByTeam.get(current.id);
    const wltDelta = `${deltaText(delta.expected_wins, '勝')} / ${deltaText(delta.expected_losses, '敗')} / ${deltaText(delta.expected_ties, '分')}`;
    return `<tr class="${current.id === TEAM_TIGERS ? 'tigersRow' : ''}"><th rowspan="4">${current.name}</th><td>優勝</td><td>${percent(normal.championProbability)}</td><td>${percent(current.championProbability)}</td><td class="${deltaClass(delta.champion_probability)}">${deltaText(delta.champion_probability)}</td></tr>
      <tr class="${current.id === TEAM_TIGERS ? 'tigersRow' : ''}"><td>CS</td><td>${percent(normal.csProbability)}</td><td>${percent(current.csProbability)}</td><td class="${deltaClass(delta.cs_probability)}">${deltaText(delta.cs_probability)}</td></tr>
      <tr class="${current.id === TEAM_TIGERS ? 'tigersRow' : ''}"><td>予想順位</td><td>${normal.expectedRank.toFixed(1)}位</td><td>${current.expectedRank.toFixed(1)}位</td><td class="${deltaClass(-delta.expected_rank)}">${deltaText(delta.expected_rank, '位')}</td></tr>
      <tr class="${current.id === TEAM_TIGERS ? 'tigersRow' : ''}"><td>最終成績</td><td>${normal.expectedWins.toFixed(1)}-${normal.expectedLosses.toFixed(1)}-${normal.expectedTies.toFixed(1)}</td><td>${current.expectedWins.toFixed(1)}-${current.expectedLosses.toFixed(1)}-${current.expectedTies.toFixed(1)}</td><td>${wltDelta}</td></tr>`;
  }).join('');
  byId('whatIfRankBody').innerHTML = [['通常', tigersBase.rankProbabilities], ['What-if', tigersScenario.rankProbabilities], ['差分', tigersDelta.rank_probabilities]]
    .map(([label, values]) => `<tr><th>${label}</th>${values.map(value => `<td class="${label === '差分' ? deltaClass(value) : ''}">${label === '差分' ? deltaText(value) : percent(value)}</td>`).join('')}</tr>`).join('');
}

function renderWhatIf() { renderWhatIfSummary(); renderWhatIfFixtures(); renderWhatIfComparison(); }

async function calculateWhatIf() {
  if (!activeScenario || !activeBaseContext || whatIfCalculating) return;
  const scenarioAtStart = activeScenario;
  const baseContextAtStart = activeBaseContext;
  const fingerprintAtStart = scenarioCalculationFingerprint(scenarioAtStart, baseContextAtStart);
  whatIfCalculating = true;
  whatIfCalculationState = 'calculating';
  const button = byId('runWhatIfSimulation');
  button.disabled = true; byId('whatIfRunStatus').classList.remove('error'); byId('whatIfRunStatus').textContent = 'What-ifを計算中...';
  renderWhatIfComparison();
  await new Promise(resolve => setTimeout(resolve, 0));
  const started = performance.now();
  try {
    const key = baselineKey(baseContextAtStart, scenarioAtStart.simulation_settings);
    let baselineResult = baselineCache.get(key);
    if (!baselineResult) { baselineResult = simulateBaseContext(baseContextAtStart, scenarioAtStart.simulation_settings); baselineCache.set(key, baselineResult); }
    const comparison = compareScenarioToBase(baseContextAtStart, scenarioAtStart, {baselineResult});
    const stillCurrent = activeScenario?.scenario_id === scenarioAtStart.scenario_id
      && activeBaseContext?.base_context_id === baseContextAtStart.base_context_id
      && scenarioCalculationFingerprint(activeScenario, activeBaseContext) === fingerprintAtStart;
    if (!stillCurrent) return;
    whatIfComparison = comparison;
    whatIfCalculationState = 'calculated';
    byId('whatIfRunStatus').textContent = `${whatIfComparison.scenario_result.iterations.toLocaleString('ja-JP')}回・${((performance.now() - started) / 1000).toFixed(2)}秒・仮定${assumptionCount()}試合・条件${conditionChangeCount()}件`;
    renderWhatIfComparison();
  } catch (error) {
    const stillCurrent = activeScenario?.scenario_id === scenarioAtStart.scenario_id
      && activeBaseContext?.base_context_id === baseContextAtStart.base_context_id;
    if (stillCurrent) {
      console.error(error); whatIfCalculationState = 'failed';
      byId('whatIfRunStatus').classList.add('error');
      byId('whatIfRunStatus').textContent = `計算できませんでした：${error.message}`;
      renderWhatIfComparison();
    }
  } finally { whatIfCalculating = false; button.disabled = false; }
}

byId('gameProbabilityTab').addEventListener('click', () => { if (activeScenario && !exitWhatIf()) return; setAppView('game'); });
byId('leagueSimulatorTab').addEventListener('click', () => setAppView('league'));
byId('centralLeagueTab').addEventListener('click', () => setLeague(LEAGUES.CENTRAL));
byId('pacificLeagueTab').addEventListener('click', () => setLeague(LEAGUES.PACIFIC));
byId('runLeagueSimulation').addEventListener('click', runSimulation);
byId('leagueFixtureList').addEventListener('change', event => {
  const select = event.target.closest('.leagueOverrideSelect');
  if (!select) return;
  if (select.value) overrides[select.dataset.gameId] = {result: select.value, setAt: new Date().toISOString(), snapshotThrough: LEAGUE_SNAPSHOT_2026.through};
  else delete overrides[select.dataset.gameId];
  saveOverrides(); renderFixtures(); scheduleSimulation();
});
byId('clearLeagueOverrides').addEventListener('click', () => {
  const ids = new Set(leagueGames().map(game => game.id));
  overrides = Object.fromEntries(Object.entries(overrides).filter(([gameId]) => !ids.has(gameId)));
  saveOverrides(); renderFixtures(); scheduleSimulation();
});

byId('openWhatIf').addEventListener('click', openWhatIfDialog);
byId('closeWhatIfDialog').addEventListener('click', () => byId('whatIfStartDialog').close());
byId('createWhatIfScenario').addEventListener('click', createNewWhatIf);
byId('manageWhatIfScenarios').addEventListener('click', openWhatIfDialog);
byId('saveWhatIfScenario').addEventListener('click', saveActiveScenario);
byId('exitWhatIf').addEventListener('click', () => exitWhatIf());
byId('runWhatIfSimulation').addEventListener('click', calculateWhatIf);
byId('whatIfTigersOnly').addEventListener('click', () => { whatIfFilter = 'tigers'; renderWhatIfFixtures(); });
byId('whatIfAllGames').addEventListener('click', () => { whatIfFilter = 'all'; renderWhatIfFixtures(); });
byId('whatIfScenarioName').addEventListener('input', event => {
  const name = event.target.value.trim();
  if (!name || name === activeScenario?.name) return;
  activeScenario = renameScenario(activeScenario, name); markWhatIfDirty({affectsCalculation: false});
});
byId('whatIfScenarioName').addEventListener('blur', event => {
  if (activeScenario && !event.target.value.trim()) event.target.value = activeScenario.name;
});
byId('whatIfFixtureList').addEventListener('click', event => {
  const button = event.target.closest('[data-what-if-outcome]');
  if (button) setScenarioOutcome(button.dataset.gameId, button.dataset.whatIfOutcome);
});
byId('whatIfSavedList').addEventListener('click', event => {
  const button = event.target.closest('[data-saved-action]');
  const row = event.target.closest('[data-scenario-id]');
  if (!button || !row) return;
  if (button.dataset.savedAction === 'open') openSavedScenario(row.dataset.scenarioId);
  if (button.dataset.savedAction === 'rename') renameSavedScenario(row.dataset.scenarioId);
  if (button.dataset.savedAction === 'delete') deleteSavedScenario(row.dataset.scenarioId);
});
window.addEventListener('beforeunload', event => {
  if (!activeScenario || !whatIfDirty) return;
  event.preventDefault(); event.returnValue = '';
});

renderModelDetails();
renderFixtures();
