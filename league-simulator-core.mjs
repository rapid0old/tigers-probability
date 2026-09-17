export const GAME_RESULTS = Object.freeze({
  HOME_WIN: 'HOME_WIN',
  AWAY_WIN: 'AWAY_WIN',
  TIE: 'TIE',
});

export const CANCELED_OVERRIDE = 'CANCELED';

export const LEAGUES = Object.freeze({CENTRAL: 'CENTRAL', PACIFIC: 'PACIFIC'});

const VALID_RESULTS = new Set(Object.values(GAME_RESULTS));

export function resultFromScores(homeScore, awayScore) {
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return null;
  if (homeScore === awayScore) return GAME_RESULTS.TIE;
  return homeScore > awayScore ? GAME_RESULTS.HOME_WIN : GAME_RESULTS.AWAY_WIN;
}

function ratioCompareDesc(aNumerator, aDenominator, bNumerator, bDenominator) {
  if (!aDenominator && !bDenominator) return 0;
  if (!aDenominator) return bNumerator ? 1 : 0;
  if (!bDenominator) return aNumerator ? -1 : 0;
  return bNumerator * aDenominator - aNumerator * bDenominator;
}

function ratioEqual(aNumerator, aDenominator, bNumerator, bDenominator) {
  if (!aDenominator || !bDenominator) return !aDenominator && !bDenominator && aNumerator === bNumerator;
  return aNumerator * bDenominator === bNumerator * aDenominator;
}

function splitSortedGroup(group, compare, equal) {
  const sorted = [...group].sort(compare);
  const groups = [];
  for (const item of sorted) {
    const current = groups.at(-1);
    if (!current || !equal(current[0], item)) groups.push([item]);
    else current.push(item);
  }
  return groups;
}

function refineGroups(groups, compareFactory, equalFactory) {
  return groups.flatMap(group => {
    if (group.length < 2) return [group];
    const compare = compareFactory(group);
    const equal = equalFactory(group);
    return splitSortedGroup(group, compare, equal);
  });
}

function blankState(teamCount) {
  return {
    wins: new Uint16Array(teamCount),
    losses: new Uint16Array(teamCount),
    ties: new Uint16Array(teamCount),
    leagueWins: new Uint16Array(teamCount),
    leagueLosses: new Uint16Array(teamCount),
    leagueTies: new Uint16Array(teamCount),
    h2hWins: new Uint16Array(teamCount * teamCount),
    h2hLosses: new Uint16Array(teamCount * teamCount),
    h2hTies: new Uint16Array(teamCount * teamCount),
  };
}

function cloneState(state) {
  return Object.fromEntries(Object.entries(state).map(([key, value]) => [key, value.slice()]));
}

function applyResult(state, homeIndex, awayIndex, result, sameLeague, teamCount) {
  const homeH2h = homeIndex * teamCount + awayIndex;
  const awayH2h = awayIndex * teamCount + homeIndex;
  if (result === GAME_RESULTS.HOME_WIN) {
    state.wins[homeIndex] += 1;
    state.losses[awayIndex] += 1;
    state.h2hWins[homeH2h] += 1;
    state.h2hLosses[awayH2h] += 1;
    if (sameLeague) {
      state.leagueWins[homeIndex] += 1;
      state.leagueLosses[awayIndex] += 1;
    }
  } else if (result === GAME_RESULTS.AWAY_WIN) {
    state.losses[homeIndex] += 1;
    state.wins[awayIndex] += 1;
    state.h2hLosses[homeH2h] += 1;
    state.h2hWins[awayH2h] += 1;
    if (sameLeague) {
      state.leagueLosses[homeIndex] += 1;
      state.leagueWins[awayIndex] += 1;
    }
  } else if (result === GAME_RESULTS.TIE) {
    state.ties[homeIndex] += 1;
    state.ties[awayIndex] += 1;
    state.h2hTies[homeH2h] += 1;
    state.h2hTies[awayH2h] += 1;
    if (sameLeague) {
      state.leagueTies[homeIndex] += 1;
      state.leagueTies[awayIndex] += 1;
    }
  } else {
    throw new Error(`Unsupported result: ${result}`);
  }
}

export function validateSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.teams) || !Array.isArray(snapshot.games)) throw new Error('Invalid league snapshot');
  const teams = new Map(snapshot.teams.map(team => [team.id, team]));
  if (teams.size !== 12) throw new Error(`Expected 12 teams, received ${teams.size}`);
  const ids = new Set();
  const counts = Object.fromEntries(snapshot.teams.map(team => [team.id, 0]));
  for (const game of snapshot.games) {
    if (!game.id || ids.has(game.id)) throw new Error(`Duplicate or missing game id: ${game.id}`);
    ids.add(game.id);
    if (!teams.has(game.homeTeamId) || !teams.has(game.awayTeamId) || game.homeTeamId === game.awayTeamId) {
      throw new Error(`Invalid teams for ${game.id}`);
    }
    if (game.status === 'FINAL' && !resultFromScores(game.homeScore, game.awayScore)) throw new Error(`Missing final score for ${game.id}`);
    if (!['FINAL', 'SCHEDULED', 'PENDING_RESCHEDULE'].includes(game.status)) throw new Error(`Invalid status for ${game.id}`);
    if (game.status === 'PENDING_RESCHEDULE' && game.date !== null) throw new Error(`Pending reschedule must have a null date: ${game.id}`);
    counts[game.homeTeamId] += 1;
    counts[game.awayTeamId] += 1;
  }
  for (const [teamId, count] of Object.entries(counts)) {
    if (count !== 143) throw new Error(`${teamId} has ${count} games instead of 143`);
  }
  return {gameCount: snapshot.games.length, teamGameCounts: counts};
}

export class LeagueBaselineModel {
  constructor(snapshot, options = {}) {
    validateSnapshot(snapshot);
    this.snapshot = snapshot;
    this.modelVersion = 'League Baseline Model v1';
    this.initialRating = options.initialRating ?? 1500;
    this.kFactor = options.kFactor ?? 20;
    this.homeAdvantage = options.homeAdvantage ?? 35;
    this.tiePriorGames = options.tiePriorGames ?? 120;
    this.tiePriorRate = options.tiePriorRate ?? null;
    this.tieMinimum = options.tieMinimum ?? 0.005;
    this.tieMaximum = options.tieMaximum ?? 0.12;
    this.teamById = new Map(snapshot.teams.map(team => [team.id, team]));
    this.ratings = Object.fromEntries(snapshot.teams.map(team => [team.id, this.initialRating]));
    this.tieStats = {
      CENTRAL: {games: 0, ties: 0},
      PACIFIC: {games: 0, ties: 0},
      ALL: {games: 0, ties: 0},
    };
    this.fit();
    this.tiePriorRate ??= (this.tieStats.ALL.ties + 1) / (this.tieStats.ALL.games + 2);
    Object.freeze(this.ratings);
    Object.freeze(this.tieStats.CENTRAL);
    Object.freeze(this.tieStats.PACIFIC);
    Object.freeze(this.tieStats.ALL);
    Object.freeze(this.tieStats);
  }

  fit() {
    const completed = this.snapshot.games
      .filter(game => game.status === 'FINAL')
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    for (const game of completed) {
      const homeTeam = this.teamById.get(game.homeTeamId);
      const awayTeam = this.teamById.get(game.awayTeamId);
      const expectedHome = 1 / (1 + 10 ** ((this.ratings[game.awayTeamId] - this.ratings[game.homeTeamId] - this.homeAdvantage) / 400));
      const result = resultFromScores(game.homeScore, game.awayScore);
      const actualHome = result === GAME_RESULTS.HOME_WIN ? 1 : result === GAME_RESULTS.AWAY_WIN ? 0 : 0.5;
      const adjustment = this.kFactor * (actualHome - expectedHome);
      this.ratings[game.homeTeamId] += adjustment;
      this.ratings[game.awayTeamId] -= adjustment;

      this.tieStats.ALL.games += 1;
      if (result === GAME_RESULTS.TIE) this.tieStats.ALL.ties += 1;
      if (homeTeam.league === awayTeam.league) {
        this.tieStats[homeTeam.league].games += 1;
        if (result === GAME_RESULTS.TIE) this.tieStats[homeTeam.league].ties += 1;
      }
    }
  }

  tieProbability(game) {
    const homeLeague = this.teamById.get(game.homeTeamId)?.league;
    const awayLeague = this.teamById.get(game.awayTeamId)?.league;
    const stats = homeLeague === awayLeague ? this.tieStats[homeLeague] : this.tieStats.ALL;
    const estimate = (stats.ties + this.tiePriorGames * this.tiePriorRate) / (stats.games + this.tiePriorGames);
    return Math.max(this.tieMinimum, Math.min(this.tieMaximum, estimate));
  }

  predict(game) {
    if (!this.teamById.has(game.homeTeamId) || !this.teamById.has(game.awayTeamId)) throw new Error(`Unknown team in ${game.id}`);
    const homeWinGivenDecision = 1 / (1 + 10 ** ((this.ratings[game.awayTeamId] - this.ratings[game.homeTeamId] - this.homeAdvantage) / 400));
    const tie = this.tieProbability(game);
    return Object.freeze({
      homeWin: (1 - tie) * homeWinGivenDecision,
      awayWin: (1 - tie) * (1 - homeWinGivenDecision),
      tie,
    });
  }

  describe() {
    return {
      modelVersion: this.modelVersion,
      fixedRatingsThrough: this.snapshot.through,
      initialRating: this.initialRating,
      kFactor: this.kFactor,
      homeAdvantage: this.homeAdvantage,
      tiePriorGames: this.tiePriorGames,
      tiePriorRate: this.tiePriorRate,
      tiePriorSource: '2026 all-team results with Laplace smoothing',
      ratings: {...this.ratings},
      tieProbabilities: {
        CENTRAL: this.tieProbability({homeTeamId: 'T', awayTeamId: 'G'}),
        PACIFIC: this.tieProbability({homeTeamId: 'H', awayTeamId: 'F'}),
      },
    };
  }
}

function hashSeed(seed) {
  const value = String(seed ?? 'league-baseline-v1');
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function createSeededRandom(seed) {
  let state = hashSeed(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function rankLeague(teamIndices, state, teams, league, teamCount) {
  let groups = [teamIndices];
  const overallMetric = index => [state.wins[index], state.wins[index] + state.losses[index]];
  groups = refineGroups(groups,
    () => (a, b) => ratioCompareDesc(...overallMetric(a), ...overallMetric(b)),
    () => (a, b) => ratioEqual(...overallMetric(a), ...overallMetric(b)));

  if (league === LEAGUES.CENTRAL) {
    groups = refineGroups(groups,
      () => (a, b) => state.wins[b] - state.wins[a],
      () => (a, b) => state.wins[a] === state.wins[b]);
  }

  groups = refineGroups(groups,
    group => {
      const metric = index => {
        let wins = 0;
        let losses = 0;
        for (const opponent of group) {
          wins += state.h2hWins[index * teamCount + opponent];
          losses += state.h2hLosses[index * teamCount + opponent];
        }
        return [wins, wins + losses];
      };
      return (a, b) => ratioCompareDesc(...metric(a), ...metric(b));
    },
    group => {
      const metric = index => {
        let wins = 0;
        let losses = 0;
        for (const opponent of group) {
          wins += state.h2hWins[index * teamCount + opponent];
          losses += state.h2hLosses[index * teamCount + opponent];
        }
        return [wins, wins + losses];
      };
      return (a, b) => ratioEqual(...metric(a), ...metric(b));
    });

  const leagueMetric = index => [state.leagueWins[index], state.leagueWins[index] + state.leagueLosses[index]];
  groups = refineGroups(groups,
    () => (a, b) => ratioCompareDesc(...leagueMetric(a), ...leagueMetric(b)),
    () => (a, b) => ratioEqual(...leagueMetric(a), ...leagueMetric(b)));

  groups = refineGroups(groups,
    () => (a, b) => teams[a].previousRank - teams[b].previousRank,
    () => (a, b) => teams[a].previousRank === teams[b].previousRank);
  return groups.flat();
}

export function rankLeagueFromGames({teams, games, league}) {
  const teamIndices = teams.map((team, index) => team.league === league ? index : -1).filter(index => index >= 0);
  const teamIndex = new Map(teams.map((team, index) => [team.id, index]));
  const state = blankState(teams.length);
  for (const game of games) {
    const result = game.result ?? resultFromScores(game.homeScore, game.awayScore);
    if (!result) continue;
    const homeIndex = teamIndex.get(game.homeTeamId);
    const awayIndex = teamIndex.get(game.awayTeamId);
    if (homeIndex === undefined || awayIndex === undefined) throw new Error(`Unknown team in ${game.id ?? 'ranking fixture'}`);
    const sameLeague = teams[homeIndex].league === teams[awayIndex].league;
    applyResult(state, homeIndex, awayIndex, result, sameLeague, teams.length);
  }
  return rankLeague(teamIndices, state, teams, league, teams.length).map(index => teams[index].id);
}

function normalizeOverrides(overrides) {
  if (!overrides || typeof overrides !== 'object') return {};
  return Object.fromEntries(Object.entries(overrides).map(([gameId, value]) => [gameId, typeof value === 'string' ? value : value?.result]));
}

export class SeasonSimulator {
  constructor({snapshot, probabilityModel}) {
    validateSnapshot(snapshot);
    if (!probabilityModel || typeof probabilityModel.predict !== 'function') throw new Error('A GameProbabilityModel with predict(game) is required');
    this.snapshot = snapshot;
    this.probabilityModel = probabilityModel;
    this.teams = snapshot.teams;
    this.teamCount = this.teams.length;
    this.teamIndex = new Map(this.teams.map((team, index) => [team.id, index]));
    this.leagueIndices = Object.fromEntries(Object.values(LEAGUES).map(league => [league, this.teams.map((team, index) => team.league === league ? index : -1).filter(index => index >= 0)]));
  }

  prepare(overrides = {}) {
    const normalized = normalizeOverrides(overrides);
    const baseState = blankState(this.teamCount);
    const remaining = [];
    const report = [];
    const knownIds = new Set();
    for (const game of this.snapshot.games) {
      knownIds.add(game.id);
      const homeIndex = this.teamIndex.get(game.homeTeamId);
      const awayIndex = this.teamIndex.get(game.awayTeamId);
      const sameLeague = this.teams[homeIndex].league === this.teams[awayIndex].league;
      const officialResult = game.status === 'FINAL' ? resultFromScores(game.homeScore, game.awayScore) : null;
      const override = normalized[game.id];
      if (officialResult) {
        applyResult(baseState, homeIndex, awayIndex, officialResult, sameLeague, this.teamCount);
        if (override) report.push({gameId: game.id, status: override === officialResult ? 'MATCHES_OFFICIAL' : 'CONFLICTS_WITH_OFFICIAL', override, officialResult});
      } else if (VALID_RESULTS.has(override)) {
        applyResult(baseState, homeIndex, awayIndex, override, sameLeague, this.teamCount);
        report.push({gameId: game.id, status: 'APPLIED', override});
      } else {
        if (override === CANCELED_OVERRIDE) report.push({gameId: game.id, status: 'PENDING_RESCHEDULE', override});
        remaining.push({game, homeIndex, awayIndex, sameLeague, probabilities: this.probabilityModel.predict(game)});
      }
    }
    for (const [gameId, override] of Object.entries(normalized)) {
      if (!knownIds.has(gameId)) report.push({gameId, status: 'UNKNOWN_GAME', override});
    }
    for (const entry of remaining) {
      const {homeWin, awayWin, tie} = entry.probabilities;
      if (![homeWin, awayWin, tie].every(value => Number.isFinite(value) && value >= 0) || Math.abs(homeWin + awayWin + tie - 1) > 1e-10) {
        throw new Error(`Invalid probabilities for ${entry.game.id}`);
      }
    }
    return {baseState, remaining, overrideReport: report};
  }

  simulate({iterations = 50000, seed = 'league-baseline-v1', overrides = {}} = {}) {
    const simulationCount = Number(iterations);
    if (!Number.isInteger(simulationCount) || simulationCount < 1 || simulationCount > 200000) throw new Error('iterations must be an integer from 1 to 200000');
    const {baseState, remaining, overrideReport} = this.prepare(overrides);
    const random = createSeededRandom(seed);
    const rankCounts = new Uint32Array(this.teamCount * 6);
    const winTotals = new Float64Array(this.teamCount);
    const lossTotals = new Float64Array(this.teamCount);
    const tieTotals = new Float64Array(this.teamCount);
    const rankTotals = new Float64Array(this.teamCount);

    for (let iteration = 0; iteration < simulationCount; iteration += 1) {
      const state = cloneState(baseState);
      for (const entry of remaining) {
        const roll = random();
        const result = roll < entry.probabilities.homeWin
          ? GAME_RESULTS.HOME_WIN
          : roll < entry.probabilities.homeWin + entry.probabilities.awayWin
            ? GAME_RESULTS.AWAY_WIN
            : GAME_RESULTS.TIE;
        applyResult(state, entry.homeIndex, entry.awayIndex, result, entry.sameLeague, this.teamCount);
      }
      for (const league of Object.values(LEAGUES)) {
        const ranking = rankLeague(this.leagueIndices[league], state, this.teams, league, this.teamCount);
        ranking.forEach((teamIndex, rankIndex) => {
          rankCounts[teamIndex * 6 + rankIndex] += 1;
          rankTotals[teamIndex] += rankIndex + 1;
        });
      }
      for (let teamIndex = 0; teamIndex < this.teamCount; teamIndex += 1) {
        winTotals[teamIndex] += state.wins[teamIndex];
        lossTotals[teamIndex] += state.losses[teamIndex];
        tieTotals[teamIndex] += state.ties[teamIndex];
      }
    }

    const teams = this.teams.map((team, teamIndex) => {
      const rankProbabilities = Array.from({length: 6}, (_, rankIndex) => rankCounts[teamIndex * 6 + rankIndex] / simulationCount * 100);
      return {
        ...team,
        championProbability: rankProbabilities[0],
        csProbability: rankProbabilities.slice(0, 3).reduce((sum, value) => sum + value, 0),
        rankProbabilities,
        expectedWins: winTotals[teamIndex] / simulationCount,
        expectedLosses: lossTotals[teamIndex] / simulationCount,
        expectedTies: tieTotals[teamIndex] / simulationCount,
        expectedRank: rankTotals[teamIndex] / simulationCount,
      };
    });
    return {
      modelVersion: this.probabilityModel.modelVersion || 'GameProbabilityModel',
      snapshotThrough: this.snapshot.through,
      iterations: simulationCount,
      seed: String(seed),
      remainingGames: remaining.length,
      overriddenGames: overrideReport.filter(item => item.status === 'APPLIED').length,
      overrideReport,
      teams,
    };
  }
}

export function summarizeProbabilityTotals(result, league) {
  const teams = result.teams.filter(team => team.league === league);
  return {
    champion: teams.reduce((sum, team) => sum + team.championProbability, 0),
    cs: teams.reduce((sum, team) => sum + team.csProbability, 0),
    rankByTeam: Object.fromEntries(teams.map(team => [team.id, team.rankProbabilities.reduce((sum, value) => sum + value, 0)])),
  };
}
