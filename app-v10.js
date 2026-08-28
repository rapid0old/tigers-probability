(() => {
'use strict';

const GAME_STORAGE = 'tigersGameStateV1';
const AVG_PITCHER_ID = '__avg_pitcher__';
const rosterSnapshot = window.NPB_2026_ROSTER_SNAPSHOT || {snapshotDate:'',rosters:{}};
const statsSnapshot = window.NPB_2026_STATS_SNAPSHOT || {snapshotDate:'',parks:{factors:{}},platoon:{factors:{}}};
const PRIMARY_PARK_BY_TEAM = {
  Giants:'tokyo-dome', Tigers:'koshien', BayStars:'yokohama', Carp:'mazda', Dragons:'vantelin', Swallows:'jingu',
  Hawks:'paypay', Fighters:'escon', Buffaloes:'kyocera', Eagles:'rakuten-mobile', Lions:'belluna', Marines:'zozo'
};
let pitchLoads = {};
let pitcherUsageRoles = {};
let lastAction = '';
let autosaveTimer = null;
let searchTarget = null;
let stealBase = 0;
let redoHistory = [];
let gameEnded = false;
let gameEndReason = '';
let pendingRunnerPlay = null;
let openDockPanel = '';
let dockProxyClick = false;
let lastCalculationDetail = null;
const pendingControlHistory = new WeakMap();
const dockControlHistory = new WeakMap();

function normalizedName(value){
  return String(value||'').normalize('NFKC').replace(/[\s　・.]/g,'').replace(/髙/g,'高').replace(/﨑/g,'崎').toLowerCase();
}
function nameKeys(value){
  const key=normalizedName(value),keys=new Set([key]);
  keys.add(key.replace(/^[a-z]/,''));
  return keys;
}
function samePlayerName(a,b){
  const left=nameKeys(a),right=nameKeys(b);
  return [...left].some(key=>key&&right.has(key));
}
function teamAverageBatter(team){
  return {id:AVG_LINEUP_ID,team,name:`${TEAM_NAME[team]} 野手平均`,off:INITIAL_TEAM_BAT[team]||1,spd:1,role:'球団平均',averageFallback:true,rosterFallback:true};
}
function teamAveragePitcher(team){
  return {id:AVG_PITCHER_ID,team,name:`${TEAM_NAME[team]} 投手平均`,pit:INITIAL_TEAM_PIT[team]||1,role:'球団平均',averageFallback:true,rosterFallback:true};
}
function hydrateRoster(target){
  if(!target?.byBat||!target?.byPit)return;
  for(const [team,players] of Object.entries(rosterSnapshot.rosters||{})){
    target.byBat[team]=target.byBat[team]||[];
    target.byPit[team]=target.byPit[team]||[];
    for(const source of players){
      const type=source.position==='投手'?'pit':'bat',arr=type==='pit'?target.byPit[team]:target.byBat[team];
      if(arr.some(player=>samePlayerName(displayName(player),source.name)))continue;
      if(type==='pit')arr.push({...source,team,pit:INITIAL_TEAM_PIT[team]||1,role:'投手',rosterFallback:true});
      else arr.push({...source,team,off:INITIAL_TEAM_BAT[team]||1,spd:1,role:source.position,rosterFallback:true});
    }
  }
}

hydrateRoster(initialModel);
if(model)hydrateRoster(model);
const buildModelV09=buildModel;
buildModel=function(){buildModelV09();hydrateRoster(initialModel);if(model)hydrateRoster(model)};

const playerBatRatesV09=playerBatRates;
playerBatRates=function(player){
  if(player?.rosterFallback&&model){
    const rate=model.teamB?.[player.team]||model.lb;
    return {s1:rate.s1||0,d2:rate.d2||0,t3:rate.t3||0,hr:rate.hr||0,bb:rate.bb||0,hbp:rate.hbp||0,k:rate.k||0,dp:rate.dp||0};
  }
  return playerBatRatesV09(player);
};
const pitcherRatesV09=pitcherRates;
pitcherRates=function(player,team){
  if(player?.rosterFallback&&model){
    const rate=model.teamP?.[team]||model.lp;
    return {h:rate.h||0,hr:rate.hr||0,bb:rate.bb||0,hbp:rate.hbp||0,k:rate.k||0};
  }
  return pitcherRatesV09(player,team);
};
const getPlayerByIdV09=getPlayerById;
getPlayerById=function(team,id,type){
  if(type==='bat'&&id===AVG_LINEUP_ID)return teamAverageBatter(team);
  if(type==='pit'&&id===AVG_PITCHER_ID)return teamAveragePitcher(team);
  return getPlayerByIdV09(team,id,type);
};
const lineupBatterV09=lineupBatter;
lineupBatter=function(team,id){return !id||id===AVG_LINEUP_ID?teamAverageBatter(team):lineupBatterV09(team,id)};
pitcherLineupLabel=function(team){
  const player=currentPitcherFor(team);
  return player?.averageFallback?`${TEAM_NAME[team]} 投手平均`:(player?`投手 ${displayName(player)}`:'投手平均');
};

fillPlayerSelect=function(select,players){
  const old=select.value,team=players?.[0]?.team||(select.id==='tigersPitcher'?TEAM_T:$('opponent').value);
  select.innerHTML='';
  const average=document.createElement('option');average.value=AVG_PITCHER_ID;average.textContent=`${TEAM_NAME[team]} 投手平均`;select.appendChild(average);
  for(const player of sortedPlayers(players)){const option=document.createElement('option');option.value=player.id;option.textContent=playerOptionLabel(player,'pit');select.appendChild(option)}
  select.value=[...select.options].some(option=>option.value===old)?old:AVG_PITCHER_ID;
};
fillSubstitutionSelect=function(select,players,type,placeholder){
  const old=select.value,team=players?.[0]?.team||'';select.innerHTML='';
  const empty=document.createElement('option');empty.value='';empty.textContent=placeholder;select.appendChild(empty);
  const average=document.createElement('option');average.value=type==='pit'?AVG_PITCHER_ID:AVG_LINEUP_ID;average.textContent=type==='pit'?`${TEAM_NAME[team]} 投手平均`:`${TEAM_NAME[team]} 野手平均`;select.appendChild(average);
  for(const player of sortedPlayers(players)){const option=document.createElement('option');option.value=player.id;option.textContent=playerOptionLabel(player,type);select.appendChild(option)}
  select.value=[...select.options].some(option=>option.value===old)?old:'';
};

function createFieldStateUI(){
  const diamond=document.querySelector('.bases'),runnerGrid=document.querySelector('.runnerGrid');
  const details=document.createElement('details');details.id='fieldStateDetails';details.className='fieldStateDetails';details.open=true;
  const summary=document.createElement('summary');summary.id='fieldStateSummary';summary.textContent='現在の投手・打者・走者';
  const body=document.createElement('div');body.className='fieldStateBody';
  const matchup=document.createElement('div');matchup.className='matchupPanel';matchup.innerHTML=`
    <div class="matchupItem"><div class="matchupLabel">現在の打者</div><div class="matchupValue" id="currentBatterName">--</div></div>
    <div class="matchupItem"><div class="matchupLabel">現在の投手</div><div class="matchupValue" id="currentPitcherName">--</div></div>
    <div class="fatigueControl"><div><label for="pitcherFatigue">現在投手の投球数</label><div class="small" id="fatigueHint">10球単位の疲労補正</div></div><select id="pitcherFatigue"></select></div>`;
  const fatigue=matchup.querySelector('#pitcherFatigue');
  for(let value=0;value<=110;value+=10){const option=document.createElement('option');option.value=String(value);option.textContent=value===110?'110球以上':`${value}–${value+9}球`;fatigue.appendChild(option)}
  diamond.parentNode.insertBefore(details,runnerGrid);details.append(summary,body);body.append(matchup,runnerGrid);
  for(const [index,row] of [...runnerGrid.children].entries()){
    const base=index+1,actions=document.createElement('div');actions.className='runnerActions';
    actions.innerHTML=`<button type="button" data-advance-runner="${base}">進塁</button><button type="button" data-steal-runner="${base}">盗塁</button>`;
    row.appendChild(actions);
  }
  const last=document.createElement('div');last.id='lastActionStatus';last.className='lastActionStatus';last.setAttribute('aria-live','polite');last.textContent='直前動作：なし';
  document.querySelector('.playGrid').after(last);
  const undo=$('undoBtn');
  for(const [play,label] of [['ADV','進塁打'],['SF','犠牲フライ'],['DP','併殺打'],['E','エラー']]){const button=document.createElement('button');button.className='playBtn';button.dataset.play=play;button.textContent=label;undo.before(button)}
  const historyDock=document.createElement('div');historyDock.id='historyDock';historyDock.className='historyDock';historyDock.setAttribute('aria-label','入力履歴');
  undo.textContent='← 戻る';undo.className='historyControl historyBack';undo.setAttribute('aria-label','ひとつ前の入力に戻る');
  const redo=document.createElement('button');redo.id='redoBtn';redo.type='button';redo.className='historyControl historyForward';redo.textContent='進む →';redo.setAttribute('aria-label','取り消した入力をやり直す');redo.disabled=true;
  historyDock.append(undo,redo);document.body.appendChild(historyDock);
}

function createSearchDialog(){
  const dialog=document.createElement('dialog');dialog.id='playerSearchDialog';dialog.className='playerSearchDialog';dialog.innerHTML=`
    <div class="dialogHeader"><strong id="playerSearchTitle">選手検索</strong><button type="button" id="closePlayerSearch" aria-label="閉じる">×</button></div>
    <input id="playerSearchInput" type="search" enterkeyhint="search" autocomplete="off" placeholder="選手名を入力">
    <div id="playerSearchResults" class="playerSearchResults"></div>`;
  document.body.appendChild(dialog);
  $('closePlayerSearch').onclick=()=>dialog.close();
  $('playerSearchInput').addEventListener('input',renderSearchResults);
}
function createStealDialog(){
  const dialog=document.createElement('dialog');dialog.id='stealDialog';dialog.className='stealDialog';dialog.innerHTML=`
    <div class="dialogHeader"><strong>盗塁結果</strong><button type="button" id="closeStealDialog" aria-label="閉じる">×</button></div>
    <div class="stealText" id="stealDialogText">--</div>
    <div class="stealActions"><button type="button" class="primary" id="stealSuccess">成功</button><button type="button" class="danger" id="stealFailure">盗塁死</button><button type="button" class="cancelSteal" id="stealCancel">キャンセル</button></div>`;
  document.body.appendChild(dialog);
  $('closeStealDialog').onclick=$('stealCancel').onclick=()=>dialog.close();
  $('stealSuccess').onclick=()=>completeSteal(true);
  $('stealFailure').onclick=()=>completeSteal(false);
}
function createGameResultDialog(){
  const dialog=document.createElement('dialog');dialog.id='gameResultDialog';dialog.className='gameResultDialog';dialog.innerHTML=`
    <div class="gameResultEyebrow">試合終了</div>
    <div class="gameResultMessage" id="gameResultMessage">--</div>
    <div class="gameResultScore" id="gameResultScore">--</div>
    <div class="gameResultActions"><button type="button" class="secondary" id="gameResultBack">戻る</button><button type="button" class="primary" id="startNextGame">次の試合へ</button></div>`;
  document.body.appendChild(dialog);
  $('gameResultBack').onclick=returnToFinishedGame;
  $('startNextGame').onclick=startNextGame;
  dialog.addEventListener('cancel',event=>{event.preventDefault();returnToFinishedGame()});
}
function createRunnerAdvanceDialog(){
  const dialog=document.createElement('dialog');dialog.id='runnerAdvanceDialog';dialog.className='runnerAdvanceDialog';dialog.innerHTML=`
    <div class="dialogHeader"><strong id="runnerAdvanceTitle">走者の行き先</strong><button type="button" id="closeRunnerAdvance" aria-label="閉じる">×</button></div>
    <div class="runnerAdvanceLead" id="runnerAdvanceLead">打席結果に合わせて走者の行き先を選択してください。</div>
    <div class="runnerAdvanceRows" id="runnerAdvanceRows"></div>
    <div class="runnerAdvancePreview" id="runnerAdvancePreview" aria-live="polite"></div>
    <div class="runnerAdvanceActions"><button type="button" class="secondary" id="cancelRunnerAdvance">キャンセル</button><button type="button" class="primary" id="confirmRunnerAdvance">この結果で確定</button></div>`;
  document.body.appendChild(dialog);
  const cancel=()=>{pendingRunnerPlay=null;if(dialog.open)dialog.close()};
  $('closeRunnerAdvance').onclick=$('cancelRunnerAdvance').onclick=cancel;
  $('confirmRunnerAdvance').onclick=confirmRunnerAdvance;
  dialog.addEventListener('cancel',event=>{event.preventDefault();cancel()});
}

function dockShortTeam(team){
  return {Tigers:'阪神',Giants:'巨人',BayStars:'DeNA',Carp:'広島',Dragons:'中日',Swallows:'ヤクルト',Hawks:'ソフトバンク',Fighters:'日本ハム',Buffaloes:'オリックス',Eagles:'楽天',Lions:'西武',Marines:'ロッテ'}[team]||TEAM_NAME[team]||team;
}
function dockPanelButton(panel){return document.querySelector(`.gameDockTab[data-dock-panel="${panel}"]`)}
function setDockPanel(panel=''){
  openDockPanel=openDockPanel===panel?'':panel;
  document.querySelectorAll('.gameDockPanel').forEach(item=>{item.hidden=item.dataset.dockPanel!==openDockPanel});
  document.querySelectorAll('.gameDockTab').forEach(button=>{const active=button.dataset.dockPanel===openDockPanel;button.classList.toggle('active',active);button.setAttribute('aria-expanded',String(active))});
  document.body.classList.toggle('gameDockOpen',Boolean(openDockPanel));
  if(openDockPanel==='runners')syncDockRunners();
}
function closeGameDock(){if(openDockPanel)setDockPanel(openDockPanel)}
function clickDockSource(selector){dockProxyClick=true;try{document.querySelector(selector)?.click()}finally{dockProxyClick=false}}
function copySelectOptions(source,target){
  const current=target.value;target.replaceChildren(...[...source.options].map(option=>option.cloneNode(true)));target.value=[...target.options].some(option=>option.value===source.value)?source.value:current;
}
function mirrorDockValue(proxy,source){
  proxy.addEventListener('focusin',()=>dockControlHistory.set(proxy,snapshot()));
  proxy.addEventListener('input',()=>{source.value=proxy.value;source.dispatchEvent(new Event('input',{bubbles:true}))});
  proxy.addEventListener('change',()=>{
    const before=dockControlHistory.get(proxy)||snapshot();dockControlHistory.delete(proxy);appendHistoryState(before,true);resumeFinishedGameForEdit();source.value=proxy.value;source.dispatchEvent(new Event('change',{bubbles:true}));
  });
}
function createDockRunnerRows(container){
  for(const base of [1,2,3]){
    const row=document.createElement('div');row.className='dockRunnerRow';row.innerHTML=`
      <label for="dockRunner${base}">${base}塁走者</label>
      <div class="dockRunnerSelect"><select id="dockRunner${base}"></select><button type="button" class="dockRunnerSearch" aria-label="${base}塁走者を検索">検索</button></div>
      <div class="dockRunnerActions"><button type="button" data-advance-runner="${base}">進塁</button><button type="button" data-steal-runner="${base}">盗塁</button></div>`;
    container.appendChild(row);
    const proxy=row.querySelector('select'),source=$('runner'+base);
    proxy.addEventListener('change',()=>{pushHistory();source.value=proxy.value;source.dispatchEvent(new Event('change',{bubbles:true}))});
    row.querySelector('.dockRunnerSearch').onclick=()=>openPlayerSearch(source);
  }
}
function inferredParkId(){
  const homeTeam=$('homeAway')?.value==='home'?TEAM_T:$('opponent')?.value;
  return PRIMARY_PARK_BY_TEAM[homeTeam]||'';
}
function currentParkInfo(){
  const setting=$('ballpark')?.value||'auto',id=setting==='auto'?inferredParkId():setting;
  if(id==='neutral'||!id)return {id:'neutral',name:'球場補正なし',games:0,runsPerGame:statsSnapshot.parks?.leagueRunsPerGame||0,factor:1,setting};
  const park=statsSnapshot.parks?.factors?.[id];
  return park?{...park,setting}:{id,name:'球場補正なし',games:0,runsPerGame:0,factor:1,setting};
}
function createBallparkControl(shell){
  const gamePanel=shell.querySelector('.gameDockPanel[data-dock-panel="game"]'),outButtons=shell.querySelector('.dockOutButtons');
  if(!gamePanel||!outButtons)return;
  const control=document.createElement('div');control.className='dockParkControl';
  const label=document.createElement('label');label.htmlFor='ballpark';label.textContent='球場';
  const select=document.createElement('select');select.id='ballpark';
  const automatic=document.createElement('option');automatic.value='auto';automatic.textContent='自動（ホーム球団の本拠地）';select.appendChild(automatic);
  const neutral=document.createElement('option');neutral.value='neutral';neutral.textContent='球場補正なし';select.appendChild(neutral);
  for(const park of Object.values(statsSnapshot.parks?.factors||{})){
    const option=document.createElement('option');option.value=park.id;option.textContent=park.name;select.appendChild(option);
  }
  control.append(label,select);gamePanel.insertBefore(control,outButtons.previousElementSibling);
}
function createGameDock(){
  const shell=document.createElement('div');shell.id='gameDock';shell.className='gameDockShell';shell.innerHTML=`
    <div class="gameDockInner">
      <button type="button" class="gameDockSummary" id="gameDockSummary" aria-label="試合情報と試合操作を開く">
        <span class="gameDockPrimary"><strong id="dockInningText">1回表</strong><span id="dockScoreText">阪神 0－0 巨人</span><span class="dockCountLights" id="dockOutText" aria-label="ストライク0、ボール0、アウト0">
          <span class="dockCountGroup dockCountStrike"><b>S</b><i data-sbo="strike" data-step="1"></i><i data-sbo="strike" data-step="2"></i></span>
          <span class="dockCountGroup dockCountBall"><b>B</b><i data-sbo="ball" data-step="1"></i><i data-sbo="ball" data-step="2"></i><i data-sbo="ball" data-step="3"></i></span>
          <span class="dockCountGroup dockCountOut"><b>O</b><i data-sbo="out" data-step="1"></i><i data-sbo="out" data-step="2"></i></span>
        </span></span>
        <span class="gameDockSecondary"><span id="dockMatchupText">1番 打者 vs 投手</span><span id="dockSituationText">走者なし</span></span>
      </button>
      <div class="gameDockTabs" role="toolbar" aria-label="試合入力">
        <button type="button" class="gameDockTab" data-dock-panel="game" aria-expanded="false">試合</button>
        <button type="button" class="gameDockTab" data-dock-panel="count" aria-expanded="false">カウント</button>
        <button type="button" class="gameDockTab" data-dock-panel="result" aria-expanded="false">打席結果</button>
        <button type="button" class="gameDockTab" data-dock-panel="runners" aria-expanded="false">走者</button>
        <button type="button" class="gameDockTab" data-dock-panel="players" aria-expanded="false">選手・投手</button>
      </div>
      <div class="gameDockPanel" data-dock-panel="game" hidden>
        <div class="dockPanelHeading">試合</div>
        <div class="dockGameGrid"><div><label for="dockInning">イニング</label><select id="dockInning"></select></div><div class="dockHalfControl"><label>表・裏</label><div class="dockSegment"><button type="button" id="dockTop">表</button><button type="button" id="dockBottom">裏</button><button type="button" id="dockNextHalf">次の半回</button></div></div></div>
        <div class="dockScoreGrid"><div><label for="dockTigersScore">阪神</label><input id="dockTigersScore" type="number" inputmode="numeric" min="0" max="99"></div><div class="dockScoreDash">－</div><div><label for="dockOpponentScore">相手</label><input id="dockOpponentScore" type="number" inputmode="numeric" min="0" max="99"></div></div>
        <label>アウト</label><div class="dockSegment dockOutButtons"><button type="button" data-dock-out="0">0</button><button type="button" data-dock-out="1">1</button><button type="button" data-dock-out="2">2</button></div>
      </div>
      <div class="gameDockPanel" data-dock-panel="count" hidden>
        <div class="dockPanelHeading">ボール・ストライク</div>
        <div class="dockCountGrid"><div><label>ボール</label><div class="dockSegment dockBallButtons"><button type="button" data-dock-ball="0">0</button><button type="button" data-dock-ball="1">1</button><button type="button" data-dock-ball="2">2</button><button type="button" data-dock-ball="3">3</button></div></div><div><label>ストライク</label><div class="dockSegment dockStrikeButtons"><button type="button" data-dock-strike="0">0</button><button type="button" data-dock-strike="1">1</button><button type="button" data-dock-strike="2">2</button></div></div></div>
      </div>
      <div class="gameDockPanel" data-dock-panel="result" hidden><div class="dockPanelHeading">打席結果</div><div class="dockPlayGrid" id="dockPlayGrid"></div></div>
      <div class="gameDockPanel" data-dock-panel="runners" hidden><div class="dockPanelHeading">走者</div><div class="dockRunnerGrid" id="dockRunnerGrid"></div></div>
      <div class="gameDockPanel dockPlayersPanel" data-dock-panel="players" hidden><div class="dockPanelHeading">選手・投手</div><div id="dockPlayerControls"></div></div>
    </div>`;
  document.body.appendChild(shell);createBallparkControl(shell);
  $('gameDockSummary').onclick=()=>setDockPanel('game');
  document.querySelectorAll('.gameDockTab').forEach(button=>button.onclick=()=>setDockPanel(button.dataset.dockPanel));
  copySelectOptions($('inning'),$('dockInning'));mirrorDockValue($('dockInning'),$('inning'));mirrorDockValue($('dockTigersScore'),$('tigersScore'));mirrorDockValue($('dockOpponentScore'),$('oppScore'));
  $('dockTop').onclick=()=>clickDockSource('#topBtn');$('dockBottom').onclick=()=>clickDockSource('#botBtn');$('dockNextHalf').onclick=()=>{clickDockSource('#nextHalf');closeGameDock()};
  document.querySelectorAll('[data-dock-out]').forEach(button=>button.onclick=()=>clickDockSource(`.outBtn[data-o="${button.dataset.dockOut}"]`));
  document.querySelectorAll('[data-dock-ball]').forEach(button=>button.onclick=()=>clickDockSource(`.ballBtn[data-count="${button.dataset.dockBall}"]`));
  document.querySelectorAll('[data-dock-strike]').forEach(button=>button.onclick=()=>clickDockSource(`.strikeBtn[data-count="${button.dataset.dockStrike}"]`));
  for(const [play,label] of [['OUT','凡退'],['K','三振'],['ADV','進塁打'],['SF','犠牲フライ'],['SAC','送りバント'],['BB','四死球'],['1B','単打'],['2B','二塁打'],['3B','三塁打'],['HR','本塁打'],['DP','併殺打'],['E','エラー']]){const button=document.createElement('button');button.type='button';button.className='playBtn';button.dataset.play=play;button.textContent=label;$('dockPlayGrid').appendChild(button)}
  createDockRunnerRows($('dockRunnerGrid'));
  const playerControls=$('dockPlayerControls'),fatigue=document.querySelector('.fatigueControl'),substitution=document.querySelector('.substitutionPanel');
  if(fatigue)playerControls.appendChild(fatigue);if(substitution){substitution.open=true;playerControls.appendChild(substitution)}
  document.addEventListener('click',event=>{if(dockProxyClick)return;if(openDockPanel&&!shell.contains(event.target)&&!event.target.closest('dialog'))closeGameDock()});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&openDockPanel)closeGameDock()});
}
function syncDockRunners(){
  for(const base of [1,2,3]){const source=$('runner'+base),target=$('dockRunner'+base);if(source&&target)copySelectOptions(source,target)}
}
function syncDockCountLights(){
  const values={strike:strikes,ball:balls,out:outs},lights=$('dockOutText');if(!lights)return;
  lights.querySelectorAll('[data-sbo]').forEach(light=>light.classList.toggle('on',Number(light.dataset.step)<=values[light.dataset.sbo]));
  lights.setAttribute('aria-label',`ストライク${strikes}、ボール${balls}、アウト${outs}`);
}
function syncGameDock(){
  if(!$('gameDock'))return;const opponent=$('opponent').value,batting=battingTeam($('homeAway').value,half),fielding=fieldingTeam($('homeAway').value,half),batter=currentBatterFor(batting),pitcher=currentPitcherFor(fielding),order=currentPos(batting)%9+1;
  $('dockInningText').textContent=`${$('inning').value}回${half==='top'?'表':'裏'}`;$('dockScoreText').textContent=`阪神 ${teamScore(TEAM_T)}－${teamScore(opponent)} ${dockShortTeam(opponent)}`;syncDockCountLights();
  $('dockMatchupText').textContent=`${order}番 ${displayLineupName(batting,lineupIds(batting)[currentPos(batting)%9])} vs ${pitcher?displayName(pitcher):`${dockShortTeam(fielding)}投手平均`}`;
  const runnerText=[1,2,3].filter(base=>baseRunners[base]).map(base=>`${base===1?'一':base===2?'二':'三'}:${runnerLabel(batting,baseRunners[base])}`).join(' ');$('dockSituationText').textContent=runnerText||'走者なし';
  $('dockInning').value=$('inning').value;$('dockTigersScore').value=$('tigersScore').value;$('dockOpponentScore').value=$('oppScore').value;
  $('dockTop').classList.toggle('active',half==='top');$('dockBottom').classList.toggle('active',half==='bottom');document.querySelectorAll('[data-dock-out]').forEach(button=>button.classList.toggle('active',Number(button.dataset.dockOut)===outs));document.querySelectorAll('[data-dock-ball]').forEach(button=>button.classList.toggle('active',Number(button.dataset.dockBall)===balls));document.querySelectorAll('[data-dock-strike]').forEach(button=>button.classList.toggle('active',Number(button.dataset.dockStrike)===strikes));
  if(openDockPanel==='runners')syncDockRunners();
}
function selectLabel(select){
  const parent=select.parentElement;
  return parent?.querySelector('label')?.textContent||select.closest('.lineupGrid')?.previousElementSibling?.textContent||'選手';
}
function decorateSearchSelects(){
  const ids=['tigersPitcher','oppPitcher','pinchHitter','pinchRunner','reliefPitcher','runner1','runner2','runner3',...Array.from({length:9},(_,i)=>`tLine${i}`),...Array.from({length:9},(_,i)=>`oLine${i}`)];
  for(const id of ids){
    const select=$(id);if(!select||select.parentElement?.classList.contains('searchSelect'))continue;
    const wrapper=document.createElement('div');wrapper.className='searchSelect';select.parentNode.insertBefore(wrapper,select);wrapper.appendChild(select);
    const button=document.createElement('button');button.type='button';button.className='searchTrigger';button.textContent='検索';button.setAttribute('aria-label',`${selectLabel(select)}を検索`);
    button.onclick=()=>openPlayerSearch(select);wrapper.appendChild(button);
  }
}
function openPlayerSearch(select){
  searchTarget=select;$('playerSearchTitle').textContent=`${selectLabel(select)}を検索`;$('playerSearchInput').value='';renderSearchResults();
  const dialog=$('playerSearchDialog');dialog.showModal();setTimeout(()=>$('playerSearchInput').focus(),0);
}
function renderSearchResults(){
  const results=$('playerSearchResults');results.innerHTML='';if(!searchTarget)return;
  const query=normalizedName($('playerSearchInput').value);
  const options=[...searchTarget.options].filter(option=>!query||normalizedName(option.textContent).includes(query));
  for(const option of options){
    const button=document.createElement('button');button.type='button';button.className='playerSearchResult';button.textContent=option.textContent;
    if(option.value===searchTarget.value)button.classList.add('active');
    button.onclick=()=>{pushHistory();searchTarget.value=option.value;searchTarget.dispatchEvent(new Event('input',{bubbles:true}));searchTarget.dispatchEvent(new Event('change',{bubbles:true}));$('playerSearchDialog').close()};
    results.appendChild(button);
  }
  if(!options.length){const empty=document.createElement('div');empty.className='playerSearchEmpty';empty.textContent='該当する選手はいません';results.appendChild(empty)}
}

createFieldStateUI();
createSearchDialog();
createStealDialog();
createGameResultDialog();
createRunnerAdvanceDialog();
createGameDock();

function pitcherKey(team,player=currentPitcherFor(team)){return `${team}|${player?.id||AVG_PITCHER_ID}`}
function currentFieldingTeam(){return fieldingTeam($('homeAway').value,half)}
function currentPitchLoad(team=currentFieldingTeam(),player=currentPitcherFor(team)){return Number(pitchLoads[pitcherKey(team,player)]||0)}
function isReliefUsage(team,player){
  const key=pitcherKey(team,player),role=pitcherRole(player);
  return pitcherUsageRoles[key]==='relief'||/中継|救援|クローザー|抑え|終盤/.test(role);
}
function fatigueMultiplier(player,team){
  const pitches=currentPitchLoad(team,player);
  if(isReliefUsage(team,player)){
    if(pitches>=40)return 1.08;if(pitches>=30)return 1.04;if(pitches>=20)return 1.015;return 1;
  }
  if(pitches>=110)return 1.12;if(pitches>=100)return 1.09;if(pitches>=90)return 1.065;if(pitches>=80)return 1.045;if(pitches>=70)return 1.03;if(pitches>=60)return 1.02;if(pitches>=50)return 1.01;if(pitches>=40)return 1.005;return 1;
}
function applyFatigue(probs,player,team){
  const multiplier=fatigueMultiplier(player,team);if(multiplier===1)return {...probs};
  const delta=multiplier-1,out={};
  const factors={'1B':1+delta*.8,'2B':1+delta,'3B':1+delta,HR:1+delta*1.15,BB:1+delta*.65,HBP:1+delta*.45,K:1/(1+delta*.7),OUT:1};
  for(const key of ['1B','2B','3B','HR','BB','HBP','K','OUT'])out[key]=(probs[key]||0)*factors[key];
  const total=Object.values(out).reduce((sum,value)=>sum+value,0)||1;for(const key in out)out[key]/=total;out.dpCond=probs.dpCond;return out;
}
function normalizeEventProbabilities(values,dpCond){
  const total=['1B','2B','3B','HR','BB','HBP','K','OUT'].reduce((sum,key)=>sum+(values[key]||0),0)||1,out={};
  for(const key of ['1B','2B','3B','HR','BB','HBP','K','OUT'])out[key]=Math.max(0,(values[key]||0)/total);
  out.dpCond=dpCond;return out;
}
function applyEnvironmentFactor(probs,factor,kind){
  if(!Number.isFinite(factor)||Math.abs(factor-1)<.0001)return {...probs};
  const out={...probs};
  if(kind==='park'){
    out['1B']*=Math.pow(factor,.72);out['2B']*=Math.pow(factor,1.02);out['3B']*=Math.pow(factor,1.08);out.HR*=Math.pow(factor,1.2);
  }else{
    out['1B']*=factor;out['2B']*=Math.pow(factor,1.05);out['3B']*=Math.pow(factor,1.05);out.HR*=Math.pow(factor,1.15);
    out.BB*=Math.pow(factor,.45);out.K/=Math.pow(factor,.35);
  }
  return normalizeEventProbabilities(out,probs.dpCond);
}
function matchupHandInfo(batter,pitcher){
  const bats=batter?.bats||'',throws=pitcher?.throws||'';
  if(!bats||!throws)return {code:'',factor:1,label:'左右情報なし'};
  const code=`${bats}${throws}`,factor=Number(statsSnapshot.platoon?.factors?.[code]||1);
  const handLabel={L:'左',R:'右',S:'両'};
  return {code,factor,label:`${handLabel[bats]||'?'}打 vs ${handLabel[throws]||'?'}投`};
}
function calculationPrediction(){
  const matchup=rawMatchupPrediction(),stages=[];
  let probs={...matchup.probs};stages.push({key:'base',label:'基礎モデル',probs:{...probs}});
  const evidence=learningEvidence(matchup.batter,matchup.pitcher),batterKey=learningPlayerKey(matchup.batter),pitcherKeyValue=learningPlayerKey(matchup.pitcher);
  const direct=batterKey&&pitcherKeyValue?learningIndex?.byMatch.get(`${batterKey}>${pitcherKeyValue}`):null;
  probs=applyObservedLearning(probs,matchup.batter,matchup.pitcher);stages.push({key:'learning',label:'観戦学習',probs:{...probs}});
  const hands=matchupHandInfo(matchup.batter,matchup.pitcher);probs=applyEnvironmentFactor(probs,hands.factor,'platoon');stages.push({key:'platoon',label:'左右',probs:{...probs}});
  const park=currentParkInfo();probs=applyEnvironmentFactor(probs,park.factor,'park');stages.push({key:'park',label:'球場',probs:{...probs}});
  const fatigue=fatigueMultiplier(matchup.pitcher,matchup.def),load=currentPitchLoad(matchup.def,matchup.pitcher);probs=applyFatigue(probs,matchup.pitcher,matchup.def);stages.push({key:'fatigue',label:'投手疲労',probs:{...probs}});
  probs=adjustForCount(probs);stages.push({key:'count',label:'カウント',probs:{...probs}});
  lastCalculationDetail={
    stages,
    batter:{name:matchup.batter?displayName(matchup.batter):`${TEAM_NAME[matchup.team]} 野手平均`,pa:matchup.batter?.pa||0},
    pitcher:{name:matchup.pitcher?displayName(matchup.pitcher):`${TEAM_NAME[matchup.def]} 投手平均`,bf:matchup.pitcher?.bf||0},
    evidence:{weighted:evidence.n,direct:direct?.n||0},hands,park,fatigue,load,balls,strikes,
    snapshotDate:statsSnapshot.snapshotDate||BUILTIN_SNAPSHOT_DATE,
  };
  return {...matchup,probs,calculation:lastCalculationDetail};
}
currentMatchupPrediction=function(){return calculationPrediction()};
const simulateHalfV10=function(team,defTeam,startOut,startBases,startPos,pitcher,rng,walkoffFn,firstCount=null){
  let o=startOut,b=startBases,pos=startPos,runs=0;const lineup=lineupIds(team);let guard=0,firstPlate=true;
  while(o<3&&guard++<80){
    const batter=lineupBatter(team,lineup[pos%9])||model.byBat[team]?.[0]||null;
    const learned=applyObservedLearning(eventProbs(batter,pitcher,defTeam),batter,pitcher),hands=matchupHandInfo(batter,pitcher),platoon=applyEnvironmentFactor(learned,hands.factor,'platoon'),parked=applyEnvironmentFactor(platoon,currentParkInfo().factor,'park'),fatigued=applyFatigue(parked,pitcher,defTeam);
    const probs=firstPlate&&firstCount?adjustForCount(fatigued,firstCount.balls,firstCount.strikes):fatigued;
    const event=pickEvent(probs,rng),result=applyEvent(event,b,o,rng,probs.dpCond);b=result.b;o=result.o;runs+=result.runs;pos=(pos+1)%9;firstPlate=false;
    if(walkoffFn&&result.runs>0&&walkoffFn(runs))break;
  }
  return {runs,pos};
};
simulateHalf=simulateHalfV10;
const initialCurrentMultiplierV09=initialCurrentMultiplier;
initialCurrentMultiplier=function(team,defTeam){return initialCurrentMultiplierV09(team,defTeam)*fatigueMultiplier(currentPitcherFor(defTeam),defTeam)};
const updatePredictionV09=updatePrediction;
updatePrediction=function(){
  updatePredictionV09();if(lastPrediction)lastPrediction.calculation=lastCalculationDetail;
  const team=currentFieldingTeam(),player=currentPitcherFor(team),multiplier=fatigueMultiplier(player,team),hands=lastCalculationDetail?.hands,park=lastCalculationDetail?.park;
  if(hands?.code&&$('predictionNote'))$('predictionNote').textContent+=` 左右 ${hands.label}（${hands.factor.toFixed(3)}倍）を反映。`;
  if(park&&$('predictionNote'))$('predictionNote').textContent+=` 球場 ${park.name}（${park.factor.toFixed(3)}倍）を反映。`;
  if(multiplier>1&&$('predictionNote'))$('predictionNote').textContent+=` 投球数による疲労補正 ${((multiplier-1)*100).toFixed(1)}%相当を反映。`;
};
function totalOutProbability(probs){return (probs?.OUT||0)+(probs?.K||0)}
function signedPoints(value){return `${value>=0?'+':''}${value.toFixed(1)}pt`}
function stageDeltaSummary(before,after){
  const outDelta=(totalOutProbability(after)-totalOutProbability(before))*100;
  const events=[['単打','1B'],['二塁打','2B'],['三塁打','3B'],['本塁打','HR'],['四死球','walk']];
  const deltas=events.map(([label,key])=>[label,key==='walk'?((after.BB||0)+(after.HBP||0)-(before.BB||0)-(before.HBP||0))*100:((after[key]||0)-(before[key]||0))*100]).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]));
  return `総アウト ${signedPoints(outDelta)} / ${deltas[0][0]} ${signedPoints(deltas[0][1])}`;
}
function calculationDetailElement(detail){
  const section=document.createElement('section');section.id='calculationDetail';section.className='calculationDetail';section.hidden=true;
  const heading=document.createElement('h3');heading.textContent='計算要素';section.appendChild(heading);
  const list=document.createElement('div');list.className='calculationFactorList';section.appendChild(list);
  const add=(label,value,note)=>{const row=document.createElement('div');row.className='calculationFactorRow';const title=document.createElement('div');title.className='calculationFactorTitle';const name=document.createElement('strong');name.textContent=label;const delta=document.createElement('span');delta.textContent=value;title.append(name,delta);const description=document.createElement('p');description.textContent=note;row.append(title,description);list.appendChild(row)};
  const stages=detail.stages||[],base=stages[0]?.probs||{};
  add('基礎モデル',`総アウト ${pctText(totalOutProbability(base))}`,`${detail.batter.name} ${detail.batter.pa||0}打席（120打席分をリーグ平均へ縮約）× ${detail.pitcher.name} ${detail.pitcher.bf||0}打者（180打者分を縮約）`);
  for(let index=1;index<stages.length;index++){
    const stage=stages[index],before=stages[index-1].probs,note=stageDeltaSummary(before,stage.probs);let description='';
    if(stage.key==='learning')description=`加重対象 ${detail.evidence.weighted.toFixed(1)}件、同一打者×投手 ${detail.evidence.direct}件。48打席分の基礎値を優先。`;
    if(stage.key==='platoon')description=`${detail.hands.label}。公開された2025 MLB左右別wOBAの差を50%に縮約した ${detail.hands.factor.toFixed(3)}倍。NPB個人別の左右成績ではありません。`;
    if(stage.key==='park')description=`${detail.park.name}。NPB公式試合結果 ${detail.park.games}試合、得点環境 ${detail.park.factor.toFixed(3)}倍（リーグ平均へ180試合縮約、最大±3%）。`;
    if(stage.key==='fatigue')description=`現在 ${detail.load}球、役割別補正 ${detail.fatigue.toFixed(3)}倍。`;
    if(stage.key==='count')description=`B${detail.balls}-S${detail.strikes}。四球・三振・インプレー到達率の保守的補正。`;
    add(stage.label,note,description);
  }
  const source=document.createElement('p');source.className='calculationSource';source.innerHTML=`基礎データ ${detail.snapshotDate.replaceAll('-','/')}時点：<a href="https://npb.jp/bis/2026/stats/" target="_blank" rel="noopener noreferrer">NPB公式個人成績</a>。球場：<a href="https://npb.jp/games/2026/" target="_blank" rel="noopener noreferrer">NPB公式試合結果</a>。左右の効果量：<a href="https://www.mlb.com/news/takeaways-from-first-half-of-2026-season" target="_blank" rel="noopener noreferrer">MLB公式公開集計</a>。`;
  section.appendChild(source);return section;
}
const openProbabilityDetailV10=openProbabilityDetail;
openProbabilityDetail=function(kind){
  openProbabilityDetailV10(kind);if(kind!=='pa'||!lastPrediction?.probs)return;
  const outTotal=(lastPrediction.probs.OUT||0)+(lastPrediction.probs.K||0),total=document.createElement('div');total.id='dialogOutTotal';total.className='dialogOutTotal';
  const label=document.createElement('span'),value=document.createElement('strong');label.textContent='トータルアウト確率';value.textContent=pctText(outTotal);total.append(label,value);$('dialogBody').prepend(total);
  if(lastPrediction.calculation){
    const toggle=document.createElement('button');toggle.type='button';toggle.className='calculationDetailToggle';toggle.textContent='計算要素の詳細';toggle.setAttribute('aria-expanded','false');
    const section=calculationDetailElement(lastPrediction.calculation);toggle.onclick=()=>{section.hidden=!section.hidden;toggle.setAttribute('aria-expanded',String(!section.hidden));toggle.textContent=section.hidden?'計算要素の詳細':'計算要素を閉じる'};
    $('dialogBody').append(toggle,section);
  }
};

function ensureObservationShape(){
  if(!observedLearning)return;
  observedLearning.entries=(observedLearning.entries||[]).map(entry=>{const clean={...entry};delete clean.balls;delete clean.strikes;return clean});
  if(!Array.isArray(observedLearning.steals))observedLearning.steals=[];
}
blankObservedLearning=function(){return {version:1,baselineKey:currentBaselineKey(),startedAt:Date.now(),enabled:true,capture:true,entries:[],steals:[]}};
learningOutcome=function(play){return play==='DP'||play==='ADV'?'OUT':LEARNING_EVENTS.includes(play)?play:null};
recordPlateObservation=function(play,matchup){
  if(!observedLearning?.capture)return;const now=Date.now();
  observedLearning.entries.push({id:`${now}-${Math.random().toString(36).slice(2,8)}`,recordedAt:now,gameDate:$('learningGameDate').value||localDateValue(),team:matchup.team,defTeam:matchup.def,batterKey:learningPlayerKey(matchup.batter),pitcherKey:learningPlayerKey(matchup.pitcher),batterName:matchup.batter?displayName(matchup.batter):'',pitcherName:matchup.pitcher?displayName(matchup.pitcher):'',result:play,outcome:learningOutcome(play)});
  if(observedLearning.entries.length>5000)observedLearning.entries=observedLearning.entries.slice(-5000);saveObservedLearning();
};
function recordSteal(success,runner,team,fromBase){
  if(!observedLearning?.capture)return;ensureObservationShape();const now=Date.now();
  observedLearning.steals.push({id:`sb-${now}-${Math.random().toString(36).slice(2,7)}`,recordedAt:now,gameDate:$('learningGameDate').value||localDateValue(),team,runnerKey:learningPlayerKey(runner),runnerName:runner?displayName(runner):'',fromBase,success:Boolean(success)});
  if(observedLearning.steals.length>2000)observedLearning.steals=observedLearning.steals.slice(-2000);saveObservedLearning();
}
updateLearningUI=function(){
  if(!$('learningStatus')||!observedLearning)return;ensureObservationShape();
  const total=observedLearning.entries.length,eligible=learningIndex?.eligible||0,steals=observedLearning.steals.length,last=[...observedLearning.entries,...observedLearning.steals].sort((a,b)=>(a.recordedAt||0)-(b.recordedAt||0)).at(-1),lastDate=/^\d{4}-\d{2}-\d{2}$/.test(last?.gameDate||'')?last.gameDate.replaceAll('-','/'):'';
  $('learningCapture').checked=observedLearning.capture!==false;$('learningEnabled').checked=observedLearning.enabled!==false;
  $('learningStatus').innerHTML=`<strong>基盤：${currentBaselineLabel()}</strong><br>観戦入力 ${total}打席 / 確率学習 ${eligible}打席 / 盗塁 ${steals}件${lastDate?` / 最終 ${lastDate}`:''}<br>${observedLearning.enabled?'基準を優先しながら観戦データを反映中':'観戦データの確率反映はOFF'}`;
};
clearObservedLearning=function(){
  ensureObservationShape();const total=observedLearning.entries.length,steals=observedLearning.steals.length;if(!total&&!steals){toast('破棄する観戦データはありません');return}
  if(!confirm(`観戦データ ${total}打席・盗塁${steals}件を破棄しますか？`))return;observedLearning=blankObservedLearning();saveObservedLearning();history=[];redoHistory=[];syncHistoryControls();scheduleUpdate();setLastAction('観戦データを破棄しました');
};
exportObservedLearning=function(){
  ensureObservationShape();if(!observedLearning.entries.length&&!observedLearning.steals.length){toast('書き出す観戦データはありません');return}
  const payload={...observedLearning,exportedAt:Date.now(),baselineLabel:currentBaselineLabel()},blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),anchor=document.createElement('a');anchor.href=URL.createObjectURL(blob);anchor.download=`tigers_observed_data_${localDateValue()}.json`;anchor.click();setTimeout(()=>URL.revokeObjectURL(anchor.href),1000);
};
importObservedLearning=async function(file){
  const data=JSON.parse(await file.text());if(data?.version!==1||!Array.isArray(data.entries))throw new Error('対応する観戦データではありません');if(data.baselineKey!==currentBaselineKey())throw new Error('基準スナップショットが異なるため読み込めません');
  const valid=new Set([...LEARNING_EVENTS,null]),entries=data.entries.slice(-5000).filter(entry=>entry&&valid.has(entry.outcome)).map(entry=>({id:String(entry.id||`${Date.now()}-${Math.random()}`).slice(0,80),recordedAt:num(entry.recordedAt)||Date.now(),gameDate:/^\d{4}-\d{2}-\d{2}$/.test(entry.gameDate)?entry.gameDate:localDateValue(),team:String(entry.team||'').slice(0,30),defTeam:String(entry.defTeam||'').slice(0,30),batterKey:String(entry.batterKey||'').slice(0,100),pitcherKey:String(entry.pitcherKey||'').slice(0,100),batterName:String(entry.batterName||'').slice(0,80),pitcherName:String(entry.pitcherName||'').slice(0,80),result:String(entry.result||''),outcome:entry.outcome}));
  const steals=Array.isArray(data.steals)?data.steals.slice(-2000).map(entry=>({id:String(entry.id||`sb-${Date.now()}-${Math.random()}`).slice(0,80),recordedAt:num(entry.recordedAt)||Date.now(),gameDate:/^\d{4}-\d{2}-\d{2}$/.test(entry.gameDate)?entry.gameDate:localDateValue(),team:String(entry.team||'').slice(0,30),runnerKey:String(entry.runnerKey||'').slice(0,100),runnerName:String(entry.runnerName||'').slice(0,80),fromBase:clamp(num(entry.fromBase),1,3),success:Boolean(entry.success)})):[];
  if(!confirm(`現在の観戦データを、読み込んだ ${entries.length}打席・盗塁${steals.length}件で置き換えますか？`))return;observedLearning={version:1,baselineKey:currentBaselineKey(),startedAt:num(data.startedAt)||Date.now(),enabled:data.enabled!==false,capture:data.capture!==false,entries,steals};saveObservedLearning();history=[];redoHistory=[];syncHistoryControls();scheduleUpdate();setLastAction('観戦データを読み込みました');
};
ensureObservationShape();saveObservedLearning();

function stealLearningFactor(player){
  const key=learningPlayerKey(player);if(!key)return 1;const attempts=(observedLearning?.steals||[]).filter(entry=>entry.runnerKey===key);if(!attempts.length)return 1;
  const success=attempts.filter(entry=>entry.success).length,posterior=(success+12*.72)/(attempts.length+12);return clamp(1+(posterior-.72)*.22,.96,1.04);
}
runnerSpeedFactor=function(team){
  const weights={1:.08,2:.11,3:.04};let impact=0;
  for(const base of [1,2,3]){const id=baseRunners[base];if(!id||id===AVG_LINEUP_ID||id===PITCHER_LINEUP_ID)continue;const player=getPlayerById(team,id,'bat'),speed=(player?.spd||1)*stealLearningFactor(player);impact+=(speed-1)*weights[base]}
  return clamp(1+impact,.94,1.06);
};

function actionLabel(play){return {OUT:'凡退',K:'三振',ADV:'進塁打',SF:'犠牲フライ',SAC:'送りバント',BB:'四死球','1B':'単打','2B':'二塁打','3B':'三塁打',HR:'本塁打',DP:'併殺打',E:'エラー'}[play]||play}
function teamScore(team){return Math.max(0,num($(team===TEAM_T?'tigersScore':'oppScore').value))}
function homeTeam(){return $('homeAway').value==='home'?TEAM_T:$('opponent').value}
function awayTeam(){return homeTeam()===TEAM_T?$('opponent').value:TEAM_T}
function closeGameResult(){const dialog=$('gameResultDialog');if(dialog?.open)dialog.close()}
function showGameResult(){
  const tigers=teamScore(TEAM_T),opponent=teamScore($('opponent').value),dialog=$('gameResultDialog');
  $('gameResultMessage').textContent=tigers>opponent?'とらほー🐯!!':tigers<opponent?'まけほー……':'引き分け';
  $('gameResultScore').textContent=`阪神 ${tigers} − ${opponent} ${TEAM_NAME[$('opponent').value]}`;
  if(!dialog.open){if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','')}
}
function finishGame(reason){
  gameEnded=true;gameEndReason=reason||'game-over';if(gameEndReason!=='walkoff')resetOutsAndBases();saveGameState();showGameResult();return true;
}
function returnToFinishedGame(){
  closeGameResult();setLastAction('試合終了結果を閉じました');scheduleUpdate();
}
function checkWalkoff(){
  if(gameEnded||Number($('inning').value)<9||half!=='bottom')return false;
  return teamScore(homeTeam())>teamScore(awayTeam())?finishGame('walkoff'):false;
}
nextHalf=function(){
  if(gameEnded){showGameResult();return true}
  const inning=Number($('inning').value),home=homeTeam(),away=awayTeam(),homeScore=teamScore(home),awayScore=teamScore(away);
  if(half==='top'){
    if(inning>=9&&homeScore>awayScore)return finishGame('home-lead-after-top');
    setHalf('bottom',true);return false;
  }
  if(inning>=9&&homeScore!==awayScore)return finishGame(homeScore>awayScore?'home-win-after-bottom':'away-win-after-bottom');
  if(inning>=12)return finishGame('draw-after-12');
  $('inning').value=String(inning+1);setHalf('top',true);return false;
};
function startNextGame(){
  const opponent=$('opponent').value,tigersPitcher=$('tigersPitcher').value,oppPitcher=$('oppPitcher').value;
  closeGameResult();gameEnded=false;gameEndReason='';half='top';$('inning').value='1';$('tigersScore').value='0';$('oppScore').value='0';$('tigersBatterPos').value='0';$('oppBatterPos').value='0';
  resetOutsAndBases();pitchLoads={};pitcherUsageRoles={};
  for(let index=0;index<9;index++)$('tLine'+index).value='';
  fillLineup(TEAM_T,'tLine');fillLineup(opponent,'oLine');
  if([...$('tigersPitcher').options].some(option=>option.value===tigersPitcher))$('tigersPitcher').value=tigersPitcher;
  if([...$('oppPitcher').options].some(option=>option.value===oppPitcher))$('oppPitcher').value=oppPitcher;
  $('topBtn').classList.add('active');$('botBtn').classList.remove('active');refreshRunnerOptions();refreshSubstitutionUI();refreshBatterPosLabels();
  history=[];redoHistory=[];syncHistoryControls();setLastAction('次の試合を開始');scheduleUpdate();
}

function playNeedsRunnerChoice(play){return ['1B','2B','E','ADV','SF','SAC'].includes(play)&&[1,2,3].some(base=>baseRunners[base])}
function batterDestination(play){return play==='1B'||play==='E'?1:play==='2B'?2:0}
function runnerDestinationOptions(play,fromBase){
  const batterBase=batterDestination(play),minimum=batterBase&&fromBase<=batterBase?batterBase+1:fromBase,options=[];
  for(let destination=minimum;destination<=4;destination++)options.push(destination);return options;
}
function defaultRunnerDestination(play,fromBase){
  if(play==='SF')return fromBase===3?4:fromBase;
  const advance=play==='2B'?2:1,options=runnerDestinationOptions(play,fromBase),preferred=Math.min(4,fromBase+advance);return options.includes(preferred)?preferred:options[0];
}
function destinationLabel(destination,fromBase){return destination===4?'生還':destination===fromBase?'留まる':`${destination}塁`}
function selectedRunnerDestinations(){
  return Object.fromEntries([...$('runnerAdvanceRows').querySelectorAll('select[data-runner-from]')].map(select=>[Number(select.dataset.runnerFrom),Number(select.value)]));
}
function validateRunnerDestinations(play,destinations,showMessage=true){
  const occupied=new Set(),batterBase=batterDestination(play);if(batterBase)occupied.add(batterBase);
  for(const base of [1,2,3]){
    if(!pendingRunnerPlay?.runners[base])continue;const destination=destinations[base];
    if(destination<4&&occupied.has(destination)){if(showMessage)toast(`${destination}塁に走者が重なります`);return false}if(destination<4)occupied.add(destination);
  }
  const active=[1,2,3].filter(base=>pendingRunnerPlay?.runners[base]);
  for(let index=0;index<active.length-1;index++){
    const trailing=destinations[active[index]],ahead=destinations[active[index+1]];
    if(trailing>ahead&&ahead<4){if(showMessage)toast('前の走者を追い越す配置にはできません');return false}
  }
  return true;
}
function runnerMovePreview(){
  if(!pendingRunnerPlay)return;const destinations=selectedRunnerDestinations(),valid=validateRunnerDestinations(pendingRunnerPlay.play,destinations,false),team=pendingRunnerPlay.team,parts=[],batterBase=batterDestination(pendingRunnerPlay.play);let scored=0;
  if(batterBase)parts.push(`${batterBase}塁：打者`);
  for(const base of [1,2,3]){const id=pendingRunnerPlay.runners[base];if(!id)continue;const destination=destinations[base];if(destination===4)scored++;else parts.push(`${destination}塁：${runnerLabel(team,id)||'走者'}`)}
  $('runnerAdvancePreview').textContent=valid?`確定後：${parts.length?parts.join(' / '):'走者なし'}${scored?` / ${scored}得点`:''}`:'走者の行き先が重複しています';$('runnerAdvancePreview').classList.toggle('invalid',!valid);$('confirmRunnerAdvance').disabled=!valid;
}
function openRunnerAdvanceDialog(play,matchup){
  const team=battingTeam($('homeAway').value,half),runners={1:baseRunners[1]||'',2:baseRunners[2]||'',3:baseRunners[3]||''};pendingRunnerPlay={play,matchup,team,runners};$('runnerAdvanceTitle').textContent=`${actionLabel(play)}：走者の行き先`;$('runnerAdvanceLead').textContent=`打者は${batterDestination(play)?`${batterDestination(play)}塁へ`:'アウト'}。各走者の行き先を確認してください。`;
  const rows=$('runnerAdvanceRows');rows.innerHTML='';
  for(const base of [1,2,3]){
    const id=runners[base];if(!id)continue;const row=document.createElement('div');row.className='runnerAdvanceRow';const label=document.createElement('label');label.textContent=`${base}塁 ${runnerLabel(team,id)||'走者'}`;const select=document.createElement('select');select.dataset.runnerFrom=String(base);select.setAttribute('aria-label',`${base}塁走者の行き先`);
    for(const destination of runnerDestinationOptions(play,base)){const option=document.createElement('option');option.value=String(destination);option.textContent=destinationLabel(destination,base);select.appendChild(option)}select.value=String(defaultRunnerDestination(play,base));select.addEventListener('change',runnerMovePreview);row.append(label,select);rows.appendChild(row);
  }
  runnerMovePreview();$('runnerAdvanceDialog').showModal();
}
function applyChosenRunnerMoves(play,destinations,runners,batter){
  const next={1:'',2:'',3:''},batterBase=batterDestination(play);let scored=0;if(batterBase)next[batterBase]=batter;
  for(const base of [1,2,3]){const id=runners[base];if(!id)continue;const destination=destinations[base];if(destination===4)scored++;else next[destination]=id}
  return {next,scored};
}
function confirmRunnerAdvance(){
  if(!pendingRunnerPlay)return;const destinations=selectedRunnerDestinations();if(!validateRunnerDestinations(pendingRunnerPlay.play,destinations,true))return;
  const pending=pendingRunnerPlay;pendingRunnerPlay=null;$('runnerAdvanceDialog').close();commitPlateResult(pending.play,pending.matchup,destinations,pending.team,pending.runners);
}
function commitPlateResult(play,matchup=rawMatchupPrediction(),destinations=null,team=battingTeam($('homeAway').value,half),runners=null){
  pushHistory();recordPlateObservation(play,matchup);const r=runners||{1:baseRunners[1]||'',2:baseRunners[2]||'',3:baseRunners[3]||''};let next={...r},scored=0;const batter=batterRunnerId(team),runnerOutPlay=['OUT','K','ADV','SF','SAC'].includes(play);
  if(play==='OUT'||play==='K')outs=Math.min(3,outs+1);
  else if(play==='DP'){outs=Math.min(3,outs+2);if(r[1])next[1]='';else if(r[2])next[2]='';else if(r[3])next[3]=''}
  else if(runnerOutPlay){outs=Math.min(3,outs+1);if(outs<3){if(destinations){const chosen=applyChosenRunnerMoves(play,destinations,r,batter);next=chosen.next;scored=chosen.scored}else if(play==='SF'){scored=r[3]?1:0;next={1:r[1]||'',2:r[2]||'',3:''}}else{scored=r[3]?1:0;next={1:'',2:r[1]||'',3:r[2]||''}}}}
  else if(play==='HR'){scored=1+(r[1]?1:0)+(r[2]?1:0)+(r[3]?1:0);next={1:'',2:'',3:''}}
  else if(play==='3B'){scored=(r[1]?1:0)+(r[2]?1:0)+(r[3]?1:0);next={1:'',2:'',3:batter}}
  else if(destinations){const chosen=applyChosenRunnerMoves(play,destinations,r,batter);next=chosen.next;scored=chosen.scored}
  else if(play==='2B'){scored=(r[2]?1:0)+(r[3]?1:0);next={1:'',2:batter,3:r[1]||''}}
  else if(play==='1B'){scored=r[3]?1:0;next={1:batter,2:r[1]||'',3:r[2]||''}}
  else if(play==='BB'||play==='E'){next={...r};if(r[1]&&r[2]&&r[3]){scored++;next[3]=''}if(r[1]&&r[2])next[3]=r[2];if(r[1])next[2]=r[1];next[1]=batter}
  addRuns(team,scored);setRunners(next);advanceBatter(team);const message=`${TEAM_NAME[team]} ${actionLabel(play)}${scored?`・${scored}得点`:''}`,walkoff=checkWalkoff();
  if(walkoff){resetPitchCount();syncOutUI();refreshBatterPosLabels();refreshRunnerOptions();scheduleUpdate()}
  else if(outs>=3)nextHalf();else{resetPitchCount();syncOutUI();refreshBatterPosLabels();refreshRunnerOptions();scheduleUpdate()}
  setLastAction(message);closeGameDock();
}
applyPlateResult=function(play){
  const matchup=rawMatchupPrediction();if(playNeedsRunnerChoice(play)){openRunnerAdvanceDialog(play,matchup);return}commitPlateResult(play,matchup);
};

function advanceRunner(base,steal=false){
  const team=battingTeam($('homeAway').value,half),id=baseRunners[base];if(!id){toast(`${base}塁に走者がいません`);return false}
  const next={1:baseRunners[1]||'',2:baseRunners[2]||'',3:baseRunners[3]||''},name=runnerLabel(team,id)||'走者';pushHistory();
  if(base===3){next[3]='';addRuns(team,1);setRunners(next);checkWalkoff();scheduleUpdate();setLastAction(`${name}が本塁へ進塁`);return true}
  if(next[base+1]){
    if(steal){history.pop();syncHistoryControls();toast(`${base+1}塁が埋まっています`);return false}
    [next[base],next[base+1]]=[next[base+1],next[base]];setRunners(next);scheduleUpdate();setLastAction(`${base}塁と${base+1}塁の走者を入れ替え`);return true;
  }
  next[base]='';next[base+1]=id;setRunners(next);scheduleUpdate();setLastAction(`${name}が${base+1}塁へ進塁`);return true;
}
function openSteal(base){
  const team=battingTeam($('homeAway').value,half),id=baseRunners[base];if(!id){toast(`${base}塁に走者がいません`);return}
  if(base<3&&baseRunners[base+1]){toast(`${base+1}塁が埋まっています`);return}
  stealBase=base;$('stealDialogText').textContent=`${runnerLabel(team,id)||'走者'}：${base}塁からの盗塁結果を選択`;$('stealDialog').showModal();
}
function completeSteal(success){
  const base=stealBase,team=battingTeam($('homeAway').value,half),id=baseRunners[base],runner=getPlayerById(team,id,'bat');$('stealDialog').close();if(!id)return;
  if(success){if(advanceRunner(base,true)){recordSteal(true,runner,team,base);setLastAction(`${runnerLabel(team,id)||'走者'}が盗塁成功`)}}
  else{pushHistory();const next={1:baseRunners[1]||'',2:baseRunners[2]||'',3:baseRunners[3]||''};next[base]='';setRunners(next);outs=Math.min(3,outs+1);recordSteal(false,runner,team,base);if(outs>=3)nextHalf();else{syncOutUI();scheduleUpdate()}setLastAction(`${runnerLabel(team,id)||'走者'}が盗塁死`)}
  stealBase=0;
}

function updateFieldState(){
  if(!$('currentBatterName'))return;const batting=battingTeam($('homeAway').value,half),fielding=fieldingTeam($('homeAway').value,half),batter=currentBatterFor(batting),pitcher=currentPitcherFor(fielding),order=currentPos(batting)%9+1,batterName=displayLineupName(batting,lineupIds(batting)[currentPos(batting)%9]),batterLabel=`${order}番 ${batterName}`,pitcherName=pitcher?displayName(pitcher):`${TEAM_NAME[fielding]} 投手平均`;
  $('currentBatterName').textContent=batterLabel;$('currentPitcherName').textContent=pitcherName;
  const runners=[1,2,3].filter(base=>baseRunners[base]).map(base=>`${base}塁 ${runnerLabel(batting,baseRunners[base])}`).join(' / ');
  $('fieldStateSummary').firstChild.textContent=`${batterLabel} vs ${pitcherName}｜${runners||'走者なし'}`;
  const multiplier=fatigueMultiplier(pitcher,fielding),load=currentPitchLoad(fielding,pitcher);$('pitcherFatigue').value=String(Math.min(110,Math.floor(load/10)*10));$('fatigueHint').textContent=multiplier>1?`被打撃リスク +${((multiplier-1)*100).toFixed(1)}%相当`:'疲労補正なし';syncGameDock();
}
function setLastAction(text){lastAction=text||'';if($('lastActionStatus'))$('lastActionStatus').textContent=`直前動作：${lastAction||'なし'}`;updateFieldState();saveGameState()}

const refreshBatterPosLabelsV09=refreshBatterPosLabels;
refreshBatterPosLabels=function(){refreshBatterPosLabelsV09();updateFieldState()};
const syncBaseUIV09=syncBaseUI;
syncBaseUI=function(){syncBaseUIV09();updateFieldState()};
const refreshPlayerUIV09=refreshPlayerUI;
refreshPlayerUI=function(){refreshPlayerUIV09();decorateSearchSelects();updateFieldState()};
const updateStatusV09=updateStatus;
updateStatus=function(){
  updateStatusV09();const count=Object.values(rosterSnapshot.rosters||{}).reduce((sum,players)=>sum+players.length,0),date=rosterSnapshot.snapshotDate?.replaceAll('-','/');
  if(statsSnapshot.bat?.length&&$('dataStatus'))$('dataStatus').innerHTML+=`<br><strong>公式個人成績 ${statsSnapshot.snapshotDate.replaceAll('-','/')}時点</strong>：野手 ${statsSnapshot.bat.length}人・投手 ${statsSnapshot.pit.length}人。左右・球場補正を含む静的スナップショット。`;
  if(count&&$('dataStatus'))$('dataStatus').innerHTML+=`<br>NPB現役支配下名簿 ${count}人（${date}確認）。未収録成績は球団平均。`;
};

const snapshotV09=snapshot;
function copiedOpponentLineups(){return Object.fromEntries(Object.entries(savedOpponentLineups||{}).map(([team,lineup])=>[team,Array.isArray(lineup)?[...lineup]:lineup]))}
snapshot=function(){return {...snapshotV09(),stealLearningLength:observedLearning?.steals?.length||0,opponent:$('opponent').value,homeAway:$('homeAway').value,ballpark:$('ballpark')?.value||'auto',pitchLoads:{...pitchLoads},pitcherUsageRoles:{...pitcherUsageRoles},lastAction,fieldOpen:$('fieldStateDetails').open,gameEnded,gameEndReason,savedOpponentLineups:copiedOpponentLineups()}};
const restoreSnapshotV09=restoreSnapshot;
restoreSnapshot=function(state){
  if(state.savedOpponentLineups&&typeof state.savedOpponentLineups==='object'){savedOpponentLineups=Object.fromEntries(Object.entries(state.savedOpponentLineups).map(([team,lineup])=>[team,Array.isArray(lineup)?[...lineup]:lineup]));persistOpponentLineups()}
  if(state.opponent&&state.opponent!==$('opponent').value){$('opponent').value=state.opponent;refreshPlayerUI()}
  if(state.homeAway)$('homeAway').value=state.homeAway;if(state.ballpark&&$('ballpark'))$('ballpark').value=state.ballpark;pitchLoads={...(state.pitchLoads||pitchLoads)};pitcherUsageRoles={...(state.pitcherUsageRoles||pitcherUsageRoles)};gameEnded=Boolean(state.gameEnded);gameEndReason=state.gameEndReason||'';restoreSnapshotV09(state);
  if(Number.isInteger(state.stealLearningLength)&&observedLearning?.steals?.length>state.stealLearningLength){observedLearning.steals=observedLearning.steals.slice(0,state.stealLearningLength);saveObservedLearning()}
  if(typeof state.fieldOpen==='boolean')$('fieldStateDetails').open=state.fieldOpen;setLastAction(state.lastAction||'');if(gameEnded)setTimeout(showGameResult,0);else closeGameResult()
};
function historyStateKey(state){
  if(!state)return'';const comparable={...state};delete comparable.lastAction;delete comparable.fieldOpen;return JSON.stringify(comparable);
}
function syncHistoryControls(){$('undoBtn').disabled=!history.length;$('redoBtn').disabled=!redoHistory.length}
function appendHistoryState(state,clearRedo=true){
  if(!state)return;const key=historyStateKey(state);if(!history.length||historyStateKey(history.at(-1))!==key){history.push(state);if(history.length>40)history.shift()}
  if(clearRedo)redoHistory=[];syncHistoryControls();
}
function resumeFinishedGameForEdit(){if(gameEnded&&!$('gameResultDialog').open){gameEnded=false;gameEndReason=''}}
pushHistory=function(){appendHistoryState(snapshot(),true);resumeFinishedGameForEdit()};
function observationTail(target){
  return {entries:(observedLearning?.entries||[]).slice(Number(target.learningLength)||0),steals:(observedLearning?.steals||[]).slice(Number(target.stealLearningLength)||0)};
}
function restoreObservationTail(target,tail){
  if(!observedLearning)return;const entryLength=Number(target.learningLength)||0,stealLength=Number(target.stealLearningLength)||0;
  if(observedLearning.entries.length<entryLength)observedLearning.entries.push(...(tail.entries||[]).slice(0,entryLength-observedLearning.entries.length));
  if(observedLearning.steals.length<stealLength)observedLearning.steals.push(...(tail.steals||[]).slice(0,stealLength-observedLearning.steals.length));
  saveObservedLearning();
}
undoLast=function(){
  if(!history.length)return;const current=snapshot(),currentKey=historyStateKey(current);let target=null;
  while(history.length){const candidate=history.pop();if(historyStateKey(candidate)!==currentKey){target=candidate;break}}
  if(!target){syncHistoryControls();return}
  redoHistory.push({state:current,tail:observationTail(target)});restoreSnapshot(target);setLastAction('直前の操作を取り消しました');syncHistoryControls();
};
function redoLast(){
  const entry=redoHistory.pop();if(!entry){syncHistoryControls();return}appendHistoryState(snapshot(),false);restoreSnapshot(entry.state);restoreObservationTail(entry.state,entry.tail);setLastAction('取り消した操作をやり直しました');syncHistoryControls();scheduleUpdate();
}
function captureControlHistory(control){pendingControlHistory.set(control,snapshot());resumeFinishedGameForEdit()}
function commitControlHistory(control){
  const before=pendingControlHistory.get(control);pendingControlHistory.delete(control);if(before&&historyStateKey(before)!==historyStateKey(snapshot()))appendHistoryState(before,true);
}
function setupStatefulControlHistory(){
  const selectIds=['opponent','homeAway','ballpark','inning','tigersBatterPos','oppBatterPos','tigersPitcher','oppPitcher','pitcherFatigue','runner1','runner2','runner3',...Array.from({length:9},(_,index)=>`tLine${index}`),...Array.from({length:9},(_,index)=>`oLine${index}`)];
  for(const id of selectIds){const control=$(id);if(!control)continue;control.addEventListener('focusin',()=>captureControlHistory(control));control.addEventListener('pointerdown',()=>captureControlHistory(control));control.addEventListener('keydown',()=>captureControlHistory(control));control.addEventListener('change',()=>commitControlHistory(control))}
  for(const id of ['tigersScore','oppScore']){const control=$(id);control.addEventListener('focusin',()=>captureControlHistory(control));control.addEventListener('pointerdown',()=>captureControlHistory(control));control.addEventListener('keydown',()=>captureControlHistory(control));control.addEventListener('change',()=>commitControlHistory(control))}
}
function saveGameState(){
  if(!$('opponent')?.value)return;clearTimeout(autosaveTimer);autosaveTimer=setTimeout(()=>{try{const state=snapshot();delete state.learningLength;delete state.stealLearningLength;localStorage.setItem(GAME_STORAGE,JSON.stringify({version:1,savedAt:Date.now(),state}))}catch(e){}},80);
}
function restoreGameState(){
  try{
    const saved=JSON.parse(localStorage.getItem(GAME_STORAGE)||'null'),state=saved?.state;if(saved?.version!==1||!state)return false;
    if(state.savedOpponentLineups&&typeof state.savedOpponentLineups==='object'){savedOpponentLineups=Object.fromEntries(Object.entries(state.savedOpponentLineups).map(([team,lineup])=>[team,Array.isArray(lineup)?[...lineup]:lineup]));persistOpponentLineups()}
    if(state.opponent&&[...$('opponent').options].some(option=>option.value===state.opponent))$('opponent').value=state.opponent;if(state.homeAway)$('homeAway').value=state.homeAway;if(state.ballpark&&$('ballpark'))$('ballpark').value=state.ballpark;refreshPlayerUI();
    half=state.half==='bottom'?'bottom':'top';outs=clamp(num(state.outs),0,2);balls=clamp(num(state.balls),0,3);strikes=clamp(num(state.strikes),0,2);baseRunners={1:state.baseRunners?.[1]||'',2:state.baseRunners?.[2]||'',3:state.baseRunners?.[3]||''};bases=[1,2,3].reduce((value,base)=>value|(baseRunners[base]?baseBit(base):0),0);
    $('inning').value=String(clamp(num(state.inning)||1,1,12));$('tigersScore').value=String(Math.max(0,num(state.tigersScore)));$('oppScore').value=String(Math.max(0,num(state.oppScore)));$('tigersBatterPos').value=String(clamp(num(state.tPos),0,8));$('oppBatterPos').value=String(clamp(num(state.oPos),0,8));
    (state.tLine||[]).forEach((id,index)=>{const select=$(`tLine${index}`);if(select&&[...select.options].some(option=>option.value===id))select.value=id});(state.oLine||[]).forEach((id,index)=>{const select=$(`oLine${index}`);if(select&&[...select.options].some(option=>option.value===id))select.value=id});
    if([...$('tigersPitcher').options].some(option=>option.value===state.tPitcher))$('tigersPitcher').value=state.tPitcher;if([...$('oppPitcher').options].some(option=>option.value===state.oPitcher))$('oppPitcher').value=state.oPitcher;
    pitchLoads={...(state.pitchLoads||{})};pitcherUsageRoles={...(state.pitcherUsageRoles||{})};lastAction=state.lastAction||'';gameEnded=Boolean(state.gameEnded);gameEndReason=state.gameEndReason||'';$('fieldStateDetails').open=state.fieldOpen!==false;$('topBtn').classList.toggle('active',half==='top');$('botBtn').classList.toggle('active',half==='bottom');refreshRunnerOptions();refreshSubstitutionUI();syncOutUI();syncCountUI();syncBaseUI();refreshBatterPosLabels();setLastAction(lastAction);if(gameEnded)setTimeout(showGameResult,0);return true;
  }catch(e){return false}
}
const scheduleUpdateV09=scheduleUpdate;
scheduleUpdate=function(){scheduleUpdateV09();updateFieldState();saveGameState()};

const applyPinchHitterV09=applyPinchHitter;
applyPinchHitter=function(){const before=$('substitutionStatus').textContent;applyPinchHitterV09();if($('substitutionStatus').textContent!==before){setLastAction($('substitutionStatus').textContent);closeGameDock()}};
const applyPinchRunnerV09=applyPinchRunner;
applyPinchRunner=function(){const before=$('substitutionStatus').textContent;applyPinchRunnerV09();if($('substitutionStatus').textContent!==before){setLastAction($('substitutionStatus').textContent);closeGameDock()}};
const applyReliefPitcherV09=applyReliefPitcher;
applyReliefPitcher=function(){
  const team=currentFieldingTeam(),selected=$('reliefPitcher').value,before=$('substitutionStatus').textContent;applyReliefPitcherV09();
  if($('substitutionStatus').textContent!==before){const player=getPlayerById(team,selected,'pit'),key=pitcherKey(team,player);pitcherUsageRoles[key]='relief';pitchLoads[key]=0;$('pitcherFatigue').value='0';setLastAction($('substitutionStatus').textContent);closeGameDock()}
};
document.querySelectorAll('.playBtn').forEach(button=>button.onclick=()=>applyPlateResult(button.dataset.play));
$('undoBtn').onclick=undoLast;$('redoBtn').onclick=redoLast;$('applyPinchHitter').onclick=applyPinchHitter;$('applyPinchRunner').onclick=applyPinchRunner;$('applyReliefPitcher').onclick=applyReliefPitcher;$('clearLearningBtn').onclick=clearObservedLearning;$('exportLearningBtn').onclick=exportObservedLearning;
document.querySelectorAll('[data-advance-runner]').forEach(button=>button.onclick=()=>advanceRunner(Number(button.dataset.advanceRunner)));
document.querySelectorAll('[data-steal-runner]').forEach(button=>button.onclick=()=>openSteal(Number(button.dataset.stealRunner)));
$('pitcherFatigue').addEventListener('change',event=>{const team=currentFieldingTeam(),player=currentPitcherFor(team);pitchLoads[pitcherKey(team,player)]=Number(event.target.value);setLastAction(`${displayName(player)||TEAM_NAME[team]+'投手平均'}の投球数を${event.target.selectedOptions[0].textContent}に変更`);scheduleUpdate();closeGameDock()});
$('ballpark')?.addEventListener('change',()=>{const park=currentParkInfo();setLastAction(`球場を${park.name}に変更`);scheduleUpdate();closeGameDock()});
$('fieldStateDetails').addEventListener('toggle',saveGameState);
for(const id of ['tigersPitcher','oppPitcher'])$(id).addEventListener('change',()=>{const team=id==='tigersPitcher'?TEAM_T:$('opponent').value,player=currentPitcherFor(team),key=pitcherKey(team,player);if(pitchLoads[key]===undefined)pitchLoads[key]=0;updateFieldState();setLastAction(`${TEAM_NAME[team]}の投手を${displayName(player)||'投手平均'}に変更`)});
for(const base of [1,2,3])$('runner'+base).addEventListener('change',()=>setLastAction(`${base}塁走者を${runnerLabel(battingTeam($('homeAway').value,half),baseRunners[base])||'なし'}に変更`));
document.querySelectorAll('.outBtn').forEach(button=>button.addEventListener('click',()=>setLastAction(`アウトを${outs}に変更`)));
document.querySelectorAll('.ballBtn').forEach(button=>button.addEventListener('click',()=>setLastAction(`ボールカウントを${balls}に変更`)));
document.querySelectorAll('.strikeBtn').forEach(button=>button.addEventListener('click',()=>setLastAction(`ストライクカウントを${strikes}に変更`)));
for(const base of [1,2,3])$('b'+base).addEventListener('click',()=>setLastAction(`${base}塁走者を${baseRunners[base]?'設定':'解除'}`));
$('nextHalf').addEventListener('click',()=>setLastAction('次の半回へ移動'));
$('topBtn').addEventListener('click',()=>setLastAction('表の攻撃へ変更'));
$('botBtn').addEventListener('click',()=>setLastAction('裏の攻撃へ変更'));
$('opponent').addEventListener('change',()=>setLastAction(`対戦相手を${TEAM_NAME[$('opponent').value]}に変更`));
['tigersScore','oppScore','inning','homeAway','tigersBatterPos','oppBatterPos'].forEach(id=>$(id).addEventListener('change',()=>{setLastAction(`${$(id).previousElementSibling?.textContent||'試合状態'}を変更`);scheduleUpdate()}));
const clearOpponentLineupV10=clearOpponentLineup;$('clearOpponentLineup').onclick=()=>{pushHistory();clearOpponentLineupV10();setLastAction(`${TEAM_NAME[$('opponent').value]}の保存打順を初期化`)};
setupStatefulControlHistory();
['tigersScore','oppScore'].forEach(id=>$(id).addEventListener('change',()=>{if(checkWalkoff())setLastAction('サヨナラで試合終了')}));
$('nextHalf').addEventListener('click',()=>{if(gameEnded)setLastAction('試合終了')});
document.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;button.classList.remove('pressedFeedback');void button.offsetWidth;button.classList.add('pressedFeedback');setTimeout(()=>button.classList.remove('pressedFeedback'),240)});
window.addEventListener('pagehide',()=>{try{const state=snapshot();delete state.learningLength;delete state.stealLearningLength;localStorage.setItem(GAME_STORAGE,JSON.stringify({version:1,savedAt:Date.now(),state}))}catch(e){}});

const footer=document.querySelector('footer');if(footer){const note=document.createElement('div');note.className='rosterSourceNote';note.innerHTML=`公式個人成績：<a href="https://npb.jp/bis/2026/stats/" target="_blank" rel="noopener noreferrer">NPB.jp 2026個人成績</a>（${statsSnapshot.snapshotDate?.replaceAll('-','/')}時点）の静的スナップショット。通常更新は前回基準日以降の<a href="https://npb.jp/bis/2026/games/" target="_blank" rel="noopener noreferrer">公式試合結果</a>だけを試合ID単位で追加し、ページ表示時の外部通信は行いません。<br>現役支配下選手名：<a href="https://npb.jp/bis/players/active/index.html" target="_blank" rel="noopener noreferrer">NPB.jp 現役選手一覧</a>。未収録の個人成績は同球団平均を使用。<br>左右補正：NPB公式の投打情報と<a href="https://www.mlb.com/news/takeaways-from-first-half-of-2026-season" target="_blank" rel="noopener noreferrer">MLB公式の2025左右別wOBA公開集計</a>を50%に縮約。球場補正：2024年以降のNPB公式試合結果を180試合分リーグ平均へ縮約し最大±3%。<br>投手疲労補正：<a href="https://www.mlb.com/glossary/standard-stats/number-of-pitches" target="_blank" rel="noopener noreferrer">MLB Pitch Count</a>、<a href="https://www.mlb.com/glossary/miscellaneous/third-time-through-the-order-penalty" target="_blank" rel="noopener noreferrer">Third Time Through the Order Penalty</a>を基にした保守的な役割別段階補正。`;footer.appendChild(note)}

refreshPlayerUI();decorateSearchSelects();updateStatus();restoreGameState();updateLearningUI();updateFieldState();update();
})();
