import {LEAGUE_SNAPSHOT_2026} from './league-data-2026.mjs';
import {CANCELED_OVERRIDE, GAME_RESULTS, LEAGUES, LeagueBaselineModel, SeasonSimulator} from './league-simulator-core.mjs?v=canceled-1';

const STORAGE_KEY = 'tigersLeagueSimulatorOverridesV1';
const teamById = new Map(LEAGUE_SNAPSHOT_2026.teams.map(team => [team.id, team]));
const model = new LeagueBaselineModel(LEAGUE_SNAPSHOT_2026);
const simulator = new SeasonSimulator({snapshot: LEAGUE_SNAPSHOT_2026, probabilityModel: model});
let activeLeague = LEAGUES.CENTRAL;
let latestResult = null;
let runTimer = 0;
// Presentation state only; never persisted with result overrides.
const fixtureExpansion = new Map();

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
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    schemaVersion: 1,
    snapshotThrough: LEAGUE_SNAPSHOT_2026.through,
    entries: overrides,
  }));
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
  const teams = latestResult.teams
    .filter(team => team.league === activeLeague)
    .sort((a, b) => a.expectedRank - b.expectedRank || b.championProbability - a.championProbability);
  byId('leagueSummaryBody').innerHTML = teams.map(team => `
    <tr class="${team.id === 'T' ? 'tigersRow' : ''}">
      <th><span class="leagueTeamMark">${team.id === 'T' ? 'T' : team.previousRank}</span>${team.name}</th>
      <td class="leagueProbabilityStrong">${percent(team.championProbability)}</td>
      <td>${percent(team.csProbability)}</td>
      <td>${team.expectedRank.toFixed(2)}位</td>
      <td>${team.expectedWins.toFixed(1)}勝 ${team.expectedLosses.toFixed(1)}敗 ${team.expectedTies.toFixed(1)}分</td>
    </tr>`).join('');
  byId('leagueRankBody').innerHTML = teams.map(team => `
    <tr class="${team.id === 'T' ? 'tigersRow' : ''}">
      <th>${team.name}</th>
      ${team.rankProbabilities.map(value => `<td>${percent(value)}</td>`).join('')}
    </tr>`).join('');
  byId('leagueOverrideBadge').textContent = `速報入力 ${overrideCountForLeague()}試合`;
}

function fixtureDate(game) {
  if (game.status === 'PENDING_RESCHEDULE') return '<span class="pendingDate">振替日未定</span>';
  const [, month, day] = game.date.split('-');
  return `${Number(month)}/${Number(day)}`;
}

function renderFixtures() {
  byId('leagueFixtureList').querySelectorAll('[data-fixture-section]').forEach(details => {
    fixtureExpansion.set(details.dataset.fixtureSection, details.open);
  });
  const fixtures = leagueGames()
    .filter(game => game.status !== 'FINAL')
    .sort((a, b) => (a.date || '9999-12-31').localeCompare(b.date || '9999-12-31') || a.id.localeCompare(b.id));
  const count = overrideCountForLeague();
  byId('leagueRemainingCount').textContent = `（残り${fixtures.length}試合・入力${count}）`;
  byId('clearLeagueOverrides').disabled = count === 0;
  const renderRows = games => games.map(game => {
    const value = overrides[game.id]?.result || '';
    return `<div class="leagueFixtureRow ${value ? 'hasOverride' : ''} ${value === CANCELED_OVERRIDE ? 'isCanceled' : ''}">
      <div class="leagueFixtureMeta"><time>${fixtureDate(game)}</time><span>${teamName(game.homeTeamId)} <b>vs</b> ${teamName(game.awayTeamId)}</span><small>${game.venue || '球場未定'}</small></div>
      <label><span class="srOnly">${teamName(game.homeTeamId)}対${teamName(game.awayTeamId)}の結果</span>
        <select class="leagueOverrideSelect" data-game-id="${game.id}">
          <option value="" ${!value ? 'selected' : ''}>未指定</option>
          <option value="HOME_WIN" ${value === GAME_RESULTS.HOME_WIN ? 'selected' : ''}>${teamName(game.homeTeamId)} 勝ち</option>
          <option value="AWAY_WIN" ${value === GAME_RESULTS.AWAY_WIN ? 'selected' : ''}>${teamName(game.awayTeamId)} 勝ち</option>
          <option value="TIE" ${value === GAME_RESULTS.TIE ? 'selected' : ''}>引き分け</option>
          <option value="${CANCELED_OVERRIDE}" ${value === CANCELED_OVERRIDE ? 'selected' : ''}>中止（未消化）</option>
        </select>
      </label>
    </div>`;
  }).join('');
  const today = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Tokyo'}).format(new Date());
  const months = new Map();
  const pending = [];
  for (const game of fixtures) {
    if (game.status === 'PENDING_RESCHEDULE' || !game.date) {
      pending.push(game);
      continue;
    }
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
    return `<details class="leagueFixtureGroup ${kind}" data-fixture-section="${stateKey}" ${open ? 'open' : ''}>
      <summary><span>${title}</span><small>入力済 ${entered} / ${games.length}</small></summary>
      <div class="leagueFixtureGroupBody">${content}</div>
    </details>`;
  };
  byId('leagueFixtureList').innerHTML = [...months].map(([month, days]) => {
    const content = [...days].map(([date, games]) => {
      const [, m, d] = date.split('-');
      const weekday = new Intl.DateTimeFormat('ja-JP', {weekday: 'short', timeZone: 'Asia/Tokyo'}).format(new Date(`${date}T12:00:00+09:00`));
      return section(date, `${Number(m)}/${Number(d)}（${weekday}）`, games, renderRows(games), date === today, 'leagueFixtureDay');
    }).join('');
    return section(month, `${Number(month.slice(5))}月`, [...days.values()].flat(), content, month === today.slice(0, 7), 'leagueFixtureMonth');
  }).join('') + (pending.length ? section('pending', '振替日未定', pending, renderRows(pending), false, 'leagueFixturePending') : '');
  // Listen on each current element so queued toggle events from replaced nodes cannot overwrite state.
  byId('leagueFixtureList').querySelectorAll('[data-fixture-section]').forEach(details => {
    details.addEventListener('toggle', () => {
      if (details.isConnected) fixtureExpansion.set(details.dataset.fixtureSection, details.open);
    });
  });
}

function renderModelDetails() {
  const detail = model.describe();
  const [year, month, day] = LEAGUE_SNAPSHOT_2026.through.split('-').map(Number);
  const completedGames = LEAGUE_SNAPSHOT_2026.games.filter(game => game.status === 'FINAL').length;
  const ratingRows = LEAGUE_SNAPSHOT_2026.teams
    .map(team => `<div><span>${team.name}</span><strong>${detail.ratings[team.id].toFixed(1)}</strong></div>`)
    .join('');
  byId('leagueModelDetails').innerHTML = `
    <p><strong>方式</strong> ${year}年${month}月${day}日までの公式${completedGames}試合を時系列に学習したElo。初期1500、K=20、ホーム補正+35。残り試合の計算中はratingを更新しない固定方式です。</p>
    <p><strong>引分</strong> 各リーグの2026年実績を、当季全球団の実績へ120試合分だけ縮約して推定。セ ${percent(detail.tieProbabilities.CENTRAL * 100)}、パ ${percent(detail.tieProbabilities.PACIFIC * 100)}。</p>
    <p><strong>順位</strong> 勝率は引分を除外。セは勝率、勝数、直接対戦、リーグ内勝率、前年順位。パは勝率、直接対戦、リーグ内勝率、前年順位の順です。</p>
    <div class="leagueRatingGrid">${ratingRows}</div>
    <p class="leagueSources"><a href="https://npb.jp/games/2026/" target="_blank" rel="noopener noreferrer">NPB公式 2026試合日程・結果</a> ／ <a href="https://npb.jp/games/2026/info_cs.html" target="_blank" rel="noopener noreferrer">2026年CS規定</a> ／ <a href="https://npb.jp/games/2025/info_cscl.html" target="_blank" rel="noopener noreferrer">セ順位決定方法</a> ／ <a href="https://npb.jp/games/2022/info_cspl.html" target="_blank" rel="noopener noreferrer">パ順位決定方法</a></p>`;
}

async function runSimulation() {
  const button = byId('runLeagueSimulation');
  const status = byId('leagueRunStatus');
  button.disabled = true;
  status.textContent = '計算中...';
  await new Promise(resolve => setTimeout(resolve, 0));
  const started = performance.now();
  try {
    latestResult = simulator.simulate({
      iterations: Number(byId('leagueIterations').value),
      seed: byId('leagueRandomSeed').value || 'league-baseline-v1',
      overrides,
    });
    renderResults();
    renderFixtures();
    const conflicts = latestResult.overrideReport.filter(item => item.status === 'CONFLICTS_WITH_OFFICIAL').length;
    const elapsed = ((performance.now() - started) / 1000).toFixed(2);
    status.textContent = `${latestResult.iterations.toLocaleString('ja-JP')}回・残り${latestResult.remainingGames}試合・${elapsed}秒${conflicts ? `・公式結果と不一致 ${conflicts}件` : ''}`;
  } catch (error) {
    console.error(error);
    status.textContent = `計算できませんでした：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function scheduleSimulation() {
  clearTimeout(runTimer);
  runTimer = setTimeout(runSimulation, 120);
}

byId('gameProbabilityTab').addEventListener('click', () => setAppView('game'));
byId('leagueSimulatorTab').addEventListener('click', () => setAppView('league'));
byId('centralLeagueTab').addEventListener('click', () => setLeague(LEAGUES.CENTRAL));
byId('pacificLeagueTab').addEventListener('click', () => setLeague(LEAGUES.PACIFIC));
byId('runLeagueSimulation').addEventListener('click', runSimulation);
byId('leagueFixtureList').addEventListener('change', event => {
  const select = event.target.closest('.leagueOverrideSelect');
  if (!select) return;
  if (select.value) {
    overrides[select.dataset.gameId] = {result: select.value, setAt: new Date().toISOString(), snapshotThrough: LEAGUE_SNAPSHOT_2026.through};
  } else {
    delete overrides[select.dataset.gameId];
  }
  saveOverrides();
  renderFixtures();
  scheduleSimulation();
});
byId('clearLeagueOverrides').addEventListener('click', () => {
  const ids = new Set(leagueGames().map(game => game.id));
  overrides = Object.fromEntries(Object.entries(overrides).filter(([gameId]) => !ids.has(gameId)));
  saveOverrides();
  renderFixtures();
  scheduleSimulation();
});

renderModelDetails();
renderFixtures();
