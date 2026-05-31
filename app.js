
/* ============================================================
   STATE SCHEMA
============================================================ */
const CURRENT_YEAR = new Date().getFullYear();
const APP_VERSION = '0.0.1';

let S = {
  version: APP_VERSION,
  // Core
  members: [],      // {id,name,levelId,groupId,type:'regular'|'visitor',year,comment,totalGames,sessions:[{date,games}],lastDate,status:'active'|'resting'|'tired',createdAt}
  levels:  [],      // {id,name,color,order} — user-configurable
  groups:  [],      // {id,name,color,order}
  // Today
  todayParticipants: [], // member ids participating today
  todayDate: null,
  // Courts
  courts: [],       // {id,players:[id,id,id,id]|null,confirmed:false}
  history: [],      // snapshots
  nextId: 1,
  // Sessions (game history)
  sessions: [],     // {id,date,participants:[id],results:[{memberId,games}],totalGames}
  // Settings
  settings: {
    courtCount: 3,
    levelMatch: true,
    consecLimit: false,
    consecMax: 2,
    waitPriority: true,
    courtLevels: {},    // courtId -> levelId|'any'
    levelConsec: {},    // levelId -> {enabled:bool, maxGames:int, intervalMin:int}
    faceThresholds: [   // sorted desc by games — face shown when games >= val
      {face:'😵', label:'限界',   games:10},
      {face:'😓', label:'疲れ',   games:7},
      {face:'😤', label:'元気',   games:4},
      {face:'😊', label:'普通',   games:1},
      {face:'😴', label:'未出場', games:0}
    ]
  },
  // Admin
  adminIds: [],      // member ids with admin rights
  drawOfficerId: null, // 抽選担当メンバーID
  // View state
  memberSort: 'group',
  memberYear: CURRENT_YEAR,
  swapMode: {active:false, source:null}
};

/* ============================================================
   PERSISTENCE
============================================================ */
const STORAGE_KEY = 'bm_v2_state';
const GLOBAL_KEY = 'bm_v2_global';

const FB_URL = 'https://tachibana-badminton-default-rtdb.asia-southeast1.firebasedatabase.app';
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAb4b6mROJcdAJCiIqV7TKfNC9zL-tq63M",
  authDomain: "tachibana-badminton.firebaseapp.com",
  databaseURL: "https://tachibana-badminton-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "tachibana-badminton",
  storageBucket: "tachibana-badminton.firebasestorage.app",
  messagingSenderId: "861101115493",
  appId: "1:861101115493:web:2ced9c26330499bd90de8c"
};
const FB_PATH = 'projects/';

var fbApp=null, fbDb=null, fbRef=null, fbConnected=false;
var fbSyncTimer=null, fbLastPush=0;
var fbGlobalTs=0; // last received Firebase global _ts

function fbInit(){
  try{
    if(typeof firebase==='undefined'){ fbSetStatus('offline','SDKなし'); return; }
    if(!fbApp){
      // Check if already initialized (hot-reload guard)
      try{
        fbApp=firebase.app('tbadminton');
      }catch(e){
        fbApp=firebase.initializeApp(FIREBASE_CONFIG,'tbadminton');
      }
      fbDb=firebase.database(fbApp);
    }
    if(fbApp && fbApp.options && fbApp.options.apiKey){
      fbSetStatus('syncing','認証中...');
      var auth=firebase.auth(fbApp);
      auth.onAuthStateChanged(function(user){
        if(user){
          fbSetStatus('syncing','接続準備中...');
          startFbConnection();
        } else {
          auth.signInAnonymously()
            .then(function(){ /* anonymous auth started */ })
            .catch(function(e){ console.warn('FB auth:',e); fbSetStatus('offline','認証エラー'); });
        }
      });
    } else {
      fbSetStatus('syncing','認証未設定');
      startFbConnection();
    }
  }catch(e){ console.warn('Firebase init:',e); fbSetStatus('offline','初期化エラー'); }
}

function startFbConnection(){

  if(!fbApp||!fbDb) return;
  fbSetStatus('syncing','接続中...');
  firebase.database(fbApp).ref('.info/connected').on('value',function(snap){
    var wasConnected=fbConnected;
    fbConnected=snap.val()===true;
    if(fbConnected){
      fbSetStatus('online','接続済');
      if(!wasConnected) fbSubscribe();
    } else{
      fbSetStatus('offline','オフライン');
    }
  });
  setTimeout(function(){
    firebase.database(fbApp).ref('.info/serverTimeOffset').once('value')
      .then(function(){ if(!fbConnected){ fbConnected=true; fbSetStatus('online','接続済'); fbSubscribe(); } })
      .catch(function(e){ console.warn('FB connectivity test:',e); });
  },2000);
}
function fbSetStatus(state,text){
  var dot=document.getElementById('fb-dot');
  var txt=document.getElementById('fb-status-text');
  if(dot) dot.className='fb-dot '+state;
  if(txt) txt.textContent=text;
}
function fbGetPath(){
  var g=loadGlobal();
  var pid=g?g.currentId:'default';
  return FB_PATH+pid.replace(/[.$#\[\]]/g,'_');
}
function fbNormalizeData(d){
  if(!d)return d;
  function toArr(v,n){if(!v)return v;if(Array.isArray(v))return v;var a=new Array(n||4).fill(null);Object.keys(v).forEach(function(k){a[parseInt(k)]=v[k];});return a;}
  if(d.courts&&Array.isArray(d.courts))d.courts.forEach(function(c){if(c&&c.players!=null)c.players=toArr(c.players,4);});
  ['members','sessions','levels','groups','adminIds','todayParticipants'].forEach(function(k){if(d[k]&&!Array.isArray(d[k]))d[k]=Object.values(d[k])||[];});
  return d;
}
function fbApplyProjectData(d){
  if(!d)return;
  d=fbNormalizeData(d);
  var inTs=d._ts||0;
  if(inTs>0 && inTs===fbLastPush) return; // 自分のエコー除外
  if(isAdmin() && fbLastPush>0 && inTs>0 && inTs<fbLastPush) return; // 管理者は自分より古いデータ無視
  var syncFields=['members','courts','sessions','todayParticipants','todayDate',
                  'adminIds','levels','groups','settings','nextId'];
  syncFields.forEach(function(k){ if(d[k]!==undefined) S[k]=d[k]; });
  S._ts=inTs||Date.now();
  try{
    var slim=JSON.stringify(S);
    localStorage.setItem(STORAGE_KEY,slim);
    var gg=loadGlobal(); if(gg&&gg.currentId) localStorage.setItem(getProjectKey(gg.currentId),slim);
  }catch(ex){}
  if(document.getElementById('courts-container')) renderCourts();
  renderWaiting();
  if(currentTab==='history') renderHistory();
  if(currentTab==='today'){ renderToday(); renderTodayRanking(); }
  if(currentTab==='member') renderMembers();
  updateCurrentProjectBadge();
  renderDrawOfficerBadge();
  fbSetStatus('online','同期: '+fbAgo(inTs));
  console.log('[FB] project synced ts='+inTs);
}
function fbApplyGlobal(d){
  if(!d||!d.projects||!Array.isArray(d.projects)) return;
  var inTs=d._ts||0;
  // 自分のエコー除外
  if(inTs>0 && inTs===fbLastPush) return;
  // 既に受信済みの新しいglobalより古いデータは無視
  // fbGlobalTs は自分が書き込んだ時刻も含む最高値
  if(inTs>0 && inTs<fbGlobalTs) {
    console.log('[FB] global rejected (old): inTs='+inTs+' < fbGlobalTs='+fbGlobalTs);
    return;
  }
  var g=loadGlobal()||{projects:[],currentId:null};
  var localCurrent=g.currentId;
  // プロジェクト数が減っている場合は慎重に扱う（削除操作かどうか確認）
  if(d.projects.length < g.projects.length && inTs <= fbGlobalTs){
    console.log('[FB] global rejected (fewer projects without newer ts)');
    return;
  }
  fbGlobalTs=inTs; // 更新
  g.projects=d.projects; g._ts=inTs;
  if(!g.projects.find(function(p){return p.id===localCurrent;})){
    g.currentId=d.currentId||(g.projects[0]?g.projects[0].id:null);
    saveGlobal(g);
    if(g.currentId) switchProject(g.currentId);
  } else {
    saveGlobal(g); updateCurrentProjectBadge(); updateHeaderProjectNav();
  }
  // If club code is set remotely and this client hasn't entered it, force code-entry overlay
  try{
    var remoteCode=getClubCode();
    if(remoteCode && !hasValidCode()){
      setTimeout(function(){ try{ closeAllModals(); showCodeEntry(); }catch(e){} },50);
    }
  }catch(e){}
  console.log('[FB] global applied, projects='+d.projects.length+' ts='+inTs);
}

function fbSubscribe(){
  if(fbRef){ try{fbRef.off();}catch(e){} }
  fbListenCommands(); // コマンドチャンネルも監視
  var db=firebase.database(fbApp);
  // Listen to current project data
  fbRef=db.ref(fbGetPath());
  fbRef.on('value',function(snap){ fbApplyProjectData(snap.val()); },
    function(e){ console.warn('FB project listen:',e); fbSetStatus('offline', e && e.code==='permission_denied' ? '権限不足' : '読取エラー'); });
  // Listen to global project list
  db.ref('global').on('value',function(snap){ fbApplyGlobal(snap.val()); },
    function(e){ console.warn('FB global listen:',e); fbSetStatus('offline', e && e.code==='permission_denied' ? '権限不足' : '読取エラー'); });
}
function fbPush(includeGlobal){
  if(!isAdmin()) return; // 管理者のみ書き込み
  if(!fbConnected||!fbDb) return;
  clearTimeout(fbSyncTimer);
  fbSyncTimer=setTimeout(function(){
    try{
      var ts=Date.now(); fbLastPush=ts;
      var db=firebase.database(fbApp);
      var updates={};
      // 1. Push current project's full data
      var path=fbGetPath();
      updates[path]={
        members:S.members, courts:S.courts, sessions:S.sessions,
        todayParticipants:S.todayParticipants, todayDate:S.todayDate,
        adminIds:S.adminIds, levels:S.levels, groups:S.groups,
        settings:S.settings, nextId:S.nextId, _ts:ts
      };
      // 2. Push global ONLY when explicitly requested (project create/delete)
      if(includeGlobal){
        var g=loadGlobal();
        if(g) updates['global']={projects:g.projects, currentId:g.currentId, _ts:ts};
      }
      db.ref('/').update(updates)
        .then(function(){ fbSetStatus('online','同期: '+fbAgo(ts)); })
        .catch(function(e){ console.warn('FB push:',e); fbSetStatus('offline','書込エラー'); });
    }catch(e){ console.warn('fbPush:',e); }
  },800);
}
function fbAgo(ts){
  if(!ts) return '';
  var s=Math.floor((Date.now()-ts)/1000);
  if(s<5) return 'たった今';
  if(s<60) return s+'秒前';
  return Math.floor(s/60)+'分前';
}
function fbResubscribe(){ if(fbConnected) fbSubscribe(); }

/* Firebase から global を非同期で読み込む */
function fbFetchGlobal(callback){
  if(!fbConnected||!fbDb){ if(callback)callback(null); return; }
  try{
    firebase.database(fbApp).ref('global').once('value',function(snap){
      var d=snap.val();
      if(d&&d.projects&&Array.isArray(d.projects)){ if(callback)callback(d); }
      else { if(callback)callback(null); }
    }).catch(function(e){ console.warn('fbFetchGlobal:',e); if(callback)callback(null); });
  }catch(e){ console.warn('fbFetchGlobal error:',e); if(callback)callback(null); }
}

function enforceClubCodeGuard(action){
  if(!hasValidCode()){
    if(!document.getElementById('code-overlay')){
      closeAllModals();
      showCodeEntry(function(ok){ if(ok && typeof action==='function'){ action(); }});
    }
    return false;
  }
  return true;
}

// Quick REST fetch for clubCode (useful in WebView like LINE where Firebase SDK may be slow)
function quickFetchClubCodeREST(timeoutMs, cb){
  try{
    var base = FIREBASE_CONFIG && FIREBASE_CONFIG.databaseURL ? FIREBASE_CONFIG.databaseURL.replace(/\/$/, '') : FB_URL.replace(/\/$/, '');
    var url = base + '/meta/clubCode.json';
    var ac = new AbortController();
    var to = setTimeout(function(){ ac.abort(); if(cb) cb(null); }, timeoutMs||1200);
    fetch(url, {method:'GET', signal:ac.signal}).then(function(res){ clearTimeout(to); if(!res.ok){ if(cb)cb(null); return; } return res.json(); })
      .then(function(data){ try{ if(data==null){ if(cb)cb(null); } else { if(cb)cb(String(data)); } }catch(e){ if(cb)cb(null); }}).catch(function(){ clearTimeout(to); if(cb)cb(null); });
  }catch(e){ if(cb)cb(null); }
}

function loadGlobal(){
  try{
    var r=localStorage.getItem(GLOBAL_KEY);
    if(!r) return null;
    var g=JSON.parse(r);
    // Validate structure
    if(!g.projects||!Array.isArray(g.projects)||!g.currentId) return null;
    return g;
  }catch(e){ return null; }
}
function saveGlobal(g){
  g._ts=Date.now(); // always update _ts so we know when we last touched it
  try{ localStorage.setItem(GLOBAL_KEY,JSON.stringify(g)); }catch(e){}
}
function getProjectKey(id){ return 'bm_proj_'+String(id); }
function getCurrentProject(){
  var g=loadGlobal(); if(!g) return null;
  return g.projects.find(function(p){return p.id===g.currentId;})||g.projects[0]||null;
}
function initProjects(){
  var g=loadGlobal();
  var hasLocal=(g && g.projects && g.projects.length>0);
  if(!hasLocal){
    // ローカルに global がない場合、Firebase からフェッチを試みる（同期的に待つ）
    // ただし、initProjects は同期的であるため、Firebase 待機は initWithFirebase で行う
    // ここでは「Firebase待機のためのフラグ」を立てて、Firebase初期化後に完了させる
    window._needsFirebaseGlobalFetch=true;
  }
  if(!g){
    // First run: 仮の global を作成（Firebase fetch 待機中）
    var fid='proj_'+Date.now();
    g={projects:[{id:fid,name:CURRENT_YEAR+'年度',createdAt:Date.now(),_tempNew:true}],currentId:fid};
    var ex=localStorage.getItem(STORAGE_KEY);
    try{ if(ex) JSON.parse(ex); else ex=null; }catch(e){ ex=null; }
    if(ex) localStorage.setItem(getProjectKey(fid),ex);
    saveGlobal(g);
  } else {
    // Ensure currentId project data is loaded into STORAGE_KEY
    var cur=localStorage.getItem(STORAGE_KEY);
    var projData=localStorage.getItem(getProjectKey(g.currentId));
    if(!cur && projData){
      try{ JSON.parse(projData); localStorage.setItem(STORAGE_KEY,projData); }catch(e){}
    }
  }
}
function initWithFirebaseGlobal(){
  if(!window._needsFirebaseGlobalFetch) return;
  window._needsFirebaseGlobalFetch=false;
  fbFetchGlobal(function(fbGlobal){
    if(!fbGlobal || !fbGlobal.projects || fbGlobal.projects.length===0){
      // Even if no global, try to fetch meta/clubCode so code-protection works
      try{
        if(fbConnected&&fbDb){
          firebase.database(fbApp).ref('meta/clubCode').once('value').then(function(snap){
            var code = snap.val()||''; var g = loadGlobal()||{projects:[],currentId:null};
            if(code && g.clubCode!==code){ g.clubCode = code; saveGlobal(g); updateClubCodeDisplay();
              try{ if(code && !hasValidCode()){ setTimeout(function(){ try{ closeAllModals(); showCodeEntry(); }catch(e){} },50); } }catch(e){}
            }
          }).catch(function(){});
        }
      }catch(ex){}
      return; // Firebase にも何もない
    }
    var localG=loadGlobal();
    if(localG && localG.projects[0] && localG.projects[0]._tempNew){
      // ローカルは仮作成、Firebase から新しいデータを取得
      fbGlobal._ts=fbGlobal._ts||Date.now();
      saveGlobal(fbGlobal);
      if(fbGlobal.currentId) switchProject(fbGlobal.currentId);
      console.log('[Init] Firebase global applied: '+fbGlobal.projects.length+' projects');
    }
    // Also try to fetch meta/clubCode so we can enforce code entry immediately
    try{
      if(fbConnected&&fbDb){
        firebase.database(fbApp).ref('meta/clubCode').once('value').then(function(snap){
          var code = snap.val()||''; var g2 = loadGlobal()||{projects:[],currentId:null};
          if(code && g2.clubCode!==code){ g2.clubCode = code; saveGlobal(g2); updateClubCodeDisplay();
            try{ if(code && !hasValidCode()){ setTimeout(function(){ try{ closeAllModals(); showCodeEntry(); }catch(e){} },50); } }catch(e){}
          }
        }).catch(function(){});
      }
    }catch(ex){}
  });
}
function switchProjectAndClose(id){ closeModal('modal-project'); switchProject(id); }
function switchProject(id){
  var g=loadGlobal(); if(!g) return;
  save(); // save current project first
  g.currentId=id; g._ts=Date.now(); saveGlobal(g);
  var pd=localStorage.getItem(getProjectKey(id));
  try{
    if(pd){
      var parsed=JSON.parse(pd);
      // Update _ts to "now" so incoming Firebase data (which may be old) doesn't overwrite
      parsed._ts=Date.now();
      var pdStr=JSON.stringify(parsed);
      localStorage.setItem(STORAGE_KEY,pdStr);
      localStorage.setItem(getProjectKey(id),pdStr);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }catch(e){
    localStorage.removeItem(STORAGE_KEY);
    toast('プロジェクトデータが壊れています。新規状態で開始します。');
  }
  var blank={version:APP_VERSION,members:[],levels:defaultLevels(),groups:defaultGroups(),todayParticipants:[],todayDate:null,courts:[],history:[],nextId:1,sessions:[],settings:{courtCount:2,levelMatch:false,consecLimit:false,consecMax:2,waitPriority:true,courtLevels:{},levelConsec:{},faceThresholds:defaultFaces()},memberSort:'group',memberYear:CURRENT_YEAR,swapMode:{active:false,source:null}};
  Object.assign(S,blank); load();
  if(!S.levels||!S.levels.length) S.levels=defaultLevels();
  if(!S.groups||!S.groups.length) S.groups=defaultGroups();
  if(!S.settings.faceThresholds||!S.settings.faceThresholds.length) S.settings.faceThresholds=defaultFaces();
  if(!S.settings.levelConsec) S.settings.levelConsec={};
  if(!S.settings.courtLevels) S.settings.courtLevels={};
  if(!S.swapMode) S.swapMode={active:false,source:null};
  closeAllModals();
  currentTab='court';
  ['court','today','member','history','data'].forEach(function(t){
    document.getElementById('pane-'+t).classList.toggle('active',t==='court');
    document.getElementById('tab-'+t).classList.toggle('active',t==='court');
  });
  syncCourts(); renderAll();
  var p=getCurrentProject();
  toast('プロジェクトを切り替えました: '+(p?p.name:''));
  setTimeout(function(){ if(hasValidCode()) checkFirstTimeIdentity(); },400);
  fbResubscribe(); // Firebaseリスナーを切替
  // Push the new global state immediately
  setTimeout(fbPush,500);
}
function updateCurrentProjectBadge(){
  var p=getCurrentProject();
  var el=document.getElementById('current-project-name');
  if(el) el.textContent=p?p.name:'(なし)';
  updateHeaderProjectNav();
  applyAdminUI();
}
function createNewProject(){
  if(!requireAdmin()) return;
  var name=document.getElementById('new-proj-name').value.trim();
  if(!name){ toast('プロジェクト名を入力してください'); return; }
  var opt=document.querySelector('input[name="proj-member-opt"]:checked');
  var inherit=(opt?opt.value:'inherit')==='inherit';
  save();
  var g=loadGlobal()||{projects:[],currentId:null};
  var nid='proj_'+Date.now();
  g.projects.push({id:nid,name:name,createdAt:Date.now()});
  // Deep copy members only (reset all game stats for complete isolation)
  var newMembers=[];
  if(inherit){
    newMembers=JSON.parse(JSON.stringify(S.members)).map(function(m){
      return {
        id:m.id, name:m.name, levelId:m.levelId, groupId:m.groupId,
        type:m.type, year:m.year, comment:m.comment||'',
        totalGames:0, consecutiveGames:0, todayGames:0,
        lastDate:null, lastWaitStart:Date.now(),
        status:'active', lastGameEndTime:null, lastGameStartTime:null,
        pin:m.pin||null, createdAt:m.createdAt||Date.now()
      };
    });
  }
  var ns={
    version:APP_VERSION,
    members:newMembers,
    levels:JSON.parse(JSON.stringify(S.levels)),
    groups:JSON.parse(JSON.stringify(S.groups)),
    settings:JSON.parse(JSON.stringify(S.settings)),
    courts:[], sessions:[], todayParticipants:[], todayDate:null,
    history:[], nextId:S.nextId, adminIds:JSON.parse(JSON.stringify(S.adminIds||[])),
    memberSort:S.memberSort, memberYear:CURRENT_YEAR,
    swapMode:{active:false,source:null}, _ts:0
  };
  document.getElementById('new-proj-name').value='';
  closeAllModals();
  g.currentId=nid; saveGlobal(g);
  ns._ts = Date.now(); // mark timestamp to prevent old Firebase data overwriting
  S._ts = ns._ts; // also update active state timestamp
  localStorage.setItem(getProjectKey(nid), JSON.stringify(ns)); // save again with _ts
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ns)); // also update active slot
  Object.assign(S, ns); syncCourts();
  // Firebase: switch listener to new project path BEFORE pushing
  fbResubscribe();
  // globalも含めて即時プッシュ（管理者チェックをバイパスして直接送信）
  clearTimeout(fbSyncTimer);
  if(fbConnected && fbDb){
    var newTs=Date.now(); fbLastPush=newTs; fbGlobalTs=newTs;
    var g2=loadGlobal();
    var updates={};
    updates[fbGetPath()]={
      members:S.members, courts:[], sessions:[], adminIds:S.adminIds||[],
      levels:S.levels, groups:S.groups, settings:S.settings,
      todayParticipants:[], todayDate:null, nextId:S.nextId, _ts:newTs
    };
    if(g2) updates['global']={projects:g2.projects, currentId:g2.currentId, _ts:newTs};
    firebase.database(fbApp).ref('/').update(updates)
      .then(function(){ fbSetStatus('online','新プロジェクト同期完了'); })
      .catch(function(e){ console.warn('New project push failed:',e); fbSetStatus('offline','書込エラー'); });
  } else {
    fbPush(true); // Firebase未接続時は通常のキュー経由
  }
  // タブをコートに戻してレンダリング
  currentTab='court';
  ['court','today','member','history','data'].forEach(function(t){
    document.getElementById('pane-'+t).classList.toggle('active',t==='court');
    document.getElementById('tab-'+t).classList.toggle('active',t==='court');
  });
  renderAll();
  // fbLastPush is for project data echo, not global - no need to reset
  toast('新しいプロジェクト「'+name+'」を開始しました');
}
function renameProject(id){
  var g=loadGlobal(); if(!g) return;
  var p=g.projects.find(function(x){return x.id===id;}); if(!p) return;
  var row=document.getElementById('prow-'+id); if(!row) return;
  var sid="'"+id+"'";
  row.innerHTML='<input class="field sm" id="prename-'+id+'" value="'+escH(p.name)+'" style="flex:1">'
    +'<button class="btn primary xs" onclick="saveProjectRename('+sid+')">保存</button>'
    +'<button class="btn ghost xs" onclick="renderProjectList()">✕</button>';
}
function saveProjectRename(id){
  var g=loadGlobal(); if(!g) return;
  var p=g.projects.find(function(x){return x.id===id;}); if(!p) return;
  var inp=document.getElementById('prename-'+id);
  var val=inp?inp.value.trim():''; if(!val){ toast('名前を入力してください'); return; }
  p.name=val; p._ts=Date.now(); g._ts=Date.now(); fbGlobalTs=Date.now();
  saveGlobal(g);
  // Push updated global to Firebase
  if(fbConnected&&fbDb){
    var ts=Date.now(); fbLastPush=ts;
    firebase.database(fbApp).ref('global').set({projects:g.projects,currentId:g.currentId,_ts:ts});
  }
  renderProjectList(); updateCurrentProjectBadge(); updateHeaderProjectNav();
  toast('プロジェクト名を変更しました');
}
function deleteProject(id){
  var g=loadGlobal(); if(!g) return;
  if(g.projects.length<=1){ toast('最後のプロジェクトは削除できません'); return; }
  var p=g.projects.find(function(x){return x.id===id;});
  var pname=p?p.name:'このプロジェクト';
  confirmDialog('プロジェクト削除',
    '【削除前にエクスポートをおすすめします】\n\n'
    +'「'+pname+'」のメンバー・練習日データが完全に消えます。\n'
    +'データ画面からエクスポートしましたか？\n\n'
    +'※ 削除はFirebase経由で全端末に即時反映されます。',
    function(){
      // 1. Remove from localStorage
      localStorage.removeItem(getProjectKey(id));
      // 2. Remove from global
      g.projects=g.projects.filter(function(x){return x.id!==id;});
      // 3. Write deletion marker to Firebase so ALL devices sync
      if(fbConnected&&fbDb){
        var delTs=Date.now(); fbLastPush=delTs; fbGlobalTs=delTs;
        var updates={};
        updates['global']={projects:g.projects, currentId:g.currentId, _ts:delTs};
        updates[FB_PATH+id.replace(/[.$#\[\]]/g,'_')]=null;
        firebase.database(fbApp).ref('/').update(updates)
          .then(function(){fbSetStatus('online','削除完了');})
          .catch(function(e){console.warn('delete:',e);});
      }
      if(g.currentId===id){
        g.currentId=g.projects[0]?g.projects[0].id:null;
        saveGlobal(g);
        if(g.currentId) switchProject(g.currentId);
      } else {
        saveGlobal(g);
        renderProjectList();
        renderAll();
      }
    },'削除','danger');
}
function renderProjectList(){
  var g=loadGlobal();
  if(!g||!g.projects.length){
    document.getElementById('project-list-area').innerHTML='<div style="color:var(--text3);font-size:12px">プロジェクトなし</div>';
    return;
  }
  var html=g.projects.map(function(p){
    var isCurrent=(p.id===g.currentId);
    var d=new Date(p.createdAt);
    var ds=d.getFullYear()+'/'+(d.getMonth()+1)+'/'+d.getDate();
    var sid="'"+p.id+"'";
    var switchBtn=!isCurrent?('<button class="btn primary xs" onclick="switchProjectAndClose('+sid+')">切替</button>'):'';
    var adminBtns=isAdmin()?(
      '<button class="btn ghost xs" onclick="renameProject('+sid+')">編集</button>'
      +(g.projects.length>1?'<button class="btn danger xs" onclick="deleteProject('+sid+')">削除</button>':'')
    ):'';
    return '<div class="lvl-list-item" id="prow-'+p.id+'">'
      +(isCurrent?'<span style="font-size:10px;background:var(--accent-a);color:var(--accent);border:1px solid var(--accent);border-radius:3px;padding:1px 5px;flex-shrink:0;margin-right:4px">現在</span>':'')
      +'<div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:600">'+escH(p.name)+'</div>'
      +'<div style="font-size:10px;color:var(--text3)">作成: '+ds+'</div></div>'
      +switchBtn+adminBtns
      +'</div>';
  }).join('');
  document.getElementById('project-list-area').innerHTML=html;
}
function save(){
  try{
    var data=JSON.stringify(S);
    localStorage.setItem(STORAGE_KEY,data);
    var g=loadGlobal(); if(g&&g.currentId){
      var slim=Object.assign({},S,{history:[]});
      localStorage.setItem(getProjectKey(g.currentId),JSON.stringify(slim));
    }
  }catch(e){ toast('保存エラー: '+e.message); }
  if(typeof isAdmin==='function'&&isAdmin()) fbPush(false);
}
function load(){
  const raw = localStorage.getItem(STORAGE_KEY);
  if(!raw) return;
  try{
    const loaded = JSON.parse(raw);
    // Deep-merge settings so new keys from updates are preserved
    const mergedSettings = Object.assign({}, S.settings, loaded.settings||{});
    S = Object.assign({}, S, loaded);
    S.settings = mergedSettings;
    // Ensure all required fields exist
    if(!S.levels||!S.levels.length) S.levels = defaultLevels();
    if(!S.groups||!S.groups.length) S.groups = defaultGroups();
    if(!S.sessions) S.sessions = [];
    if(!S.todayParticipants) S.todayParticipants = [];
    if(!S.courts) S.courts = [];
    if(!S.history) S.history = [];
    if(!S.settings.faceThresholds||!S.settings.faceThresholds.length) S.settings.faceThresholds = defaultFaces();
    if(!S.settings.levelConsec) S.settings.levelConsec = {};
    if(!S.settings.courtLevels) S.settings.courtLevels = {};
    if(!S.swapMode) S.swapMode = {active:false, source:null};
    if(typeof S.settings.courtCount !== 'number') S.settings.courtCount = 2;
  }catch(e){ console.error('load error:', e); }
}

function defaultLevels(){
  return [
    {id:1, name:'強：ガンガンいこうぜ', shortName:'強', color:'#ff1744', order:2},
    {id:2, name:'普：みんながんばれ',   shortName:'普', color:'#00d4ff', order:1},
    {id:3, name:'緩：いのちだいじに',   shortName:'緩', color:'#00e676', order:0}
  ];
}
function defaultGroups(){
  return [
    {id:1, name:'正規メンバー', color:'#00d4ff', order:0},
    {id:2, name:'ビジター',     color:'#d500f9', order:1}
  ];
}
function defaultFaces(){
  return [
    {face:'😵', label:'限界',   games:10},
    {face:'😓', label:'疲れ',   games:7},
    {face:'😤', label:'頑張り', games:4},
    {face:'😊', label:'普通',   games:1},
    {face:'😴', label:'未出場', games:0}
  ];
}

/* ============================================================
   INIT
============================================================ */
function doInit(){
  hideStartupOverlay();
  load();
  if(!S.levels||!S.levels.length)S.levels=defaultLevels();
  if(!S.groups||!S.groups.length)S.groups=defaultGroups();
  if(!S.settings.faceThresholds||!S.settings.faceThresholds.length)S.settings.faceThresholds=defaultFaces();
  if(!S.settings.levelConsec)S.settings.levelConsec={};
  // adminIds が空（未セットアップ）の場合、初回セットアップをガイド
  if(!S.adminIds||S.adminIds.length===0){
    window._allowOpenMode=true; // 初回セットアップ時のみ全員操作可
  }
  syncCourts();checkDateChange();updateHeaderDate();
  setInterval(updateHeaderDate,60000);setInterval(checkDateChange,60000);
  ['rest-section-hd','rest-note','tired-section-hd','tired-note'].forEach(function(id){
    var el=document.getElementById(id);if(el)el.style.display='none';
  });
  renderAll();applyAdminUI();updateHeaderProjectNav();
  if(hasValidCode()){ checkFirstTimeIdentity(); }
  setTimeout(fbSyncClubCode,3000);
  // 初回セットアップが必要な場合、管理者設定画面を自動オープン
  if(!S.adminIds||S.adminIds.length===0){
    setTimeout(function(){
      var me=getMyMember();
      if(me){
        setTimeout(function(){ openAdminModal(); },300);
      }
    },500);
  }
}
function init(){
  initProjects();
  fbInit();
  showStartupOverlay('入室コードを確認しています…');
  // If club code exists locally and not yet provided on this client, block initialization
  var earlyCode=getClubCode();
  if(earlyCode && !hasValidCode()){
    window._pendingInit=true; // prevent other prompts
    closeAllModals();
    showCodeEntry(function(ok){ window._pendingInit=false; if(ok) doInit(); });
    return;
  }

  if(!earlyCode){
    window._clubCodeCheckPending=true;
    var finishInit=function(){
      window._clubCodeCheckPending=false;
      var code=getClubCode();
      if(code && !hasValidCode()){
        window._pendingInit=true;
        showCodeEntry(function(ok){ window._pendingInit=false; if(ok) doInit(); });
      } else {
        doInit();
      }
    };

    quickFetchClubCodeREST(1200, function(code){
      try{
        if(code){
          var g = loadGlobal()||{projects:[],currentId:null};
          if(g.clubCode!==code){ g.clubCode=code; saveGlobal(g); updateClubCodeDisplay(); }
          if(!hasValidCode()){
            window._pendingInit=true;
            showCodeEntry(function(ok){ window._pendingInit=false; if(ok) doInit(); });
            return;
          }
        }
      }catch(e){}

      // Trigger Firebase global fetch if needed, but still wait a short time
      if(window._needsFirebaseGlobalFetch){
        initWithFirebaseGlobal();
      }
      var waited = 0;
      var waitInterval = setInterval(function(){
        var code2 = getClubCode();
        if((code2 && !hasValidCode()) || !window._needsFirebaseGlobalFetch || waited > 2000){
          clearInterval(waitInterval);
          finishInit();
        }
        waited += 250;
      },250);
    });
    return;
  }

  if(window._needsFirebaseGlobalFetch){
    initWithFirebaseGlobal();
    var waited = 0;
    var waitInterval = setInterval(function(){
      var code = getClubCode();
      if((code && !hasValidCode()) || !window._needsFirebaseGlobalFetch || waited > 2000){
        clearInterval(waitInterval);
        if(code && !hasValidCode()){
          window._pendingInit=true;
          showCodeEntry(function(ok){ window._pendingInit=false; if(ok) doInit(); });
        } else {
          doInit();
        }
      }
      waited += 250;
    },250);
  } else {
    var code = getClubCode();
    if(code && !hasValidCode()){
      window._pendingInit=true;
      showCodeEntry(function(ok){ window._pendingInit=false; if(ok) doInit(); });
    } else {
      doInit();
    }
  }
}
function checkDateChange(){
  var today=todayStr();
  if(S.todayDate && S.todayDate !== today){
    // 日付が変わった → セッション保存してリセット
    autoEndSession();
  }
  // セッション未開始でも前日のデータが残っている場合もリセット
  if(!S.todayDate && S.todayParticipants.length>0){
    var lastSess=S.sessions.length?S.sessions[S.sessions.length-1]:null;
    if(lastSess && lastSess.date !== today){
      autoResetDay();
    }
  }
}
function autoEndSession(){
  // 日付変更時: 前日のセッションを自動保存してリセット
  if(S.todayParticipants.length>0){
    var dateStr=S.todayDate||todayStr();
    var results=S.todayParticipants.map(function(id){
      var m=S.members.find(function(x){return x.id===id;});
      return {memberId:id, games:m?m.consecutiveGames:0};
    });
    // 重複保存防止: 同日データがなければ追加
    if(!S.sessions.find(function(s){return s.date===dateStr;})){
      S.sessions.push({id:S.nextId++, date:dateStr, participants:[...S.todayParticipants], results:results, totalGames:S.courts.filter(function(c){return c.confirmed;}).length});
    }
  }
  autoResetDay();
  toast('日付が変わりました。前日データを保存してリセットしました。');
}
function autoResetDay(){
  var today=todayStr();
  S.members.forEach(function(m){
    m.consecutiveGames=0; m.todayGames=0;
    m.lastWaitStart=Date.now();
    m.lastGameEndTime=null; m.lastGameStartTime=null;
    m.status='active';
    // lastDateを今日でなければそのまま、今日なら前回セッションの日付に戻す
    if(m.lastDate===today){
      var prevSess=S.sessions.slice().reverse().find(function(s){
        return s.date!==today && s.participants && s.participants.includes(m.id);
      });
      m.lastDate=prevSess?prevSess.date:null;
    }
  });
  S.courts.forEach(function(c){ c.players=null; c.confirmed=false; });
  S.todayParticipants=[]; S.todayDate=null;
  save();
}
function updateHeaderDate(){
  const d = new Date();
  const wd = ['日','月','火','水','木','金','土'][d.getDay()];
  document.getElementById('hdr-date').textContent =
    `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} (${wd})`;
}

/* ============================================================
   TABS
============================================================ */
let currentTab = 'court';
function switchTab(tab){
  if(!enforceClubCodeGuard(function(){ switchTab(tab); })) return;
  currentTab = tab;
  ['court','today','member','history','data'].forEach(t=>{
    document.getElementById('pane-'+t).classList.toggle('active', t===tab);
    document.getElementById('tab-'+t).classList.toggle('active', t===tab);
  });
  if(tab==='member')  renderMembers();
  if(tab==='history') renderHistory();
  if(tab==='data')    renderData();
  if(tab==='today')   { renderToday(); renderTodayRanking(); }
}

/* ============================================================
   LEVELS
============================================================ */
function getLevelById(id){
  var l=S.levels.find(function(l){return l.id===id;});
  if(!l) l=S.levels[0]||{id:0,name:'?',shortName:'?',color:'#888',order:99};
  if(!l.shortName) l.shortName=l.name.charAt(0);
  return l;
}
function getLevelShort(id){
  var l=getLevelById(id);
  return l.shortName||l.name.charAt(0);
}
function sortedLevels(){
  if(!S.levels||!S.levels.length) return [];
  return [...S.levels].sort(function(a,b){
    var ao=(a&&a.order!=null)?a.order:99;
    var bo=(b&&b.order!=null)?b.order:99;
    return ao-bo;
  });
}

function addLevel(){
  const name = document.getElementById('new-level-name').value.trim();
  const color = document.getElementById('new-level-color').value;
  if(!name){ toast('名前を入力してください'); return; }
  S.levels.push({id: S.nextId++, name, color, order: S.levels.length});
  document.getElementById('new-level-name').value='';
  save(); renderLevelsModal();
}
function deleteLevel(id){
  confirmDialog('レベルを削除', 'このレベルを削除しますか？このレベルのメンバーはデフォルトレベルになります。', ()=>{
    S.members.forEach(m=>{ if(m.levelId===id) m.levelId = S.levels.find(l=>l.id!==id)?.id||S.levels[0]?.id; });
    S.levels = S.levels.filter(l=>l.id!==id);
    save(); renderLevelsModal(); renderMembers();
  });
}
function renderLevelsModal(){
  const lvls = sortedLevels();
  document.getElementById('levels-list').innerHTML = lvls.map((l,i)=>`
    <div class="lvl-list-item" id="lvl-${l.id}" draggable="true" ondragstart="dragLvl(${l.id})" ondragover="dragOverLvl(event,${l.id})" ondrop="dropLvl(event,${l.id})">
      <span class="drag-handle">⠿</span>
      <div class="lvl-color-dot" style="background:${l.color}"></div>
      <span style="font-size:11px;font-weight:700;background:${l.color}22;color:${l.color};border:1px solid ${l.color};border-radius:4px;padding:1px 5px;flex-shrink:0">${escH(l.shortName||l.name.charAt(0))}</span>
      <span style="flex:1;font-size:13px;margin-left:4px">${escH(l.name)}</span>
      <span style="font-size:11px;color:var(--text3);margin-right:8px">${S.members.filter(m=>m.levelId===l.id).length}人</span>
      <button class="btn ghost xs" onclick="editLevelInline(${l.id})">編集</button>
      <button class="btn danger xs" onclick="deleteLevel(${l.id})">削除</button>
    </div>
  `).join('');
  initTouchDrag('levels-list');
}
let dragSrcLvl=null;
function initTouchDrag(listId){
  var list=document.getElementById(listId); if(!list) return;
  var dragEl=null;
  list.querySelectorAll('[draggable="true"]').forEach(function(item){
    item.addEventListener('touchstart',function(e){
      dragEl=item; dragEl.style.opacity='0.6';
    },{passive:true});
    item.addEventListener('touchmove',function(e){
      if(!dragEl) return; e.preventDefault();
      var ty=e.touches[0].clientY;
      Array.from(list.querySelectorAll('[draggable="true"]')).forEach(function(it){
        if(it===dragEl) return;
        var r=it.getBoundingClientRect();
        if(ty>r.top+r.height*0.5) it.after(dragEl); else if(ty<r.top+r.height*0.5) it.before(dragEl);
      });
    },{passive:false});
    item.addEventListener('touchend',function(){
      if(!dragEl) return; dragEl.style.opacity='1';
      var items=Array.from(list.querySelectorAll('[draggable="true"]'));
      if(listId==='levels-list'){
        items.forEach(function(el,i){ var l=S.levels.find(function(x){return x.id===parseInt(el.id.replace('lvl-',''));}); if(l) l.order=i; });
        save(); renderLevelsModal();
      } else {
        items.forEach(function(el,i){ var g=S.groups.find(function(x){return x.id===parseInt(el.id.replace('grp-',''));}); if(g) g.order=i; });
        save(); renderGroupsModal();
      }
      dragEl=null;
    },{passive:true});
  });
}
function dragLvl(id){dragSrcLvl=id;}
function dragOverLvl(e,id){e.preventDefault();}
function dropLvl(e,id){
  e.preventDefault();
  if(dragSrcLvl===id) return;
  const a=S.levels.find(l=>l.id===dragSrcLvl), b=S.levels.find(l=>l.id===id);
  if(!a||!b) return;
  [a.order,b.order]=[b.order,a.order];
  save(); renderLevelsModal();
}
function editLevelInline(id){
  const l = S.levels.find(x=>x.id===id);
  if(!l) return;
  const row = document.getElementById('lvl-'+id);
  row.innerHTML = `
    <span class="drag-handle">⠿</span>
    <input type="color" value="${l.color}" id="ec-${id}" style="width:30px;height:30px;border:1px solid var(--border);border-radius:5px;background:none;cursor:pointer;padding:2px;flex-shrink:0">
    <div style="display:flex;flex-direction:column;gap:4px;flex:1">
      <input class="field sm" value="${escH(l.name)}" id="en-${id}" placeholder="表示名（例: 強：ガンガンいこうぜ）">
      <input class="field sm" value="${escH(l.shortName||l.name.charAt(0))}" id="es-${id}" placeholder="短縮名1〜3文字（例: 強）" maxlength="3">
    </div>
    <button class="btn primary xs" onclick="saveLevelEdit(${id})" style="flex-shrink:0">保存</button>
    <button class="btn ghost xs" onclick="renderLevelsModal()" style="flex-shrink:0">✕</button>
  `;
}
function saveLevelEdit(id){
  const l=S.levels.find(x=>x.id===id); if(!l) return;
  l.name = document.getElementById('en-'+id).value.trim()||l.name;
  l.color = document.getElementById('ec-'+id).value;
  var short = document.getElementById('es-'+id).value.trim();
  l.shortName = short||l.name.charAt(0);
  save(); renderLevelsModal();
}

/* ============================================================
   GROUPS
============================================================ */
function getGroupById(id){ return S.groups.find(g=>g.id===id)||null; }
function sortedGroups(){ return [...S.groups].sort((a,b)=>a.order-b.order); }

function addGroup(){
  const name = document.getElementById('new-group-name').value.trim();
  const color = document.getElementById('new-group-color').value;
  if(!name){ toast('名前を入力してください'); return; }
  S.groups.push({id: S.nextId++, name, color, order: S.groups.length});
  document.getElementById('new-group-name').value='';
  save(); renderGroupsModal();
}
function deleteGroup(id){
  confirmDialog('グループを削除','このグループを削除しますか？メンバーのグループ設定は解除されます。',()=>{
    S.members.forEach(m=>{ if(m.groupId===id) m.groupId=null; });
    S.groups=S.groups.filter(g=>g.id!==id);
    save(); renderGroupsModal(); renderMembers();
  });
}
function renderGroupsModal(){
  const grps = sortedGroups();
  document.getElementById('groups-list').innerHTML = grps.map(g=>`
    <div class="lvl-list-item" id="grp-${g.id}">
      <div class="lvl-color-dot" style="background:${g.color}"></div>
      <span style="flex:1;font-size:13px">${escH(g.name)}</span>
      <span style="font-size:11px;color:var(--text3);margin-right:8px">${S.members.filter(m=>m.groupId===g.id).length}人</span>
      <button class="btn ghost xs" onclick="editGroupInline(${g.id})">編集</button>
      <button class="btn danger xs" onclick="deleteGroup(${g.id})">削除</button>
    </div>
  `).join('');
  initTouchDrag('groups-list');
}
function editGroupInline(id){
  const g=S.groups.find(x=>x.id===id); if(!g) return;
  const row=document.getElementById('grp-'+id); if(!row) return;
  row.innerHTML='<span class="drag-handle">⠿</span>'
    +'<input type="color" value="'+g.color+'" id="gc-'+id+'" style="width:30px;height:30px;border:1px solid var(--border);border-radius:5px;background:none;cursor:pointer;padding:2px;flex-shrink:0">'
    +'<input class="field sm" value="'+escH(g.name)+'" id="gn-'+id+'" style="flex:1">'
    +'<button class="btn primary xs" onclick="saveGroupEdit('+JSON.stringify(id)+')">保存</button>'
    +'<button class="btn ghost xs" onclick="renderGroupsModal()">✕</button>';
}
function saveGroupEdit(id){
  const g=S.groups.find(x=>x.id===id); if(!g) return;
  g.name=document.getElementById('gn-'+id).value.trim()||g.name;
  g.color=document.getElementById('gc-'+id).value;
  save(); renderGroupsModal(); renderMembers();
}

/* ============================================================
   MEMBERS
============================================================ */
function getAvailableYears(){
  const years = new Set(S.members.map(m=>m.year||CURRENT_YEAR));
  years.add(CURRENT_YEAR);
  return [...years].sort((a,b)=>b-a);
}
function setMemberYear(y){
  S.memberYear=y; renderMembers();
}
function renderMemberYearTabs(){
  // member-year-tabs は project badge に置き換えられたため、updateCurrentProjectBadge を呼ぶのみ
  updateCurrentProjectBadge();
}
function setMemberSort(s){
  S.memberSort=s;
  document.querySelectorAll('.sort-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.sort===s);
  });
  renderMembers();
}

function openAddMemberModal(){
  if(!requireAdmin()) return;
  document.getElementById('mem-modal-title').textContent='メンバー追加';
  document.getElementById('mem-edit-id').value='';
  document.getElementById('mem-name').value='';
  document.getElementById('mem-comment').value='';
  document.getElementById('mem-type').value='regular';
  populateMemberModalSelects();
  const levelSel=document.getElementById('mem-level');
  const groupSel=document.getElementById('mem-group');
  if(levelSel.options.length) levelSel.selectedIndex=0;
  if(groupSel.options.length) groupSel.selectedIndex=0;
  openModal('modal-member-edit');
}
function openEditMemberModal(id){
  const m=S.members.find(x=>x.id===id); if(!m) return;
  document.getElementById('mem-modal-title').textContent='メンバー編集';
  document.getElementById('mem-edit-id').value=id;
  document.getElementById('mem-name').value=m.name;
  document.getElementById('mem-comment').value=m.comment||'';
  document.getElementById('mem-type').value=m.type||'regular';
  populateMemberModalSelects(m.levelId, m.groupId, m.year);
  openModal('modal-member-edit');
}
function populateMemberModalSelects(levelId, groupId, year){
  const levelSel=document.getElementById('mem-level');
  const groupSel=document.getElementById('mem-group');
  const yearSel=document.getElementById('mem-year');
  levelSel.innerHTML=sortedLevels().map(l=>`<option value="${l.id}" ${l.id===levelId?'selected':''}>${escH(l.name)}</option>`).join('');
  groupSel.innerHTML='<option value="">（なし）</option>'+sortedGroups().map(g=>`<option value="${g.id}" ${g.id===groupId?'selected':''}>${escH(g.name)}</option>`).join('');
  const years=[CURRENT_YEAR-1,CURRENT_YEAR,CURRENT_YEAR+1];
  yearSel.innerHTML=years.map(y=>`<option value="${y}" ${y===(year||CURRENT_YEAR)?'selected':''}>${y}年度</option>`).join('');
}
function saveMemberModal(){
  const id = parseInt(document.getElementById('mem-edit-id').value)||0;
  const name = document.getElementById('mem-name').value.trim();
  if(!name){ toast('名前を入力してください'); return; }
  const levelId = parseInt(document.getElementById('mem-level').value)||S.levels[0]?.id;
  const groupId = parseInt(document.getElementById('mem-group').value)||null;
  const type = document.getElementById('mem-type').value;
  const year = parseInt(document.getElementById('mem-year').value)||CURRENT_YEAR;
  const comment = document.getElementById('mem-comment').value.trim();
  if(id){
    const m=S.members.find(x=>x.id===id);
    if(m){ Object.assign(m,{name,levelId,groupId,type,year,comment}); }
  } else {
    if(S.members.some(m=>m.name===name&&m.year===year)){ toast('同じ名前のメンバーがいます'); return; }
    S.members.push({
      id:S.nextId++, name, levelId, groupId, type, year, comment,
      totalGames:0, sessions:[], lastDate:null,
      status:'active', createdAt:Date.now(),
      consecutiveGames:0, lastWaitStart:Date.now()
    });
  }
  const savedId=id?id:(S.members.length>0?S.members[S.members.length-1].id:null);
  save(); closeModal('modal-member-edit'); renderMembers(); renderToday();
  if(_afterMemberSave){var fn=_afterMemberSave;_afterMemberSave=null;fn(savedId);}
}
function deleteMember(id){
  confirmDialog('メンバー削除','このメンバーを削除しますか？成績データも削除されます。',()=>{
    S.members=S.members.filter(m=>m.id!==id);
    S.courts.forEach(c=>{ if(c.players&&c.players.includes(id)) c.players=null; });
    S.todayParticipants=S.todayParticipants.filter(x=>x!==id);
    save(); renderMembers(); renderCourts(); renderWaiting(); renderToday();
  });
}
function toggleMemberStatus(id, type){
  const m=S.members.find(x=>x.id===id); if(!m) return;
  if(type==='rest') m.status = m.status==='resting'?'active':'resting';
  if(type==='tired') m.status = m.status==='tired'?'active':'tired';
  save(); renderMembers(); renderCourts(); renderWaiting();
}
function openMemberDetail(id){
  const m=S.members.find(x=>x.id===id); if(!m) return;
  const lvl=getLevelById(m.levelId);
  const grp=getGroupById(m.groupId);
  const totalSessions=S.sessions.filter(s=>s.participants.includes(id)).length;
  const allSessions=S.sessions.length;
  const rate=allSessions?Math.round(totalSessions/allSessions*100):0;
  const recentSessions=[...S.sessions].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,5);
  document.getElementById('member-detail-content').innerHTML=`
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
      <div class="m-avatar" style="width:52px;height:52px;font-size:22px;background:${lvl.color}22;color:${lvl.color}">${getInitial(m.name)}</div>
      <div>
        <div style="font-family:var(--disp);font-size:20px;font-weight:700">${escH(m.name)}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:3px;display:flex;gap:8px;flex-wrap:wrap">
          <span style="color:${lvl.color}">${escH(lvl.name)}</span>
          ${grp?`<span style="color:${grp.color}">${escH(grp.name)}</span>`:''}
          ${m.type==='visitor'?'<span class="vbadge">VISITOR</span>':''}
        </div>
      </div>
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-title">総試合数</div><div class="stat-val">${m.totalGames}</div></div>
      <div class="stat-card"><div class="stat-title">参加率</div><div class="stat-val">${rate}%</div><div style="margin-top:5px"><div class="prog-bar"><div class="prog-fill" style="width:${rate}%"></div></div></div></div>
      <div class="stat-card"><div class="stat-title">参加回数</div><div class="stat-val">${totalSessions}</div><div class="stat-sub">/${allSessions}回</div></div>
      <div class="stat-card"><div class="stat-title">最終参加</div><div class="stat-val" style="font-size:14px;margin-top:4px">${m.lastDate||'—'}</div></div>
    </div>
    ${m.comment?`<div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--r2);padding:10px 12px;font-size:12px;color:var(--text2);margin-bottom:10px">💬 ${escH(m.comment)}</div>`:''}
    <div class="modal-sub-title">直近5回の参加</div>
    ${recentSessions.length?recentSessions.map(sess=>{
      const res=sess.results.find(r=>r.memberId===id);
      return `<div class="sess-member-row">
        <div class="sess-mem-name">${sess.date}</div>
        <div class="sess-games-bar"><div class="rank-bg"><div class="rank-bar-fill" style="width:${res?Math.min(res.games/10*100,100):0}%"></div></div></div>
        <div class="sess-games-cnt">${res?res.games:0}試合</div>
      </div>`;
    }).join(''):'<div style="color:var(--text3);font-size:12px">データなし</div>'}
    <div style="display:flex;gap:6px;margin-top:14px">
      <button class="btn ghost sm" onclick="closeModal('modal-member-detail');openEditMemberModal(${id})">✏️ 編集</button>
      <button class="btn danger sm" onclick="closeModal('modal-member-detail');deleteMember(${id})">🗑 削除</button>
    </div>
  `;
  openModal('modal-member-detail');
}

function renderMembers(){
  renderMemberYearTabs();
  const container=document.getElementById('member-list-container');
  let members=S.members.filter(m=>(m.year||CURRENT_YEAR)===S.memberYear);
  // Sort
  switch(S.memberSort){
    case 'name':   members.sort((a,b)=>a.name.localeCompare(b.name,'ja')); break;
    case 'level':  members.sort((a,b)=>{
      const la=getLevelById(a.levelId), lb=getLevelById(b.levelId);
      return la.order-lb.order;
    }); break;
    case 'games':  members.sort((a,b)=>b.totalGames-a.totalGames); break;
    case 'rate':   members.sort((a,b)=>getRate(b)-getRate(a)); break;
    case 'last':   members.sort((a,b)=>new Date(b.lastDate||0)-new Date(a.lastDate||0)); break;
    case 'group':  members.sort((a,b)=>{
      const ga=getGroupById(a.groupId), gb=getGroupById(b.groupId);
      return (ga?.order??99)-(gb?.order??99)||a.name.localeCompare(b.name,'ja');
    }); break;
  }
  if(!members.length){
    container.innerHTML='<div class="empty"><div class="empty-icon">👤</div><div class="empty-txt">この年度のメンバーはいません</div></div>';
    return;
  }
  const maxGames=Math.max(...members.map(m=>m.totalGames),1);
  if(S.memberSort==='group'){
    let html='';
    const grpOrder=sortedGroups();
    const grpIds=[...new Set(members.map(m=>m.groupId))];
    // Show by group order + ungrouped
    const ordered=[...grpOrder.filter(g=>grpIds.includes(g.id)), ...(!grpIds.includes(null)?[]:[{id:null,name:'未分類',color:'var(--text3)'}])];
    ordered.forEach(grp=>{
      const grpMembers=members.filter(m=>m.groupId===grp.id);
      if(!grpMembers.length) return;
      html+=`<div class="grp-header">
        <div class="grp-header-line" style="background:${grp.color};opacity:.3"></div>
        <div class="grp-header-name" style="color:${grp.color}">${escH(grp.name||'未分類')}</div>
        <div class="grp-header-cnt">${grpMembers.length}人</div>
        <div class="grp-header-line" style="background:${grp.color};opacity:.3"></div>
      </div>`;
      html+=grpMembers.map(m=>renderMemberCard(m,maxGames)).join('');
    });
    container.innerHTML=html;
  } else {
    container.innerHTML=members.map(m=>renderMemberCard(m,maxGames)).join('');
  }
}
function getRate(m){
  const t=S.sessions.length; if(!t) return 0;
  return S.sessions.filter(s=>s.participants.includes(m.id)).length/t;
}
function getFace(m){
  const thresh=S.settings.faceThresholds||defaultFaces();
  // find by today's games (use consecutive as proxy for today)
  const todayGames=m.todayGames||0;
  for(const t of [...thresh].sort((a,b)=>b.games-a.games)){
    if(todayGames>=t.games) return t.face;
  }
  return '😊';
}
function renderMemberCard(m, maxGames){
  const lvl=getLevelById(m.levelId);
  const grp=getGroupById(m.groupId);
  const barPct=maxGames>0?Math.round(m.totalGames/maxGames*100):0;
  const face=getFace(m);
  const isPlaying=S.courts.some(c=>c.players&&c.players.includes(m.id));
  const isToday=S.todayParticipants.includes(m.id);
  return `<div class="m-card level-stripe" style="--lvl-color:${lvl.color}" id="mc-${m.id}">
    <div class="m-card-inner" onclick="openMemberDetail(${m.id})">
      <div class="m-avatar" style="background:${lvl.color}22;color:${lvl.color};width:36px;height:36px;font-size:15px">${getInitial(m.name)}</div>
      <div class="m-info">
        <div class="m-name">
          ${escH(m.name)}
          ${m.type==='visitor'?'<span class="vbadge">V</span>':''}
          ${isPlaying?'<span class="badge accent" style="font-size:9px">試合中</span>':''}
          ${isToday&&!isPlaying?'<span class="badge green" style="font-size:9px">参加</span>':''}
        </div>
        <div class="m-meta">
          <span style="color:${lvl.color}">${escH(lvl.name)}</span>
          ${grp?`<span style="color:${grp.color}">${escH(grp.name)}</span>`:''}
          <span>🏸${m.totalGames}</span>
          ${m.lastDate?`<span>📅${m.lastDate}</span>`:''}
          <span>${face}</span>
          ${m.status==='resting'?'<span style="color:var(--orange)">😴休憩</span>':''}
          ${m.status==='tired'?'<span style="color:var(--red)">💀限界</span>':''}
        </div>
      </div>
      <div class="m-actions" onclick="event.stopPropagation()">
        <div class="ico-btn ${m.status==='resting'?'on':''}" onclick="toggleMemberStatus(${m.id},'rest')" title="休憩">😴</div>
        <div class="ico-btn tired ${m.status==='tired'?'on':''}" onclick="toggleMemberStatus(${m.id},'tired')" title="疲れ">💀</div>
        <div class="ico-btn" onclick="openEditMemberModal(${m.id})" title="編集">✏️</div>
        ${renderSelfBtn(m.id)}
      </div>
    </div>
    <div class="m-bar-wrap"><div class="m-bar" style="width:${barPct}%;background:${lvl.color}"></div></div>
  </div>`;
}

/* ============================================================
   TODAY — PARTICIPATION MANAGEMENT
============================================================ */
function renderToday(){
  document.getElementById('today-count-badge').textContent=S.todayParticipants.length+'人';
  const members=S.members.filter(function(m){return (m.year||CURRENT_YEAR)===CURRENT_YEAR;});
  const lvlCounts={};
  S.todayParticipants.forEach(function(id){
    const m=S.members.find(function(x){return x.id===id;}); if(!m) return;
    const l=getLevelById(m.levelId);
    if(!lvlCounts[l.id]) lvlCounts[l.id]={lvl:l,count:0};
    lvlCounts[l.id].count++;
  });
  let cBadges=sortedLevels().filter(function(l){return lvlCounts[l.id];}).map(function(l){
    return '<span style="display:inline-flex;align-items:center;gap:4px;background:'+l.color+'22;border:1px solid '+l.color+';border-radius:100px;padding:2px 9px;font-size:11px;color:'+l.color+';font-weight:600">'+escH(l.name)+' <b>'+lvlCounts[l.id].count+'</b></span>';
  }).join('');
  document.getElementById('today-level-counts').innerHTML=cBadges||'<span style="font-size:11px;color:var(--text3)">参加者未選択</span>';
  const lvlOrder={};
  sortedLevels().forEach(function(l,i){lvlOrder[l.id]=i;});
  function sortByLvl(arr){
    return arr.slice().sort(function(a,b){
      return ((lvlOrder[a.levelId]!==undefined?lvlOrder[a.levelId]:99)-(lvlOrder[b.levelId]!==undefined?lvlOrder[b.levelId]:99))||a.name.localeCompare(b.name,'ja');
    });
  }
  const regular=sortByLvl(members.filter(function(m){return m.type!=='visitor';}));
  const visitor=sortByLvl(members.filter(function(m){return m.type==='visitor';}));
  let html='';
  if(regular.length){
    html+='<div style="font-size:11px;font-weight:600;color:var(--accent);margin:8px 0 5px;text-transform:uppercase;letter-spacing:.4px">正規メンバー</div>';
    html+=buildTodayChips(regular);
  }
  if(visitor.length){
    html+='<div style="font-size:11px;font-weight:600;color:var(--purple);margin:10px 0 5px;text-transform:uppercase;letter-spacing:.4px">ビジター</div>';
    html+=buildTodayChips(visitor);
  }
  document.getElementById('today-chips').innerHTML=html;
}
function renderTodayRanking(){
  var el=document.getElementById('today-ranking-list'); if(!el) return;
  if(!S.todayParticipants.length){ el.innerHTML='<div style="color:var(--text3);font-size:12px;padding:8px 0">セッション開始後に表示されます</div>'; return; }
  var maxG=Math.max.apply(null,S.todayParticipants.map(function(id){var m=S.members.find(function(x){return x.id===id;});return m?(m.todayGames||0):0;}).concat([1]));
  var ranked=S.todayParticipants.map(function(id){return S.members.find(function(m){return m.id===id;});}).filter(Boolean)
    .sort(function(a,b){return b.consecutiveGames-a.consecutiveGames;});
  el.innerHTML=ranked.map(function(m,i){
    var lvl=getLevelById(m.levelId);
    var pct=maxG>0?Math.round((m.todayGames||0)/maxG*100):0;
    return '<div class="rank-row">'
      +'<div class="rank-num '+(i===0?'g':i===1?'s':i===2?'b':'')+'">'+(i+1)+'</div>'
      +'<div class="rank-bar-w">'
      +'<div class="rank-name">'+escH(m.name)+' <span style="font-size:10px;color:'+lvl.color+'">'+escH(lvl.name)+'</span></div>'
      +'<div class="rank-bg"><div class="rank-bar-fill" style="width:'+pct+'%;background:'+lvl.color+'"></div></div>'
      +'</div>'
      +'<div class="rank-cnt">'+(m.todayGames||0)+'</div>'
      +'</div>';
  }).join('');
}
function buildTodayChips(members){
  return members.map(function(m){
    const on=S.todayParticipants.includes(m.id);
    const lvl=getLevelById(m.levelId);
    const style=on?'border-color:'+lvl.color+';background:'+lvl.color+'22;color:'+lvl.color:'';
    return '<span class="part-chip '+(on?'on':'')+'" onclick="toggleTodayParticipant('+m.id+')" style="'+style+'">'
      +'<span style="width:18px;height:18px;border-radius:50%;background:'+lvl.color+'22;color:'+lvl.color+';display:inline-flex;align-items:center;justify-content:center;font-family:var(--disp);font-size:9px;font-weight:700">'+getInitial(m.name)+'</span>'
      +escH(m.name)
      +(m.type==='visitor'?'<span style="font-size:8px;color:var(--purple)">V</span>':'')
      +'</span>';
  }).join('');
}

function toggleTodayParticipant(id){
  const idx=S.todayParticipants.indexOf(id);
  if(idx>=0) S.todayParticipants.splice(idx,1);
  else S.todayParticipants.push(id);
  save(); renderToday(); renderWaiting();
}
function selectAllToday(){
  if(!requireAdmin()) return;
  S.todayParticipants=[...new Set(S.members.filter(m=>(m.year||CURRENT_YEAR)===CURRENT_YEAR).map(m=>m.id))];
  save(); renderToday(); renderWaiting();
}
function clearAllToday(){
  if(!requireAdmin()) return;
  S.todayParticipants=[];
  save(); renderToday(); renderWaiting();
}
function startSession(){
  if(!S.todayParticipants.length){ toast('参加メンバーを選択してください'); return; }
  S.todayDate=todayStr();
  S.members.forEach(function(m){if(S.todayParticipants.includes(m.id))m.lastWaitStart=Date.now();});
  save(); toast('セッションを開始しました'); switchTab('court');
}
function confirmStartSession(){
  if(!requireAdmin()) return;
  if(!S.todayParticipants.length){ toast('参加メンバーを選択してください'); return; }
  const n=S.todayParticipants.length;
  const lc={};
  S.todayParticipants.forEach(function(id){
    const m=S.members.find(function(x){return x.id===id;}); if(!m) return;
    const l=getLevelById(m.levelId);
    if(!lc[l.name]) lc[l.name]=0; lc[l.name]++;
  });
  const ls=Object.entries(lc).map(function(e){return e[0]+':'+e[1]+'人';}).join(' / ');
  const msg='参加者 '+n+'人（'+ls+'）でセッションを開始します。\n\n途中参加・途中帰宅は本日タブでいつでも変更できます。';
  confirmDialog('セッション開始',msg,function(){startSession();},'開始する','primary');
}
let _afterMemberSave=null;
function openQuickVisitorModal(){
  document.getElementById('mem-modal-title').textContent='ビジター簡易登録';
  document.getElementById('mem-edit-id').value='';
  document.getElementById('mem-name').value='';
  document.getElementById('mem-comment').value='本日のビジター';
  document.getElementById('mem-type').value='visitor';
  populateMemberModalSelects(null,null,CURRENT_YEAR);
  const vg=S.groups.find(function(g){return g.name.indexOf('ビジター')>=0;});
  if(vg) document.getElementById('mem-group').value=vg.id;
  _afterMemberSave=function(id){
    if(id&&!S.todayParticipants.includes(id)) S.todayParticipants.push(id);
    renderToday(); renderWaiting(); save();
    toast('ビジター登録・本日参加に追加しました');
  };
  openModal('modal-member-edit');
}

function todayStr(){
  const d=new Date();
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

/* ============================================================
   COURTS
============================================================ */
function syncCourts(){
  const n=S.settings.courtCount;
  while(S.courts.length<n) S.courts.push({id:S.courts.length+1,players:null,confirmed:false});
  if(S.courts.length>n) S.courts=S.courts.slice(0,n);
  // デフォルトコートレベル設定
  if(!S.settings.courtLevels) S.settings.courtLevels={};
  [[1,'1'],[2,'any'],[3,'3']].forEach(function(p){
    if(!S.settings.courtLevels[p[0]]) S.settings.courtLevels[p[0]]=p[1];
  });
}
function getLevelConsec(levelId){
  var lc=S.settings.levelConsec||{};
  var cfg=lc[levelId];
  // Fall back to global settings if not configured per-level
  if(!cfg) return {enabled:S.settings.consecLimit, maxGames:S.settings.consecMax||2, intervalMin:0};
  return {enabled:!!cfg.enabled, maxGames:cfg.maxGames||2, intervalMin:cfg.intervalMin||0};
}
function isConsecBlocked(m){
  var cfg=getLevelConsec(m.levelId);
  if(!cfg.enabled) return false;
  // インターバルチェック：前の試合終了から指定分数が未経過なら除外
  if(cfg.intervalMin>0 && m.lastGameEndTime){
    var elapsedMin=(Date.now()-m.lastGameEndTime)/60000;
    if(elapsedMin < cfg.intervalMin) return true;
  }
  // maxGames=0 は回数制限なし（インターバルのみ有効）
  if(cfg.maxGames===0) return false;
  return m.consecutiveGames >= cfg.maxGames;
}
function getAvailableForCourt(courtId){
  const playing=new Set();
  S.courts.forEach(c=>{ if(c.players&&Array.isArray(c.players)&&c.id!==courtId) c.players.forEach(function(p){if(p!=null)playing.add(p);}); });
  // セッション開始前は抽選対象なし
  var sessionActive=(S.todayParticipants.length>0 || S.todayDate!=null);
  var sourceIds=sessionActive
    ? (S.todayParticipants.length?S.todayParticipants:S.members.map(m=>m.id))
    : S.members.map(m=>m.id); // session未開始でも全員を抽選対象に
  const pool=sourceIds
    .map(id=>S.members.find(m=>m.id===id))
    .filter(m=>m && m.status==='active' && !playing.has(m.id) && !isConsecBlocked(m));
  return pool;
}
function sortByPriority(members){
  return [...members].sort((a,b)=>{
    if(S.settings.waitPriority){
      const wa=a.lastWaitStart?Date.now()-a.lastWaitStart:0;
      const wb=b.lastWaitStart?Date.now()-b.lastWaitStart:0;
      return wb-wa;
    }
    return a.totalGames-b.totalGames;
  });
}
function pickRandom(arr,n){
  const a=[...arr]; const r=[];
  for(let i=0;i<n&&a.length;i++){ const idx=Math.floor(Math.random()*a.length); r.push(a.splice(idx,1)[0]); }
  return r.length===n?r:null;
}
function buildLevelSearchOrder(clvStr, pool){
  // ALLは全員から抽選（レベル優先度の低い順に並べる）
  if(clvStr==='any'){
    var lvlsSorted=sortedLevels(); // order昇順（緩が先頭）
    return pool.slice().sort(function(a,b){
      var oa=lvlsSorted.findIndex(function(l){return l.id===a.levelId;});
      var ob=lvlsSorted.findIndex(function(l){return l.id===b.levelId;});
      if(oa!==ob) return oa-ob; // レベル低い順
      return (a.todayGames||0)-(b.todayGames||0); // 同レベルは試合数少ない順
    });
  }

  var targetId=parseInt(clvStr);
  var lvlsSorted=sortedLevels();
  var targetIdx=lvlsSorted.findIndex(function(l){return l.id===targetId;});
  if(targetIdx<0) return pool;

  // 指定レベルのメンバーを優先、不足分は試合数少ない順で他レベルから補充
  var preferred=pool.filter(function(m){return m.levelId===targetId;});

  if(preferred.length>=4){
    // 指定レベルだけで4人揃う → 試合数少ない順で返す
    return preferred.sort(function(a,b){return (a.consecutiveGames||0)-(b.consecutiveGames||0);});
  }

  // 不足分を他レベルから補充（試合数少ない順）
  var others=pool.filter(function(m){return m.levelId!==targetId;});
  others.sort(function(a,b){return (a.consecutiveGames||0)-(b.consecutiveGames||0);});
  var needed=4-preferred.length;
  var fill=others.slice(0,needed);

  // 指定レベル全員＋補充メンバーを返す
  return preferred.concat(fill);
}

function drawForCourt(courtId){
  const court=S.courts.find(c=>c.id===courtId); if(!court) return 'ok';
  const pool=getAvailableForCourt(courtId);
  const clvStr=S.settings.courtLevels[courtId]||'any';

  var candidates=buildLevelSearchOrder(clvStr, pool);

  if(!candidates||candidates.length===0){
    // 誰もいない → 空きスロット4つでセット（マニュアル入力用）
    court.players=[null,null,null,null];
    court.confirmed=false;
    toast('コート'+courtId+': 条件に合うメンバーがいません。マニュアルで設定してください');
    return 'empty';
  }

  // buildLevelSearchOrderが優先順に並べて返す
  // 指定レベル優先・不足は試合数少ない順補充済みなので先頭4人を使う
  var picked=[];
  if(candidates.length>=4){
    // 4人以上いる場合：指定レベルは全員確定、残りはsortByPriorityで選択
    var preferred2=candidates.filter(function(m){
      var clv=S.settings.courtLevels[courtId]||'any';
      return clv==='any'||m.levelId===parseInt(clv);
    });
    var others2=candidates.filter(function(m){
      var clv=S.settings.courtLevels[courtId]||'any';
      return clv!=='any'&&m.levelId!==parseInt(clv);
    });
    // 指定レベルから最大4人、不足を他レベルから試合数少ない順
    var sel=sortByPriority(preferred2).slice(0,4);
    if(sel.length<4){
      var fill2=sortByPriority(others2).slice(0,4-sel.length);
      sel=sel.concat(fill2);
    }
    picked=sel;
  } else {
    picked=candidates;
  }

  // 4スロット分配列を作り、足りない分はnullで埋める
  var slots=[null,null,null,null];
  for(var i=0;i<picked.length&&i<4;i++) slots[i]=picked[i].id;
  court.players=slots;
  court.confirmed=false;

  if(picked.length<4){
    toast('コート'+courtId+': '+picked.length+'人配置。残り'+(4-picked.length)+'枠はマニュアルで設定してください');
    return 'partial';
  }
  // ペア自動組み替え（弱強が同チームになるよう）
  autoSwapPairs(courtId);
  return 'ok';
}
function drawAll(){
  if(!requireDrawOfficer()) return;
  
  if(!S.todayParticipants.length && !S.todayDate){
    toast('「本日」タブで参加メンバーを選択してセッションを開始してください');
    return;
  }
  pushHistory();
  var n=0, shorts=[], msgs=[];
  // レベル指定コートを先に抽選（レベル優先度の低い順）、ALLコートは最後
  var lvlsSorted=sortedLevels(); // order昇順（緩=0が先頭）
  function getCourtLvlOrder(c){
    var lid=S.settings.courtLevels[c.id]||'any';
    if(lid==='any') return 9999; // ALLは最後
    var lvlIdx=lvlsSorted.findIndex(function(l){return l.id===parseInt(lid);});
    return lvlIdx>=0?lvlIdx:9999;
  }
  var ordered=S.courts.filter(function(c){return !c.confirmed;})
    .sort(function(a,b){return getCourtLvlOrder(a)-getCourtLvlOrder(b);});
  ordered.forEach(function(c){
    var r=drawForCourt(c.id);
    if(r==='ok'||r==='partial') n++;
    else if(r==='short') shorts.push(c.id);
  });
  if(shorts.length) msgs.push('コート'+shorts.join(',')+'は完全にメンバー不足');
  if(msgs.length) toast(msgs.join(' / '));
  save(); renderCourts(); renderWaiting();
}
function reshuffleCourt(courtId){
  if(!requireDrawOfficer()) return;
  if(!S.todayParticipants.length && !S.todayDate){
    toast('「本日」タブでセッションを開始してください');
    return;
  }
  pushHistory();
  var c=S.courts.find(function(x){return x.id===courtId;});
  if(c&&c.confirmed) revertCourtConfirm(c);
  drawForCourt(courtId);
  save(); renderCourts(); renderWaiting();
}
function revertCourtConfirm(c){
  // Roll back game counts for a confirmed court (used before reshuffle)
  if(!c||!c.confirmed||!c.players) return;
  c.players.forEach(function(pid){
    if(pid===null) return;
    var m=S.members.find(function(x){return x.id===pid;}); if(!m) return;
    if(m.totalGames>0) m.totalGames--;
    if(m.consecutiveGames>0) m.consecutiveGames--;
    if(m.todayGames>0) m.todayGames--;
    m.lastWaitStart=Date.now();
    m.lastGameEndTime=Date.now();
  });
  c.confirmed=false;
}
function confirmCourt(courtId){
  if(!requireDrawOfficer()) return;
  const c=S.courts.find(x=>x.id===courtId); if(!c||!c.players) return;
  if(c.confirmed) return; // already confirmed
  c.confirmed=true;
  var now=Date.now();
  c.players.forEach(function(pid){
    if(pid===null) return; // 空きスロットはスキップ
    var m=S.members.find(x=>x.id===pid); if(!m) return;
    m.totalGames++; m.consecutiveGames++;
    if(!m.todayGames) m.todayGames=0; m.todayGames++;
    m.lastWaitStart=null;
    m.lastDate=todayStr();
    m.lastGameStartTime=now;
  });
  var activePids=c.players.filter(function(pid){return pid!==null;});
  S.members.forEach(function(m){
    if(!activePids.includes(m.id)&&m.lastWaitStart===null) m.lastWaitStart=now;
  });
  save(); renderCourts(); renderWaiting(); renderTodayRanking(); toast('コート'+courtId+' 試合開始！ 🏸');
}
function finishCourt(courtId){
  const c=S.courts.find(x=>x.id===courtId); if(!c) return;
  var now=Date.now();
  if(c.players&&c.confirmed){
    // 試合開始済み → 終了時刻を記録するだけ（試合数はconfirmCourt時に加算済み）
    c.players.forEach(function(pid){
      var m=S.members.find(x=>x.id===pid); if(!m) return;
      m.lastGameEndTime=now;
      m.lastWaitStart=now;
    });
  } else if(c.players&&!c.confirmed){
    // 試合開始していない → キャンセル扱い（試合数は増やさない）
    c.players.forEach(function(pid){
      var m=S.members.find(x=>x.id===pid); if(!m) return;
      m.lastWaitStart=now; // 待機開始時刻だけ更新
    });
    toast('コート'+courtId+': キャンセル（試合数は変わりません）');
  }
  c.players=null; c.confirmed=false;
  save(); renderCourts(); renderWaiting(); renderTodayRanking();
}
function endSession(){
  // Save session data
  if(!S.todayParticipants.length) return;
  const dateStr=S.todayDate||todayStr();
  const results=S.todayParticipants.map(id=>{
    const m=S.members.find(x=>x.id===id);
    return {memberId:id, games:m?m.consecutiveGames:0};
  });
  S.sessions.push({id:S.nextId++, date:dateStr, participants:[...S.todayParticipants], results, totalGames: S.courts.filter(c=>c.confirmed).length});
  // Reset consecutive
  S.members.forEach(m=>{ m.consecutiveGames=0; m.lastWaitStart=Date.now(); m.status='active'; });
  S.courts.forEach(c=>{ c.players=null; c.confirmed=false; });
  S.todayParticipants=[]; S.todayDate=null;
  save(); renderAll(); toast('セッション終了・成績を保存しました 📊');
}

/* ============================================================
   SWAP MODE
============================================================ */
function selectSwap(memberId, type, courtId){
  const sw=S.swapMode;
  if(!sw.active){
    sw.active=true; sw.source={id:memberId,type,courtId};
    document.getElementById('swap-hint').style.display='block';
    renderCourts(); renderWaiting();
  } else {
    if(sw.source.id===memberId&&sw.source.type===type){ clearSwap(); return; }
    performSwap(sw.source,{id:memberId,type,courtId});
    clearSwap();
  }
}
function clearSwap(){
  S.swapMode={active:false,source:null};
  document.getElementById('swap-hint').style.display='none';
  renderCourts(); renderWaiting();
}
function fillEmptySlot(courtId, _ignored){
  var sw=S.swapMode;
  if(!sw.active||!sw.source) return;
  var c=S.courts.find(function(x){return x.id===courtId;}); if(!c||!c.players) return;
  var emptyIdx=c.players.indexOf(null);
  if(emptyIdx<0) return;
  // Place the selected member into the empty slot
  if(sw.source.type==='wait'){
    c.players[emptyIdx]=sw.source.id;
  } else if(sw.source.type==='court'){
    // Move from another court slot: swap
    var srcCourt=S.courts.find(function(x){return x.id===sw.source.courtId;});
    if(srcCourt&&srcCourt.players){
      var srcIdx=srcCourt.players.indexOf(sw.source.id);
      if(srcIdx>=0){ srcCourt.players[srcIdx]=null; c.players[emptyIdx]=sw.source.id; }
    }
  }
  save(); clearSwap();
}
function performSwap(a,b){
  pushHistory();
  const getCourtPlayers=cid=>S.courts.find(c=>c.id===cid)?.players;
  if(a.type==='court'&&b.type==='court'){
    const pa=getCourtPlayers(a.courtId), pb=getCourtPlayers(b.courtId);
    if(!pa||!pb) return;
    const ia=pa.indexOf(a.id), ib=pb.indexOf(b.id);
    if(ia>=0&&ib>=0){ pa[ia]=b.id; pb[ib]=a.id; }
  } else if(a.type==='court'&&b.type==='wait'){
    const pa=getCourtPlayers(a.courtId); if(!pa) return;
    const ia=pa.indexOf(a.id); if(ia>=0) pa[ia]=b.id;
  } else if(a.type==='wait'&&b.type==='court'){
    const pb=getCourtPlayers(b.courtId); if(!pb) return;
    const ib=pb.indexOf(b.id); if(ib>=0) pb[ib]=a.id;
  }
  save(); renderCourts(); renderWaiting();
}

/* ============================================================
   RENDER COURTS
============================================================ */
function renderCourts(){
  const sw=S.swapMode;
  let out='';
  S.courts.forEach(function(c){
    if(c.players!=null&&!Array.isArray(c.players)){var pa=[null,null,null,null];Object.keys(c.players).forEach(function(k){pa[parseInt(k)]=c.players[k];});c.players=pa;}
    if(!S.settings||!S.settings.courtLevels){if(!S.settings)S.settings={};S.settings.courtLevels={};}
    const clv=S.settings.courtLevels[c.id]||'any';
    const dot=c.confirmed?'dot-done':c.players?'dot-active':'dot-idle';
    const cardCls=c.confirmed?'confirmed':c.players?'active':'';
    let body='';
    if(c.players&&Array.isArray(c.players)&&c.players.length===4){
      const ps=c.players.map(function(id){if(id==null)return null;return S.members.find(function(m){return m.id===id;})||null;});
      body='<div class="vs-layout">'
        +'<div class="team-col">'+renderChip(ps[0],'court',c.id)+renderChip(ps[1],'court',c.id)+'</div>'
        +'<div class="vs-div">VS</div>'
        +'<div class="team-col">'+renderChip(ps[2],'court',c.id)+renderChip(ps[3],'court',c.id)+'</div>'
        +'</div>';
    } else {
      body='<div class="court-empty" style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px">'
        +'<div style="color:var(--text3);font-size:12px">🏸 未割当</div>'
        +'<button onclick="reshuffleCourt('+c.id+')" style="font-size:12px;padding:7px 18px;border-radius:var(--r2);background:var(--accent-a);border:1px solid var(--accent);color:var(--accent);cursor:pointer">このコートだけ抽選</button>'
        +'</div>';
    }
    const anySet=(clv==='any');
    let lvlBtns='<div style="display:flex;gap:3px;flex-wrap:wrap">';
    lvlBtns+=buildLvlBtn(c.id,'any','ALL',anySet,'var(--text)','var(--text3)','var(--surface2)','var(--surface)','var(--border2)','var(--border)');
    sortedLevels().forEach(function(lv){
      const sel=(clv==lv.id||clv===String(lv.id));
      lvlBtns+=buildLvlBtn(c.id,lv.id,escH(lv.shortName||lv.name.charAt(0)),sel,lv.color,lv.color,lv.color+'33','var(--surface)',lv.color,'var(--border)');
    });
    lvlBtns+='</div>';
    let footer='';
    if(c.players){
      footer='<div class="court-ft">'
        +'<div class="confirm-btn '+(c.confirmed?'done':'')+'" onclick="'+(c.confirmed?'':'confirmCourt('+c.id+')')+'">'+(c.confirmed?'⚡ 試合中':'✅ 試合開始')+'</div>'
        +'<button class="btn ghost icon-only" onclick="reshuffleCourt('+c.id+')" title="再抽選">🔀</button>'
        +'<button class="btn ghost icon-only" onclick="finishCourt('+c.id+')" title="終了">🏁</button>'
        +'</div>';
    }
    out+='<div class="court-card '+cardCls+'">'
      +'<div class="court-hd" style="flex-wrap:wrap;gap:5px">'
      +'<div class="court-num">'+c.id+'</div>'
      +'<div class="court-meta"><div class="court-lbl">コート '+c.id+'</div></div>'
      +lvlBtns
      +'<div class="status-dot '+dot+'" style="flex-shrink:0;margin-left:4px"></div>'
      +'</div><div class="court-body">'+body+'</div>'+footer+'</div>';
  });
  document.getElementById('courts-container').innerHTML=out;
  var anyUnstarted=S.courts.some(function(c){return c.players&&c.players.some(function(p){return p!=null;})&&!c.confirmed;});
  var anyActive=S.courts.some(function(c){return c.players&&c.players.some(function(p){return p!=null;});});
  var sb=document.getElementById('all-start-btn'), fb=document.getElementById('all-finish-btn');
  if(sb) sb.style.opacity=anyUnstarted?'1':'0.4';
  if(fb) fb.style.opacity=anyActive?'1':'0.4';
}
function buildLvlBtn(cid,val,label,sel,sc,dc,sbg,dbg,sb,db){
  var bg=sel?sbg:dbg, color=sel?sc:dc, border=sel?sb:db;
  var oc='setCourtLevel('+cid+",\'"+String(val)+"\')";
  return '<span onclick="'+oc+'" style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:100px;background:'+bg+';color:'+color+';border:1px solid '+border+';cursor:pointer;transition:all .18s">'+label+'</span>';
}
function setCourtLevel(courtId,levelId){
  S.settings.courtLevels[courtId]=String(levelId); save(); renderCourts();
}

function renderChip(player,type,courtId){
  if(!player){
    var sw2=S.swapMode;
    if(sw2.active){
      // 空きスロットをスワップターゲットとして表示
      var slotIdx=S.courts.find(function(c){return c.id===courtId;})?.players?.indexOf(null);
      return '<div class="p-chip empty tgt" onclick="fillEmptySlot('+courtId+','+JSON.stringify(null)+')" style="border-color:var(--accent);background:var(--accent-a);cursor:pointer"><span class="chip-name" style="color:var(--accent)">＋ここに配置</span></div>';
    }
    return '<div class="p-chip empty"><span class="chip-name">— 空き —</span></div>';
  }
  const sw=S.swapMode;
  const isSel=sw.active&&sw.source&&sw.source.id===player.id&&sw.source.type===type;
  const isTgt=sw.active&&!isSel;
  const lvl=getLevelById(player.levelId);
  const face=getFace(player);
  const allIds=(S.todayParticipants.length?S.todayParticipants:S.members.map(function(m){return m.id;}));
  const maxG=Math.max.apply(null,allIds.map(function(id){const m=S.members.find(function(x){return x.id===id;});return m?m.totalGames:0;}).concat([1]));
  const barPct=Math.round(player.totalGames/maxG*100);
  var fn='selectSwap('+player.id+",'"+ type +"',"+courtId+')';
  return '<div class="p-chip '+(isSel?'sel ':'')+(isTgt?'tgt':'')+'" onclick="'+fn+'" style="position:relative;overflow:hidden">'
    +'<div style="position:absolute;left:0;top:0;bottom:0;width:'+barPct+'%;background:'+lvl.color+';opacity:.1;pointer-events:none"></div>'
    +'<div class="chip-av" style="background:'+lvl.color+'22;color:'+lvl.color+';position:relative">'+getInitial(player.name)+'</div>'
    +'<div style="flex:1;min-width:0;position:relative"><div class="chip-name">'+escH(player.name)+'</div>'
    +'<div class="chip-sub">'+escH(lvl.name)+' '+player.totalGames+'試合</div></div>'
    +'<div style="font-size:16px;flex-shrink:0">'+face+'</div></div>';
}

function renderWaiting(){
  const playing=new Set();
  S.courts.forEach(function(c){if(c.players&&Array.isArray(c.players))c.players.forEach(function(id){if(id!=null)playing.add(id);});});

  // Partition members by status
  // セッション開始前 (todayParticipants空) は待機リストを空にする
  var hasSession=(S.todayParticipants.length>0 || S.todayDate!=null);
  const pool=(hasSession
    ? (S.todayParticipants.length?S.todayParticipants:S.members.map(function(m){return m.id;}))
    : []
  ).map(function(id){return S.members.find(function(m){return m.id===id;});})
   .filter(function(m){return m!=null;});

  const waiting  = pool.filter(function(m){return !playing.has(m.id)&&m.status==='active';});
  const resting  = pool.filter(function(m){return !playing.has(m.id)&&m.status==='resting';});
  const tired    = pool.filter(function(m){return !playing.has(m.id)&&m.status==='tired';});

  // Update count badge (waiting only)
  document.getElementById('wait-count-badge').textContent=waiting.length+'人';

  const maxG=Math.max.apply(null,pool.map(function(m){return m.todayGames||0;}).concat([1]));
  const sw=S.swapMode;

  // Render face legend
  renderFaceLegend();

  // --- WAITING zone ---
  var emptyMsg=hasSession?'全員参加中または休憩中':'「本日」タブで参加メンバーを選択してセッションを開始してください';
  if(!waiting.length){
    document.getElementById('waiting-list').innerHTML='<span style="color:var(--text3);font-size:11px;padding:6px 0;display:block">'+emptyMsg+'</span>';
    document.getElementById('wait-count-badge').textContent='0人';
  } else {
    var lvlOrder={};
    sortedLevels().forEach(function(l,i){lvlOrder[l.id]=i;});
    var waitSorted=waiting.slice().sort(function(a,b){
      var ga=a.todayGames||0, gb=b.todayGames||0;
      if(ga!==gb) return ga-gb;
      return (lvlOrder[a.levelId]||0)-(lvlOrder[b.levelId]||0);
    });
    var whtml='<div style="display:flex;flex-direction:column;gap:4px">';
    waitSorted.forEach(function(m){ whtml+=buildWaitCard(m,maxG,sw,'active'); });
    whtml+='</div>';
    document.getElementById('waiting-list').innerHTML=whtml;
  }

  // --- RESTING zone ---
  var restHd=document.getElementById('rest-section-hd');
  var restNote=document.getElementById('rest-note');
  var restBadge=document.getElementById('rest-count-badge');
  if(resting.length && hasSession){
    restHd.style.display='flex'; restNote.style.display='block';
    restBadge.textContent=resting.length+'人';
    var rhtml='<div style="display:flex;flex-direction:column;gap:4px">';
    resting.forEach(function(m){ rhtml+=buildWaitCard(m,maxG,sw,'resting'); });
    rhtml+='</div>';
    document.getElementById('resting-list').innerHTML=rhtml;
  } else {
    restHd.style.display='none'; restNote.style.display='none';
    document.getElementById('resting-list').innerHTML='';
  }

  // --- TIRED zone ---
  var tiredHd=document.getElementById('tired-section-hd');
  var tiredNote=document.getElementById('tired-note');
  var tiredBadge=document.getElementById('tired-count-badge');
  if(tired.length && hasSession){
    tiredHd.style.display='flex'; tiredNote.style.display='block';
    tiredBadge.textContent=tired.length+'人';
    var thtml='<div style="display:flex;flex-direction:column;gap:4px">';
    tired.forEach(function(m){ thtml+=buildWaitCard(m,maxG,sw,'tired'); });
    thtml+='</div>';
    document.getElementById('tired-list').innerHTML=thtml;
  } else {
    tiredHd.style.display='none'; tiredNote.style.display='none';
    document.getElementById('tired-list').innerHTML='';
  }
}

function buildWaitCard(m, maxG, sw, zone){
  var isSel=sw.active&&sw.source&&sw.source.id===m.id&&sw.source.type==='wait';
  var isTgt=sw.active&&!isSel;
  var todayG=m.todayGames||0;
  var barPct=Math.round(todayG/maxG*100);
  var face=getFace(m);
  var lvl=getLevelById(m.levelId);
  var bord=isSel?'var(--yellow)':isTgt?'var(--accent)':
           zone==='resting'?'var(--orange)':zone==='tired'?'var(--red)':'var(--border)';
  var fn='selectSwap('+m.id+",'wait',null)";

  // Action buttons
  var restActive=(m.status==='resting');
  var tiredActive=(m.status==='tired');
  var restBtn='<button onclick="setMemberStatus('+m.id+",'resting')"
    +'" style="font-size:10px;padding:3px 7px;border-radius:5px;border:1px solid '
    +(restActive?'var(--orange)':'var(--border)')
    +';background:'+(restActive?'var(--orange-a)':'var(--surface)')
    +';color:'+(restActive?'var(--orange)':'var(--text3)')
    +';cursor:pointer;white-space:nowrap">'
    +(restActive?'✓ 休憩中':'😴 休憩')+'</button>';
  var tiredBtn='<button onclick="setMemberStatus('+m.id+",'tired')"
    +'" style="font-size:10px;padding:3px 7px;border-radius:5px;border:1px solid '
    +(tiredActive?'var(--red)':'var(--border)')
    +';background:'+(tiredActive?'var(--red-a)':'var(--surface)')
    +';color:'+(tiredActive?'var(--red)':'var(--text3)')
    +';cursor:pointer;white-space:nowrap">'
    +(tiredActive?'✓ 限界':'💀 限界')+'</button>';
  var returnBtn=(zone!=='active')?'<button onclick="setMemberStatus('+m.id+",'active')"
    +'" style="font-size:10px;padding:3px 7px;border-radius:5px;border:1px solid var(--green);background:var(--green-a);color:var(--green);cursor:pointer;white-space:nowrap">↩ 復帰</button>':'';

  return '<div style="position:relative;background:var(--bg3);border:1px solid '+bord+';border-radius:var(--r2);overflow:hidden">'
    +'<div style="position:absolute;left:0;top:0;bottom:0;width:'+barPct+'%;background:'+lvl.color+';opacity:.1;pointer-events:none"></div>'
    +'<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;position:relative">'
    +'<div onclick="'+fn+'" style="width:26px;height:26px;border-radius:50%;background:'+lvl.color+'22;color:'+lvl.color+';display:flex;align-items:center;justify-content:center;font-family:var(--disp);font-size:11px;font-weight:700;flex-shrink:0;cursor:pointer">'+getInitial(m.name)+'</div>'
    +'<div style="flex:1;min-width:0;cursor:pointer" onclick="'+fn+'">'
    +'<div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+escH(m.name)+'</div>'
    +'<div style="font-size:10px;color:var(--text3);margin-top:1px">試合数:'+m.totalGames+(m.todayGames?' 本日:'+m.todayGames:'')+'</div>'
    +'</div>'
    +'<div style="font-size:18px;flex-shrink:0">'+face+'</div>'
    +'<div style="display:flex;flex-direction:column;gap:3px;flex-shrink:0">'
    +returnBtn
    +(zone==='active'?restBtn+tiredBtn:'')
    +'</div>'
    +'</div></div>';
}

function setMemberStatus(id, status){
  var m=S.members.find(function(x){return x.id===id;}); if(!m) return;
  m.status=status;
  save(); renderCourts(); renderWaiting(); renderMembers();
}

function renderFaceLegend(){
  var faces=[...(S.settings.faceThresholds||defaultFaces())].sort(function(a,b){return a.games-b.games;});
  var el=document.getElementById('face-legend-items'); if(!el) return;
  // Build legend items with threshold range labels
  var html='';
  faces.forEach(function(f){
    html+='<div style="display:flex;align-items:center;gap:3px;background:var(--bg4);border:1px solid var(--border);border-radius:6px;padding:3px 6px;font-size:12px">'
      +f.face+'<span style="font-size:9px;color:var(--text3)">'+f.games+'〜</span>'
      +'</div>';
  });
  
  el.innerHTML=html;
}


/* ============================================================
   HISTORY
============================================================ */
function calcMemberRate(memberId){
  // 参加率: 初回参加から現在まで何回参加したか / 全セッション数
  if(!S.sessions.length) return 0;
  var firstIdx=S.sessions.findIndex(function(s){return s.participants.includes(memberId);});
  if(firstIdx<0) return 0;
  var eligible=S.sessions.length - firstIdx; // 初回以降の開催数
  var attended=S.sessions.filter(function(s){return s.participants.includes(memberId);}).length;
  return eligible>0 ? attended/eligible : 0;
}
function renderHistory(){
  document.getElementById('session-detail').classList.remove('open');
  document.getElementById('session-list-view').style.display='block';
  var n=S.sessions.length;
  // --- 統計4項目 ---
  // 開催回数
  var kaiSai=n;
  // 平均試合数/1日
  var avgGames=0;
  if(n>0){
    var totalGamesPerDay=S.sessions.map(function(s){
      return s.results.reduce(function(acc,r){return acc+r.games;},0)/4;
    });
    avgGames=(totalGamesPerDay.reduce(function(a,b){return a+b;},0)/n).toFixed(1);
  }
  // 平均参加人数/1日
  var avgMembers=n>0?(S.sessions.reduce(function(a,s){return a+s.participants.length;},0)/n).toFixed(1):'—';
  // 平均参加率/1日: 各練習日の(参加者数/登録メンバー数)の平均
  var regMembers=S.members.filter(function(m){return m.type!=='visitor';}).length;
  var avgRate='—';
  if(n>0&&regMembers>0){
    var rateSum=S.sessions.reduce(function(a,s){
      var cnt=s.participants.filter(function(id){
        var m=S.members.find(function(x){return x.id===id;});
        return m&&m.type!=='visitor';
      }).length;
      return a+(cnt/regMembers);
    },0);
    avgRate=Math.round(rateSum/n*100)+'%';
  }
  document.getElementById('hist-stats-grid').innerHTML=
    '<div class="stat-card"><div class="stat-title">開催回数</div><div class="stat-val">'+kaiSai+'</div><div class="stat-sub">回</div></div>'
    +'<div class="stat-card"><div class="stat-title">平均試合数/1日</div><div class="stat-val" style="font-size:22px;margin-top:4px">'+(n>0?avgGames:'—')+'</div><div class="stat-sub">試合</div></div>'
    +'<div class="stat-card"><div class="stat-title">平均参加人数/1日</div><div class="stat-val" style="font-size:22px;margin-top:4px">'+avgMembers+'</div><div class="stat-sub">人</div></div>'
    +'<div class="stat-card"><div class="stat-title">平均参加率/1日</div><div class="stat-val" style="font-size:22px;margin-top:4px">'+avgRate+'</div><div class="stat-sub">正規メンバー</div></div>';
  // --- 練習日一覧 ---
  var sorted=[...S.sessions].sort(function(a,b){return new Date(b.date)-new Date(a.date);});
  document.getElementById('session-list').innerHTML=sorted.length
    ?sorted.map(function(s){
      var regCount=s.participants.filter(function(id){var m=S.members.find(function(x){return x.id===id;});return m&&m.type!=='visitor';}).length;
      var rateStr=regMembers>0?Math.round(regCount/regMembers*100)+'%':'—';
      return '<div class="session-row" onclick="openSessionDetail('+s.id+')">'
        +'<div><div class="session-date">'+s.date+'</div>'
        +'<div class="session-sub">'+s.participants.length+'人参加 · 参加率'+rateStr+'</div></div>'
        +'<div style="display:flex;gap:5px;align-items:center">'
        +'<span class="badge">'+(s.results.reduce(function(x,r){return x+r.games;},0)/4|0)+'試合</span>'
        +'<button class="btn danger xs" onclick="event.stopPropagation();deleteSession('+s.id+')">削除</button>'
        +'</div></div>';
    }).join('')
    :'<div class="empty"><div class="empty-icon">📊</div><div class="empty-txt">成績データがありません</div></div>';
  // --- 参加率ランキング ---
  var membersWithRate=S.members.map(function(m){
    return {m:m, rate:calcMemberRate(m.id)};
  }).filter(function(x){return x.rate>0;}).sort(function(a,b){return b.rate-a.rate;});
  if(!membersWithRate.length){
    document.getElementById('ranking-list').innerHTML='<div class="empty"><div class="empty-txt">参加データがありません</div></div>';
    return;
  }
  document.getElementById('ranking-list').innerHTML=membersWithRate.map(function(x,i){
    var m=x.m; var rate=x.rate;
    var lvl=getLevelById(m.levelId);
    var pct=Math.round(rate*100);
    var typeBadge=m.type==='visitor'?'<span style="font-size:9px;background:var(--purple-a);color:var(--purple);border:1px solid var(--purple);border-radius:3px;padding:1px 4px;margin-left:4px">V</span>':'';
    return '<div class="rank-row">'
      +'<div class="rank-num '+(i===0?'g':i===1?'s':i===2?'b':'')+'">'+(i+1)+'</div>'
      +'<div class="rank-bar-w">'
      +'<div class="rank-name">'+escH(m.name)+' <span style="font-size:10px;color:'+lvl.color+'">'+escH(lvl.name)+'</span>'+typeBadge+'</div>'
      +'<div class="rank-bg"><div class="rank-bar-fill" style="width:'+pct+'%;background:'+lvl.color+'"></div></div>'
      +'</div>'
      +'<div class="rank-cnt">'+pct+'%</div>'
      +'</div>';
  }).join('');
}
function openSessionDetail(id){
  const sess=S.sessions.find(s=>s.id===id); if(!sess) return;
  document.getElementById('session-detail').classList.add('open');
  document.getElementById('session-list-view').style.display='none';
  const maxG=Math.max(...sess.results.map(r=>r.games),1);
  const content=`
    <div style="font-family:var(--disp);font-size:20px;font-weight:700;margin-bottom:4px">${sess.date}</div>
    <div style="font-size:11px;color:var(--text3);margin-bottom:14px">${sess.participants.length}人参加</div>
    <div class="modal-sub-title">個人成績</div>
    ${sess.results.sort((a,b)=>b.games-a.games).map(r=>{
      const m=S.members.find(x=>x.id===r.memberId)||{name:'(削除済)',levelId:null};
      const lvl=getLevelById(m.levelId);
      return `<div class="sess-member-row">
        <div style="width:20px;height:20px;border-radius:50%;background:${lvl.color}22;color:${lvl.color};display:flex;align-items:center;justify-content:center;font-family:var(--disp);font-size:9px;font-weight:700">${getInitial(m.name)}</div>
        <div class="sess-mem-name">${escH(m.name)}</div>
        <div class="sess-games-bar"><div class="rank-bg"><div class="rank-bar-fill" style="width:${Math.round(r.games/maxG*100)}%;background:${lvl.color}"></div></div></div>
        <div class="sess-games-cnt">${r.games}</div>
      </div>`;
    }).join('')}
    <div style="margin-top:14px">
      <button class="btn danger sm" onclick="deleteSession(${id});closeSessionDetail()">🗑 このセッションを削除</button>
    </div>
  `;
  document.getElementById('session-detail-content').innerHTML=content;
}
function closeSessionDetail(){
  document.getElementById('session-detail').classList.remove('open');
  document.getElementById('session-list-view').style.display='block';
}
function deleteSession(id){
  confirmDialog('セッション削除','このセッションデータを削除しますか？',function(){
    S.sessions=S.sessions.filter(function(x){return x.id!==id;});
    save(); renderHistory();
  });
}
function closeDateDelModal(){var m=document.getElementById('date-del-modal');if(m)m.remove();}
function showDeleteByDateDialog(){
  if(!S.sessions||!S.sessions.length){toast('削除するデータがありません');return;}
  var sorted=[...S.sessions].sort(function(a,b){return new Date(b.date)-new Date(a.date);});
  var opts=sorted.map(function(sess){
    var cnt=sess.participants?sess.participants.length:0;
    var games=sess.results?Math.floor(sess.results.reduce(function(a,r){return a+(r.games||0);},0)/4):0;
    return '<label style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);cursor:pointer">'
      +'<input type="checkbox" value="'+sess.id+'" style="accent-color:var(--accent);width:16px;height:16px;flex-shrink:0">'
      +'<span style="flex:1;font-size:13px">'+sess.date+'</span>'
      +'<span style="font-size:11px;color:var(--text3)">'+cnt+'人 '+games+'試合</span>'
      +'</label>';
  }).join('');
  var modal=document.createElement('div');
  modal.id='date-del-modal';
  modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:600;display:flex;align-items:flex-end;justify-content:center';
  modal.innerHTML='<div style="background:var(--bg2);border:1px solid var(--border);border-radius:16px 16px 0 0;width:100%;max-width:640px;max-height:80dvh;overflow-y:auto;padding:20px 16px;padding-bottom:calc(20px + env(safe-area-inset-bottom))">'
    +'<div style="font-family:var(--disp);font-size:18px;font-weight:700;margin-bottom:4px">🗓 日付を選んで削除</div>'
    +'<div style="font-size:11px;color:var(--text3);margin-bottom:12px">削除したいセッションにチェック（ファイルは増えません）</div>'
    +'<div id="date-del-list">'+opts+'</div>'
    +'<div style="display:flex;gap:8px;margin-top:14px">'
    +'<button class="btn danger" style="flex:1" onclick="execDateDelete()">選択削除</button>'
    +'<button class="btn ghost" onclick="closeDateDelModal()">キャンセル</button>'
    +'</div></div>';
  document.body.appendChild(modal);
}
function execDateDelete(){
  var checked=document.querySelectorAll('#date-del-list input:checked');
  if(!checked.length){toast('削除するセッションを選択してください');return;}
  var ids=Array.from(checked).map(function(c){return parseInt(c.value);});
  confirmDialog('選択削除',ids.length+'件のセッションを削除しますか？元に戻せません。',function(){
    S.sessions=S.sessions.filter(function(x){return !ids.includes(x.id);});
    closeDateDelModal();
    save(); renderHistory(); toast(ids.length+'件削除しました');
  },'削除','danger');
}
function deleteAllSessions(){
  confirmDialog('全セッション削除','全ての成績データを削除しますか？この操作は取り消せません。',()=>{
    S.sessions=[];
    save(); renderHistory();
  });
}
function resetTodayStats(){ resetTodayFull(); }
function resetTodayFull(){
  if(!requireAdmin()) return;
  var items='✅ 練習日データ / ✅ 参加メンバー選択 / ✅ 出場数ランキング(本日) / ✅ 本日の試合数 / ✅ コート抽選状況 / ✅ 休憩・限界ステータス';
  var msg='本日の以下のデータをリセットします：\n\n'+items+'\n\n※ 成績画面の過去データには影響しません。\n本当にリセットしますか？';
  confirmDialog('本日データをリセット', msg,
    function(){
      doResetToday();
      fbSendCommand('resetToday'); // 全端末に同期
      fbPush(false); // データも同期
      toast('本日データをリセットしました（全端末に反映）');
    }, 'リセットする', 'warn');
}

/* ============================================================
   DATA / BACKUP / STORAGE
============================================================ */
function renderData(){
  if(isAdmin()){
    renderStorageList();
    document.getElementById('data-admin-section').style.display='block';
    document.getElementById('data-nonadmin-msg').style.display='none';
  } else {
    document.getElementById('data-admin-section').style.display='none';
    document.getElementById('data-nonadmin-msg').style.display='block';
  }
}
function renderStorageList(){
  const keys=[];
  for(let i=0;i<localStorage.length;i++){
    var k=localStorage.key(i);
    // Show only keys that belong to this app
    if(k&&(k===STORAGE_KEY||k===GLOBAL_KEY||k.startsWith('bm_')||k===CLUB_CODE_LS)) keys.push(k);
  }
  var gd=loadGlobal();
  var knownKeys={'bm_state':'BadmintonDraw v1 旧データ（不要な場合は削除可）'};
  knownKeys[STORAGE_KEY]='【現在のプロジェクト】アクティブなプロジェクトのデータ（自動管理・削除不要）';
  knownKeys[GLOBAL_KEY]='【プロジェクト一覧】年度一覧と設定。削除すると全プロジェクトが消える。';
  knownKeys[CLUB_CODE_LS]='【入室コード】この端末に保存されたコード。削除すると次回再入力が必要。';
  knownKeys['bm_admin_local']='【端末認証】この端末のメンバーID。削除すると管理者権限が失われる。';
  knownKeys['bm_state']='【旧バージョン】v1データ。v2インポート済みなら削除可。';
  if(gd) gd.projects.forEach(function(p){
    knownKeys[getProjectKey(p.id)]='【プロジェクト】「'+p.name+'」のメンバー・試合・設定データ'+(p.id===gd.currentId?' ←現在使用中':'');
  });
  var knownKeys=knownKeys;
  const totalSize=keys.reduce((s,k)=>{
    try{ return s+(localStorage.getItem(k)||'').length; }catch(e){ return s; }
  },0);
  let html=`<div style="font-size:11px;color:var(--text3);margin-bottom:8px">使用量: 約${(totalSize/1024).toFixed(1)} KB / 5120 KB</div>`;
  html+=`<div class="prog-bar" style="margin-bottom:12px"><div class="prog-fill" style="width:${Math.min(totalSize/51200*100,100).toFixed(1)}%;background:${totalSize>40000?'var(--red)':totalSize>25000?'var(--orange)':'var(--accent)'}"></div></div>`;
  if(keys.includes('bm_state')){
    html+=`<div style="background:var(--orange-a);border:1px solid var(--orange);border-radius:var(--r2);padding:9px 12px;font-size:12px;color:var(--orange);margin-bottom:8px">⚠️ 旧バージョンのデータ(bm_state)が見つかりました。<button class="btn warn xs" style="margin-left:8px" onclick="migrateOldData()">v1からインポート</button> <button class="btn danger xs" style="margin-left:4px" onclick="deleteStorageKey('bm_state')">削除</button></div>`;
  }
  html+=keys.map(k=>{
    let size=0;
    try{ size=(localStorage.getItem(k)||'').length; }catch(e){}
    const desc=knownKeys[k]||'他のアプリまたは不明なデータ';
    const isOurs=k===STORAGE_KEY;
    const isSuspect=!isOurs&&!knownKeys[k];
    return `<div class="storage-row">
      <div>
        <div class="storage-key">${escH(k)}</div>
        <div class="storage-desc">${escH(desc)}</div>
        <div class="storage-size">約 ${(size/1024).toFixed(1)} KB</div>
      </div>
      ${!isOurs?`<button class="btn danger xs" onclick="deleteStorageKey('${escH(k)}')">削除</button>`:''}
      ${isSuspect?'<span style="font-size:10px;color:var(--orange);margin-top:2px">⚠️ 不明</span>':''}
    </div>`;
  }).join('');
  document.getElementById('storage-list').innerHTML=html;
}
function deleteStorageKey(key){
  const isOurs=key===STORAGE_KEY;
  const isOld=key==='bm_state';
  let warn;
  if(isOurs) warn='このアプリのメインデータです。削除しないことを強くお勧めします。';
  else if(isOld) warn='v1の旧データです。v2インポート済みなら削除できます。';
  else warn='他のアプリが使用している可能性があります。削除するとそのアプリが正常に動作しなくなる場合があります。';
  confirmDialog('キー削除: '+key, warn+'\n\n本当に削除しますか？元に戻せません。',
    function(){localStorage.removeItem(key); renderData(); toast('削除しました');},'削除する','danger');
}

function migrateOldData(){
  const raw=localStorage.getItem('bm_state');
  if(!raw){ toast('旧データが見つかりません'); return; }
  try{
    const old=JSON.parse(raw);
    // Migrate members
    let imported=0;
    (old.members||[]).forEach(om=>{
      if(S.members.some(m=>m.name===om.name)) return;
      const lvl=S.levels.find(l=>l.name===(om.level==='hard'?'強':om.level==='easy'?'弱':'普通'))||S.levels[0];
      S.members.push({
        id:S.nextId++, name:om.name, levelId:lvl?.id, groupId:null,
        type:'regular', year:CURRENT_YEAR, comment:'v1からインポート',
        totalGames:om.games||0, sessions:[], lastDate:null,
        status:'active', createdAt:Date.now(), consecutiveGames:0, lastWaitStart:Date.now()
      });
      imported++;
    });
    save(); renderData(); renderMembers();
    toast(`${imported}人のメンバーをインポートしました`);
  }catch(e){ toast('インポートエラー: '+e.message); }
}
function cleanOldStorage(){
  const toDelete=[];
  for(let i=0;i<localStorage.length;i++){
    const k=localStorage.key(i);
    if(k&&k!==STORAGE_KEY&&k.startsWith('bm_')) toDelete.push(k);
  }
  if(!toDelete.length){ toast('削除対象の旧データはありません'); return; }
  confirmDialog('旧データ削除','削除対象: '+toDelete.join(', ')+'\n\nv1データをv2にインポート済みの場合のみ削除してください。',
    function(){toDelete.forEach(function(k){localStorage.removeItem(k);}); renderData(); toast(toDelete.length+'件削除しました');},'削除する','danger');
}

function exportBackup(){
  const data=JSON.stringify(S, null, 2);
  const blob=new Blob([data],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  const d=new Date();
  a.href=url;
  a.download=`badminton_backup_${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('エクスポートしました');
}
function triggerImport(){ document.getElementById('import-file').click(); }
function importBackup(e){
  const file=e.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=ev=>{
    try{
      const data=JSON.parse(ev.target.result);
      if(!data.members||!data.settings){ toast('無効なバックアップファイルです'); return; }
      confirmDialog('データ復元',`バックアップを復元しますか？現在のデータは上書きされます。(メンバー: ${data.members.length}人)`,()=>{
        S=Object.assign({},S,data);
        if(!S.levels||!S.levels.length) S.levels=defaultLevels();
        if(!S.groups||!S.groups.length) S.groups=defaultGroups();
        if(!S.settings.faceThresholds||!S.settings.faceThresholds.length) S.settings.faceThresholds=defaultFaces();
        syncCourts();
        save(); renderAll(); toast('復元しました ✅');
      });
    }catch(err){ toast('読み込みエラー: '+err.message); }
  };
  reader.readAsText(file);
  e.target.value='';
}
function resetAllData(){
  confirmDialog('全データリセット 第1段階',
    '【警告】この操作は元に戻せません。\n\nメンバー・成績・設定など全データが完全に削除されます。\n\n操作前にデータタブからエクスポートを強くお勧めします。\n\n本当に続けますか？',
    function(){
      confirmDialog('最終確認 本当に削除しますか？',
        '全データを完全に削除します。\nこの操作は取り消せません。',
        function(){
          localStorage.removeItem(STORAGE_KEY);
          S={version:APP_VERSION,members:[],levels:defaultLevels(),groups:defaultGroups(),todayParticipants:[],todayDate:null,courts:[],history:[],nextId:1,sessions:[],settings:{courtCount:2,levelMatch:false,consecLimit:false,consecMax:2,waitPriority:true,courtLevels:{},levelConsec:{},faceThresholds:defaultFaces()},memberSort:'group',memberYear:CURRENT_YEAR,swapMode:{active:false,source:null}};
          syncCourts(); save(); renderAll(); toast('全データをリセットしました');
        },'削除する','danger');
    },'続ける','warn');
}

/* ============================================================
   SETTINGS
============================================================ */
function openSettingsModal(){
  updateClubCodeDisplay();
  const s=S.settings;
  document.getElementById('s-court-count').value=s.courtCount;
  document.getElementById('s-level-match').checked=s.levelMatch;
  document.getElementById('s-wait-prio').checked=s.waitPriority;
  renderCourtLevelRows();
  renderLevelConsecRows();
  renderFaceSettings();
  // Opens via openModal which calls this as setup
}
function renderLevelConsecRows(){
  var lvls=sortedLevels();
  var lc=S.settings.levelConsec||{};
  document.getElementById('level-consec-rows').innerHTML=lvls.map(function(l){
    var cfg=lc[l.id]||{enabled:false,maxGames:2,intervalMin:0};
    return '<div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--r2);padding:10px 12px;margin-bottom:6px">'
      +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">'
      +'<div style="width:10px;height:10px;border-radius:50%;background:'+l.color+';flex-shrink:0"></div>'
      +'<span style="font-size:13px;font-weight:600;color:'+l.color+';flex:1">'+escH(l.name)+'</span>'
      +'<label class="toggle"><input type="checkbox" id="lc-en-'+l.id+'" '+(cfg.enabled?'checked':'')
      +' onchange="saveLevelConsec('+l.id+')"><span class="toggle-track"></span></label>'
      +'</div>'
      +'<div style="display:flex;gap:10px;flex-wrap:wrap">'
      +'<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text3)">'
      +'連続上限<input type="number" class="num-inp" id="lc-max-'+l.id+'" value="'+cfg.maxGames+'" min="1" max="20" style="width:48px" onchange="saveLevelConsec('+l.id+')">試合</div>'
      +'<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text3)">'
      +'インターバル<input type="number" class="num-inp" id="lc-int-'+l.id+'" value="'+cfg.intervalMin+'" min="0" max="120" style="width:48px" onchange="saveLevelConsec('+l.id+')">分</div>'
      +'</div></div>';
  }).join('');
}
function saveLevelConsec(levelId){
  if(!S.settings.levelConsec) S.settings.levelConsec={};
  var enEl=document.getElementById('lc-en-'+levelId);
  var maxEl=document.getElementById('lc-max-'+levelId);
  var intEl=document.getElementById('lc-int-'+levelId);
  if(!enEl||!maxEl||!intEl) return;
  S.settings.levelConsec[levelId]={
    enabled:enEl.checked,
    maxGames:parseInt(maxEl.value)||2,
    intervalMin:parseInt(intEl.value)||0
  };
  save();
}
function renderCourtLevelRows(){
  const n=parseInt(document.getElementById('s-court-count').value)||S.settings.courtCount;
  document.getElementById('court-level-rows').innerHTML=Array.from({length:n},(_,i)=>{
    const cid=i+1;
    const cur=S.settings.courtLevels[cid]||'any';
    return `<div class="set-row">
      <div class="set-row-lbl">コート${cid}</div>
      <select class="field sm" style="width:100px" onchange="saveCourtLevel(${cid},this.value)">
        <option value="any" ${cur==='any'?'selected':''}>指定なし</option>
        ${sortedLevels().map(l=>`<option value="${l.id}" ${cur==l.id?'selected':''}>${escH(l.name)}</option>`).join('')}
      </select>
    </div>`;
  }).join('');
}
function saveCourtLevel(id,val){
  S.settings.courtLevels[id]=val; save();
}
function saveCoreSettings(){
  const s=S.settings;
  s.courtCount=Math.max(1,Math.min(6,parseInt(document.getElementById('s-court-count').value)||2));
  s.levelMatch=document.getElementById('s-level-match').checked;
  s.waitPriority=document.getElementById('s-wait-prio').checked;
  syncCourts(); save();
  renderCourtLevelRows(); renderCourts();
}
function renderFaceSettings(){
  const faces=S.settings.faceThresholds||defaultFaces();
  document.getElementById('face-settings-rows').innerHTML=faces.map(function(f,i){
    return '<div class="face-row">'
      +'<div class="face-row-icon">'+f.face+'</div>'
      +'<div class="face-row-info">'
      +'<div>'+escH(f.label)+'</div>'
      +'<div class="face-row-thresh">'+(i===faces.length-1?'0試合以下から':'試合数 ≥ ')
      +'<input type="number" class="num-inp" value="'+f.games+'" min="0" max="99" style="width:48px" onchange="saveFaceThreshold('+i+',this.value)">'
      +'</div></div>'
      +'<input type="text" class="field sm" value="'+escH(f.face)+'" maxlength="2" style="width:44px;text-align:center" placeholder="😊" onchange="saveFaceEmoji('+i+',this.value)">'
      +'</div>';
  }).join('');
}
function saveFaceThreshold(i,v){
  if(S.settings.faceThresholds[i]) S.settings.faceThresholds[i].games=parseInt(v)||0;
  save();
}
function saveFaceEmoji(i,v){
  if(S.settings.faceThresholds[i]) S.settings.faceThresholds[i].face=v||'😊';
  save();
}

/* ============================================================
   HISTORY (undo)
============================================================ */
function pushHistory(){
  S.history.push(JSON.parse(JSON.stringify({courts:S.courts,members:S.members.map(m=>({...m}))})));
  if(S.history.length>20) S.history.shift();
}
function undoLast(){
  if(!S.history.length){ toast('これ以上戻れません'); return; }
  const prev=S.history.pop();
  S.courts=prev.courts; S.members=prev.members;
  save(); renderCourts(); renderWaiting(); renderMembers(); toast('元に戻しました');
}

/* ============================================================
   MODAL SYSTEM
============================================================ */
function openModal(id){
  if(!enforceClubCodeGuard(function(){ openModal(id); })) return;
  document.getElementById(id).classList.add('open');
  if(id==='modal-settings') openSettingsModal();
  if(id==='modal-groups') renderGroupsModal();
  if(id==='modal-levels') renderLevelsModal();
  if(id==='modal-project') renderProjectList();
  if(id==='modal-draw-officer') { /* modal-bd opens via classList.add('open') below */ }
  if(id==='modal-admin'){ openAdminModal(); }
  if(id==='modal-identity'){ renderIdentityChips(); }
}
function closeModal(id){ document.getElementById(id).classList.remove('open'); }
function closeBgModal(e,id){ if(e.target===document.getElementById(id)) closeModal(id); }

/* ============================================================
   CONFIRM DIALOG
============================================================ */
let _confirmCallback=null;
function confirmDialog(title,msg,cb,okLabel,okStyle){
  okLabel=okLabel||'削除'; okStyle=okStyle||'danger';
  var _t=document.getElementById('confirm-title');
  var _m=document.getElementById('confirm-msg');
  var _b=document.getElementById('confirm-ok-btn');
  var _o=document.getElementById('confirm-overlay');
  if(!_t||!_m||!_b||!_o){
    if(window.confirm(title+'\n\n'+msg)){if(cb)cb();}
    return;
  }
  _t.textContent=title;
  _m.innerHTML=msg.replace(/\n/g,'<br>');
  _b.textContent=okLabel;
  _b.className='btn '+okStyle;
  _confirmCallback=cb;
  document.getElementById('confirm-overlay').classList.add('open');
}
function confirmOk(){
  document.getElementById('confirm-overlay').classList.remove('open');
  if(_confirmCallback){ _confirmCallback(); _confirmCallback=null; }
}
function confirmCancel(){
  document.getElementById('confirm-overlay').classList.remove('open');
  _confirmCallback=null;
}

/* ============================================================
   TOAST
============================================================ */
function toast(msg){
  var t=document.getElementById('toast'); if(!t) return;
  t.textContent=msg; t.classList.add('on');
  clearTimeout(t._t);
  t._t=setTimeout(function(){ t.classList.remove('on'); },2600);
}

/* ============================================================
   UTILITIES
============================================================ */
function escH(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function getInitial(name){ return String(name||'?').charAt(0).toUpperCase(); }

/* ============================================================
   RENDER ALL
============================================================ */
function goToIdentityFromAdmin(){
  closeModal('modal-admin'); openIdentityModal();
}
function closeAllModals(){
  document.querySelectorAll('.modal-bd').forEach(function(el){ el.classList.remove('open'); });
  var _co=document.getElementById('confirm-overlay'); if(_co) _co.classList.remove('open');
}
function renderAll(){
  if(!document.getElementById('courts-container')) return;
  try{
    renderCourts(); renderWaiting(); renderMembers(); renderToday(); renderTodayRanking();
    if(currentTab==='history') renderHistory();
    if(currentTab==='data') renderData();
    updateCurrentProjectBadge();
  }catch(e){ console.error('renderAll error:',e); }
}

/* ============================================================
   IDENTITY / SELF-RECOGNITION (PIN AUTH)
============================================================ */
function getMyMember(){
  var lid=getLocalMemberId(); if(!lid) return null;
  return S.members.find(function(m){return m.id===parseInt(lid);})||null;
}
function hasIdentity(){ return !!getMyMember(); }
function updateIdentityPill(){
  var btn=document.getElementById('id-pill-btn'); if(!btn) return;
  var me=getMyMember();
  if(me){
    var lvl=getLevelById(me.levelId);
    btn.innerHTML='<span style="font-family:var(--disp);font-size:14px;font-weight:700;color:'+lvl.color+'">'+getInitial(me.name)+'</span>';
    btn.title=escH(me.name)+'（自分）';
    btn.style.background=lvl.color+'22';
    btn.style.borderColor=lvl.color;
  } else {
    btn.innerHTML='👤';
    btn.title='自分を設定してください';
    btn.style.background='var(--orange-a)';
    btn.style.borderColor='var(--orange)';
  }
}
function buildPinBtn(mid,hasPinSet){
  var fn='openPinModal('+JSON.stringify('setup')+','+mid+')';
  if(hasPinSet) return '<button class="btn ghost xs" onclick="'+fn+'" style="margin-left:8px">🔑 PIN変更</button>';
  return '<button class="btn warn xs" onclick="'+fn+'" style="margin-left:8px">🔑 PINを設定</button>';
}
function openIdentityModal(){
  // If club code protection is active and not satisfied, force code-entry instead
  if(!hasValidCode()){
    try{ closeAllModals(); showCodeEntry(); }catch(e){}
    return;
  }
  var me=getMyMember();
  var el=document.getElementById('identity-current'); if(el){
    if(me){
      var lvl=getLevelById(me.levelId);
      el.innerHTML='現在: <b style="color:'+lvl.color+'">'+escH(me.name)+'</b>'+(me.pin?' <span style="color:var(--green);font-size:10px">🔑 PIN設定済</span>':' <span style="color:var(--orange);font-size:10px">⚠️ PIN未設定</span>');
      document.getElementById('identity-clear-area').style.display='block';
    } else {
      el.innerHTML='<span style="color:var(--orange)">⚠️ 自分がまだ設定されていません</span>';
      document.getElementById('identity-clear-area').style.display='none';
    }
  }
  renderIdentityChips();
  openModal('modal-identity');
}
function renderIdentityChips(){
  var lid=getLocalMemberId();
  var members=S.members.filter(function(m){return (m.year||CURRENT_YEAR)===CURRENT_YEAR;});
  var el=document.getElementById('identity-member-chips'); if(!el) return;
  el.innerHTML=members.map(function(m){
    var isMe=(lid&&parseInt(lid)===m.id);
    var lvl=getLevelById(m.levelId);
    return '<span class="part-chip '+(isMe?'on':'')+'" onclick="selectMyIdentity('+m.id+')" style="'+(isMe?'border-color:'+lvl.color+';background:'+lvl.color+'22;color:'+lvl.color:'')+'">'
      +'<span style="width:18px;height:18px;border-radius:50%;background:'+lvl.color+'22;color:'+lvl.color+';display:inline-flex;align-items:center;justify-content:center;font-family:var(--disp);font-size:9px;font-weight:700">'+getInitial(m.name)+'</span>'
      +escH(m.name)+(isMe?' ✓':'')+(m.pin?' 🔑':'')+'</span>';
  }).join('');
}
function selectMyIdentity(memberId){
  var m=S.members.find(function(x){return x.id===memberId;}); if(!m) return;
  if(m.pin) openPinModal('verify',memberId);
  else openPinModal('setup',memberId);
}
function clearMyIdentity(){
  confirmDialog('設定を解除','この端末の「自分」設定を解除しますか？',
    function(){ setLocalMemberId(null); closeModal('modal-identity'); updateIdentityPill(); applyAdminUI(); toast('解除しました'); },'解除','danger');
}
function openNewMemberAsMe(){
  closeModal('modal-identity');
  _afterMemberSave=function(id){
    if(!id) return;
    var m=S.members.find(function(x){return x.id===id;}); if(!m) return;
    openPinModal('setup',id);
  };
  openAddMemberModal();
}
function renderSelfBtn(memberId){
  var lid=getLocalMemberId();
  var isMe=(lid&&parseInt(lid)===memberId);
  if(isMe){
    return '<div class="ico-btn" style="color:var(--accent);border-color:var(--accent);background:var(--accent-a);font-size:10px;font-weight:700" title="これはあなた" onclick="openIdentityModal()">私✓</div>';
  }
  return '<div class="ico-btn" style="font-size:10px;color:var(--text3)" title="これが自分?" onclick="selectMyIdentity('+memberId+')">私?</div>';
}
function checkFirstTimeIdentity(){
  // If club code protection is active and not satisfied, do not prompt identity yet
  if(!hasValidCode() || window._clubCodeCheckPending) return;
  if(!hasIdentity()&&S.members.length>0){
    var btn=document.getElementById('id-pill-btn');
    if(btn){ btn.style.background='var(--orange-a)'; btn.style.borderColor='var(--orange)'; }
    setTimeout(function(){ openIdentityModal(); },600);
  }
}
/* ---- PIN ---- */
var _pin={mode:'',mid:0,digits:[],first:[]};
function openPinModal(mode,memberId){
  _pin={mode:mode,mid:memberId,digits:[],first:[]};
  var m=S.members.find(function(x){return x.id===memberId;});
  var nm=m?escH(m.name):'';
  document.getElementById('pin-modal-title').textContent=
    mode==='setup'?'PINを設定 — '+nm:mode==='verify'?'PIN入力 — '+nm:'PIN';
  document.getElementById('pin-modal-sub').textContent=
    mode==='setup'?'4桁のPINを設定してください':mode==='verify'?'PINを入力してください':'';
  document.getElementById('pin-error').textContent='';
  updatePinDots();
  openModal('modal-pin');
}
function updatePinDots(){
  for(var i=0;i<4;i++){
    var d=document.getElementById('pd'+i);
    if(d) d.className='pin-dot'+(_pin.digits.length>i?' filled':'');
  }
}
function pinKey(n){
  if(_pin.digits.length>=4) return;
  _pin.digits.push(n); updatePinDots();
  if(_pin.digits.length===4) setTimeout(pinComplete,150);
}
function pinBackspace(){ if(_pin.digits.length>0){_pin.digits.pop();updatePinDots();} }
function pinCancel(){ _pin={mode:'',mid:0,digits:[],first:[]}; closeModal('modal-pin'); }
function pinComplete(){
  var code=_pin.digits.join('');
  var m=S.members.find(function(x){return x.id===_pin.mid;}); if(!m) return;
  if(_pin.mode==='verify'){
    if(m.pin===code){
      setLocalMemberId(m.id); closeModal('modal-pin'); closeModal('modal-identity');
      updateIdentityPill(); applyAdminUI(); toast(escH(m.name)+'として設定しました ✅');
    } else {
      document.getElementById('pin-error').textContent='PINが違います';
      _pin.digits=[]; updatePinDots();
      setTimeout(function(){document.getElementById('pin-error').textContent='';},1500);
    }
  } else if(_pin.mode==='setup'){
    if(_pin.first.length===0){
      _pin.first=_pin.digits.slice(); _pin.digits=[];
      document.getElementById('pin-modal-sub').textContent='もう一度同じPINを入力（確認）';
      updatePinDots();
    } else {
      if(_pin.first.join('')===code){
        m.pin=code; save();
        setLocalMemberId(m.id); closeModal('modal-pin'); closeModal('modal-identity');
        updateIdentityPill(); applyAdminUI(); toast(escH(m.name)+'を設定しました 🔑');
      } else {
        document.getElementById('pin-error').textContent='PINが一致しません。最初からやり直してください';
        _pin.digits=[]; _pin.first=[];
        document.getElementById('pin-modal-sub').textContent='4桁のPINを設定してください';
        updatePinDots();
      }
    }
  }
}

/* ============================================================
   ADMIN / PERMISSION SYSTEM
============================================================ */
var ADMIN_KEY='bm_admin_local'; // stores local member id claim

function getLocalMemberId(){
  try{ return localStorage.getItem(ADMIN_KEY)||null; }catch(e){ return null; }
}
function setLocalMemberId(id){
  try{ if(id) localStorage.setItem(ADMIN_KEY,String(id)); else localStorage.removeItem(ADMIN_KEY); }catch(e){}
}
function isAdmin(){
  // Admin if: local member id is in adminIds
  // adminIds が空 = セットアップ未完了 → 最初のセットアップ時のみ全員操作可 (doInit で限定)
  if(!S.adminIds||S.adminIds.length===0) {
    // 初回セットアップ時のみ許可（詳細は initFirstSetup で制御）
    return window._allowOpenMode===true;
  }
  var lid=getLocalMemberId();
  return lid&&S.adminIds.includes(parseInt(lid));
}
function requireAdmin(){
  if(!isAdmin()){ toast('この操作には管理者権限が必要です'); return false; } return true;
}
function applyAdminUI(){
  // Show/hide admin-only elements based on permission
  var admin=isAdmin();
  var adminEls=['admin-member-btns','admin-today-btns'];
  adminEls.forEach(function(id){
    var el=document.getElementById(id); if(el) el.style.opacity=admin?'1':'0.4';
  });
  // Disable admin-only buttons for non-admins (except admin modal button itself)
  var adminBtns=document.querySelectorAll('[data-admin-only]');
  adminBtns.forEach(function(btn){ btn.disabled=!admin; });
}

// Admin modal
var _adminSelIds=[];
function openAdminModal(){
  _adminSelIds=[...(S.adminIds||[])];
  var me=getMyMember();
  var adminPart=S.adminIds&&S.adminIds.length>0
    ?(isAdmin()?'✅ あなたは管理者です':'👀 あなたは閲覧者です（管理者のみ操作可能）')
    :'🔓 管理者未設定（全員が操作可能）';
  var mePart=me
    ?('端末: <b>'+escH(me.name)+'</b>'+(me.pin?' 🔑':''))
    :'端末: <span style="color:var(--orange)">未設定</span>'
     +'<button class="btn warn xs" style="margin-left:6px" onclick="goToIdentityFromAdmin()">👤 設定する</button>';
  document.getElementById('admin-current-status').innerHTML=adminPart+'<br>'+mePart;
  renderAdminMemberList();
}
function renderAdminMemberList(){
  var members=S.members.filter(function(m){return (m.year||CURRENT_YEAR)===CURRENT_YEAR;});
  var lid=getLocalMemberId();
  document.getElementById('admin-member-list').innerHTML=members.map(function(m){
    var sel=_adminSelIds.includes(m.id);
    var lvl=getLevelById(m.levelId);
    var isSelf=(lid&&parseInt(lid)===m.id);
    return '<span class="part-chip '+(sel?'on':'')+'" onclick="toggleAdminSelect('+m.id+')" style="'+(sel?'border-color:'+lvl.color+';background:'+lvl.color+'22;color:'+lvl.color:'')+'">'
      +'<span style="width:18px;height:18px;border-radius:50%;background:'+lvl.color+'22;color:'+lvl.color+';display:inline-flex;align-items:center;justify-content:center;font-family:var(--disp);font-size:9px;font-weight:700">'+getInitial(m.name)+'</span>'
      +escH(m.name)
      +(isSelf?'<span style="font-size:8px;color:var(--yellow)">(自分)</span>':'')
      +'</span>';
  }).join('');
}
function toggleAdminSelect(id){
  var idx=_adminSelIds.indexOf(id);
  if(idx>=0) _adminSelIds.splice(idx,1); else _adminSelIds.push(id);
  renderAdminMemberList();
}
function saveAdminSettings(){
  S.adminIds=[..._adminSelIds];
  // If current local member is newly set as admin, register
  if(_adminSelIds.length>0){
    var lid=getLocalMemberId();
    if(!lid){
      // Prompt user to identify themselves
      toast('設定を保存しました。「自分」を選択して端末登録してください');
    }
  }
  save(); closeModal('modal-admin');
  // 管理者が設定されたので、オープンモードを終了
  window._allowOpenMode=false;
  // Firebase に管理者 ID を保存（他の端末と同期）
  if(fbConnected&&fbDb){
    try{
      var ts=Date.now(); fbLastPush=ts;
      firebase.database(fbApp).ref(fbGetPath()).update({adminIds:S.adminIds,_ts:ts})
        .catch(function(e){ console.warn('Failed to push adminIds:',e); });
    }catch(ex){}
  }
  applyAdminUI();
  updateAdminHeader();
  toast('運営管理設定を保存しました（Firebase 同期中）');
}
function claimAdminIdentity(memberId){
  setLocalMemberId(memberId);
  applyAdminUI();
  updateAdminHeader();
}
function updateAdminHeader(){
  // Update admin status indicator in header if needed
}

// Year navigation in header
function prevProject(){
  if(!enforceClubCodeGuard(function(){ prevProject(); })) return;
  var g=loadGlobal(); if(!g||g.projects.length<=1) return;
  var idx=g.projects.findIndex(function(p){return p.id===g.currentId;});
  if(idx>0) switchProject(g.projects[idx-1].id);
}
function nextProject(){
  if(!enforceClubCodeGuard(function(){ nextProject(); })) return;
  var g=loadGlobal(); if(!g||g.projects.length<=1) return;
  var idx=g.projects.findIndex(function(p){return p.id===g.currentId;});
  if(idx<g.projects.length-1) switchProject(g.projects[idx+1].id);
}
function updateHeaderProjectNav(){
  var g=loadGlobal(); if(!g) return;
  var el=document.getElementById('hdr-proj-name');
  if(el){
    var p=getCurrentProject();
    el.textContent=p?p.name:'';
  }
  var idx=g.projects.findIndex(function(p){return p.id===g.currentId;});
  var prevBtn=document.getElementById('hdr-prev-proj');
  var nextBtn=document.getElementById('hdr-next-proj');
  if(prevBtn) prevBtn.style.opacity=idx>0?'1':'0.3';
  if(nextBtn) nextBtn.style.opacity=idx<g.projects.length-1?'1':'0.3';
}
function openNewProjectQuick(){
  if(!enforceClubCodeGuard(function(){ openNewProjectQuick(); })) return;
  var d=new Date(); var nextYear=d.getFullYear()+1;
  document.getElementById('quick-proj-name').value=nextYear+'年度';
  openModal('modal-newproj-quick');
}
function createProjectFromQuick(){
  var name=document.getElementById('quick-proj-name').value.trim();
  if(!name){ toast('年度名を入力してください'); return; }
  var opt=document.querySelector('input[name="qproj-opt"]:checked');
  // Temporarily set new-proj-name for reuse of createNewProject logic
  document.getElementById('new-proj-name').value=name;
  document.querySelectorAll('input[name="proj-member-opt"]').forEach(function(r){
    r.checked=(r.value===(opt?opt.value:'inherit'));
  });
  closeModal('modal-newproj-quick');
  createNewProject();
}

/* ============================================================
   SECURITY: CLUB CODE（入室コード）
============================================================ */
var CLUB_CODE_LS='bm_club_code';
function getStoredCode(){try{return localStorage.getItem(CLUB_CODE_LS)||window._storedClubCodeFallback||'';}catch(e){return window._storedClubCodeFallback||'';}}
function setStoredCode(c){try{localStorage.setItem(CLUB_CODE_LS,c);}catch(e){/* will fall back to in-memory storage */} window._storedClubCodeFallback = c || '';}
function getClubCode(){var g=loadGlobal();return(g&&g.clubCode)?g.clubCode:'';}
function hasValidCode(){var code=getClubCode();if(!code)return true;return getStoredCode()===code;}
function hideStartupOverlay(){
  var ov=document.getElementById('startup-overlay'); if(ov) ov.style.display='none';
}
function showStartupOverlay(message){
  var ov=document.getElementById('startup-overlay');
  if(ov){ ov.style.display='flex'; var txt=document.getElementById('startup-overlay-text'); if(txt) txt.textContent=message||'入室コードを確認しています…'; return; }
  var div=document.createElement('div'); div.id='startup-overlay'; div.style.cssText='position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.96);display:flex;align-items:center;justify-content:center;padding:20px;';
  div.innerHTML='<div style="width:100%;max-width:320px;background:rgba(20,24,32,0.95);border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:28px 20px;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,.4);">'
    +'<div style="font-size:38px;line-height:1;margin-bottom:14px">🏸</div>'
    +'<div style="font-family:var(--disp);font-size:20px;font-weight:700;color:#fff;margin-bottom:10px">Tachibana Badminton</div>'
    +'<div id="startup-overlay-text" style="font-size:13px;color:#ddd;line-height:1.5;">'+(message||'入室コードを確認しています…')+'</div>'
    +'</div>';
  document.body.appendChild(div);
}
function showCodeEntry(cb){
  hideStartupOverlay();
  var existing=document.getElementById('code-overlay');
  if(existing){
    if(cb && !window._codeCb) window._codeCb = cb;
    existing.remove();
  }
  closeAllModals();
  var ov=document.createElement('div');ov.id='code-overlay';
  ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  ov.innerHTML='<div style="background:var(--bg2);border:1px solid var(--accent);border-radius:18px;padding:30px 20px;width:100%;max-width:300px;text-align:center">'
    +'<div style="font-size:40px;margin-bottom:12px">🏸</div>'
    +'<div style="font-family:var(--disp);font-size:22px;font-weight:700;color:var(--accent);margin-bottom:6px">Tachibana Badminton</div>'
    +'<div style="font-size:11px;color:var(--text3);margin-bottom:18px">入室コードを入力してください</div>'
    +'<input id="ci" type="text" placeholder="コードを入力" maxlength="20" autocomplete="off" style="width:100%;padding:13px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:16px;text-align:center;outline:none;margin-bottom:6px;box-sizing:border-box">'
    +'<div id="ce" style="color:var(--red);font-size:11px;margin-bottom:10px;min-height:14px"></div>'
    +'<button onclick="tryCode()" style="width:100%;padding:14px;background:var(--accent);border:none;border-radius:8px;color:#000;font-size:15px;font-weight:700;cursor:pointer">入室する</button>'
    +'</div>';
  document.body.appendChild(ov);
  window._codeCb = window._codeCb || cb || null;
  setTimeout(function(){var i=document.getElementById('ci');if(i){i.focus();i.onkeydown=function(e){if(e.key==='Enter')tryCode();};}},100);
}
function tryCode(){
  var inp=document.getElementById('ci');if(!inp)return;
  var val=inp.value.trim();var code=getClubCode();
  if(!code||val===code){
    setStoredCode(val);
    var ov=document.getElementById('code-overlay');if(ov)ov.remove();
    if(window._codeCb){window._codeCb(true);window._codeCb=null;}
  }else{
    var err=document.getElementById('ce');if(err)err.textContent='コードが違います';
    inp.value='';inp.focus();
  }
}
function fbSyncClubCode(){
  if(!fbConnected||!fbDb)return;
  try{firebase.database(fbApp).ref('meta/clubCode').on('value',function(snap){
    var code=snap.val()||'';var g=loadGlobal()||{projects:[],currentId:null};
    if(g.clubCode!==code){g.clubCode=code;saveGlobal(g);}
  });}catch(ex){}
}
function setClubCode(){
  if(!requireAdmin())return;
  var inp=document.getElementById('new-club-code');
  var code=inp?inp.value.trim():'';
  if(!code){toast('コードを入力してください');return;}
  var g=loadGlobal()||{projects:[],currentId:null};
  g.clubCode=code;saveGlobal(g);setStoredCode(code);
  if(fbConnected&&fbDb)firebase.database(fbApp).ref('meta/clubCode').set(code);
  inp.value='';updateClubCodeDisplay();
  toast('入室コードを設定しました: '+code);
}
function clearClubCode(){
  if(!requireAdmin())return;
  confirmDialog('入室コード解除','コードを解除すると誰でも入室できます。解除しますか？',function(){
    var g=loadGlobal()||{};g.clubCode='';saveGlobal(g);setStoredCode('');
    if(fbConnected&&fbDb)firebase.database(fbApp).ref('meta/clubCode').remove();
    updateClubCodeDisplay();toast('入室コードを解除しました');
  },'解除','danger');
}
function updateClubCodeDisplay(){
  var el=document.getElementById('club-code-disp');if(!el)return;
  var code=getClubCode();
  el.textContent=code?('設定済: '+code):'未設定（誰でも入室可能）';
  el.style.color=code?'var(--green)':'var(--orange)';
}

function confirmAllCourts(){
  if(!requireDrawOfficer()) return;
  pushHistory();
  var n=0, now=Date.now();
  S.courts.forEach(function(c){
    if(c.players&&!c.confirmed){
      c.players.forEach(function(pid){
        if(pid===null) return;
        var m=S.members.find(function(x){return x.id===pid;}); if(!m) return;
        m.totalGames++; m.consecutiveGames++;
        if(!m.todayGames) m.todayGames=0; m.todayGames++;
        m.lastWaitStart=null; m.lastDate=todayStr(); m.lastGameStartTime=now;
      });
      c.confirmed=true; n++;
    }
  });
  if(n>0){ save(); renderCourts(); renderWaiting(); renderTodayRanking(); toast(n+'コート 試合開始！ 🏸'); }
  else toast('開始できるコートがありません');
}
function finishAllCourts(){
  if(!requireDrawOfficer()) return;
  pushHistory();
  var n=0, now=Date.now();
  S.courts.forEach(function(c){
    if(c.players){
      if(c.confirmed){
        c.players.forEach(function(pid){
          if(pid===null) return;
          var m=S.members.find(function(x){return x.id===pid;}); if(!m) return;
          m.lastGameEndTime=now; m.lastWaitStart=now;
        });
      }
      c.players=null; c.confirmed=false; n++;
    }
  });
  if(n>0){ save(); renderCourts(); renderWaiting(); renderTodayRanking(); toast(n+'コート 試合終了'); }
  else toast('進行中のコートがありません');
}

function exportMembers(){
  // Export only member identity info (no game stats)
  var data={
    type:'bm_members_v2',
    exportedAt:new Date().toISOString(),
    projectName:(getCurrentProject()||{}).name||'',
    levels:S.levels,
    groups:S.groups,
    members:S.members.map(function(m){
      return {
        id:m.id, name:m.name, levelId:m.levelId, groupId:m.groupId,
        type:m.type, year:m.year, comment:m.comment||'',
        createdAt:m.createdAt||Date.now()
      };
    })
  };
  var blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='bm_members_'+new Date().toISOString().slice(0,10)+'.json';
  a.click(); URL.revokeObjectURL(a.href);
  toast('メンバー情報をエクスポートしました');
}
function importMembers(){
  confirmDialog(
    'メンバー情報読込み',
    '【注意】インポートすると現在のメンバー情報が上書きされます。\n\n'
    +'・試合数・成績はリセット（0）になります\n'
    +'・現在のデータは失われます\n\n'
    +'実行前に「📤 全データ書出し」でバックアップをおすすめします。\n\n'
    +'このまま続けますか？',
    function(){
      var inp=document.createElement('input');
      inp.type='file'; inp.accept='.json';
      inp.onchange=function(e){
        var file=e.target.files[0]; if(!file) return;
        var reader=new FileReader();
        reader.onload=function(ev){
          try{
            var d=JSON.parse(ev.target.result);
            if(d.type!=='bm_members_v2'){ toast('メンバーファイルではありません'); return; }
            if(d.levels&&d.levels.length) S.levels=d.levels;
            if(d.groups&&d.groups.length) S.groups=d.groups;
            S.members=d.members.map(function(m){
              return {
                id:m.id, name:m.name, levelId:m.levelId, groupId:m.groupId,
                type:m.type||'regular', year:m.year||CURRENT_YEAR,
                comment:m.comment||'', createdAt:m.createdAt||Date.now(),
                totalGames:0, consecutiveGames:0, todayGames:0,
                lastDate:null, lastWaitStart:Date.now(),
                status:'active', lastGameEndTime:null, lastGameStartTime:null
              };
            });
            S.nextId=Math.max.apply(null,S.members.map(function(m){return m.id;}).concat([0]))+1;
            save(); renderAll();
            toast(S.members.length+'人のメンバーを読み込みました（成績はリセット）');
          }catch(ex){ toast('ファイル読込みエラー: '+ex.message); }
        };
        reader.readAsText(file);
      };
      inp.click();
    }, '続ける', 'warn'
  );
}

/* ═══ DRAW OFFICER（抽選担当） ═══ */
function isDrawOfficer(){
  if(!S.drawOfficerId) return true;
  if(isAdmin()) return true;
  var lid=getLocalMemberId();
  return lid && parseInt(lid)===S.drawOfficerId;
}
function requireDrawOfficer(){
  if(!isDrawOfficer()){ toast('抽選担当または管理者のみ操作できます'); return false; }
  return true;
}
function setDrawOfficer(memberId){
  S.drawOfficerId=memberId?parseInt(memberId):null;
  save(); renderAll();
  var m=memberId?S.members.find(function(x){return x.id===parseInt(memberId);}):null;
  toast('抽選担当: '+(m?m.name:'解除（誰でも操作可）'));
}
function renderDrawOfficerBadge(){
  var el=document.getElementById('draw-officer-badge'); if(!el) return;
  var btn=document.getElementById('draw-officer-hdr-btn');
  if(!S.drawOfficerId){
    el.style.display='none';
    if(btn) btn.style.background='';
    return;
  }
  var m=S.members.find(function(x){return x.id===S.drawOfficerId;});
  el.style.display='block';
  el.textContent=(m?m.name:'?');
  if(btn) btn.style.background='var(--accent-a)';
}
function openDrawOfficerModal(){
  if(!enforceClubCodeGuard(function(){ openDrawOfficerModal(); })) return;
  var current=S.drawOfficerId;
  document.getElementById('draw-officer-list').innerHTML=S.members.map(function(m){
    var lvl=getLevelById(m.levelId);
    var isCur=(m.id===current);
    var sid=m.id;
    var style=isCur?'border-color:var(--accent);background:var(--accent-a);color:var(--accent)':'';
    return '<span class="part-chip '+(isCur?'on':'')+'" onclick="setDrawOfficer('+sid+');closeModal(\'modal-draw-officer\')" style="'+style+'">'
      +'<span style="width:18px;height:18px;border-radius:50%;background:'+lvl.color+'22;color:'+lvl.color+';display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:700">'+getInitial(m.name)+'</span>'
      +escH(m.name)+(isCur?' ✓':'')
      +'</span>';
  }).join('');
  document.getElementById('modal-draw-officer').classList.add('open');
}

/* ═══ Firebase Command Channel（全端末同期コマンド） ═══ */
function fbSendCommand(cmd, data){
  if(!fbConnected||!fbDb) return;
  var ts=Date.now(); fbLastPush=ts;
  firebase.database(fbApp).ref('command').set({cmd:cmd, data:data||{}, _ts:ts, by:getLocalMemberId()||'admin'});
}
function fbListenCommands(){
  if(!fbConnected||!fbDb) return;
  firebase.database(fbApp).ref('command').on('value',function(snap){
    var d=snap.val(); if(!d||!d.cmd) return;
    if(d._ts===fbLastPush) return; // our own echo
    if(d.cmd==='resetToday'){
      doResetToday();
      toast('管理者により本日データがリセットされました');
    } else if(d.cmd==='sessionStart'){
      if(d.data&&d.data.participants) S.todayParticipants=d.data.participants;
      if(d.data&&d.data.date) S.todayDate=d.data.date;
      save(); renderAll(); toast('セッションが開始されました');
    }
  });
}
function doResetToday(){
  todayPairHistory=[]; // ペア履歴リセット
  var today=todayStr();
  S.members.forEach(function(m){
    var todayCount=m.todayGames||0;
    m.totalGames=Math.max(0,(m.totalGames||0)-todayCount);
    m.consecutiveGames=0; m.todayGames=0;
    m.lastWaitStart=Date.now();
    m.lastGameEndTime=null; m.lastGameStartTime=null; m.status='active';
    if(m.lastDate===today){
      var prevSess=S.sessions.slice().reverse().find(function(s){
        return s.date!==today && s.participants && s.participants.includes(m.id);
      });
      m.lastDate=prevSess?prevSess.date:null;
    }
  });
  S.courts.forEach(function(c){ c.players=null; c.confirmed=false; });
  S.todayParticipants=[]; S.todayDate=null;
  save(); renderAll();
}

/* ═══ ペア自動組み替え ═══ */
var todayPairHistory=[]; // その日のペア履歴 [{a:id,b:id}]

function getLevelOrder(memberId){
  var m=S.members.find(function(x){return x.id===memberId;}); if(!m) return 0;
  var lvl=getLevelById(m.levelId);
  return lvl?lvl.order:0;
}
function pairKey(a,b){ return Math.min(a,b)+'-'+Math.max(a,b); }
function countPairs(a,b){ return todayPairHistory.filter(function(p){return pairKey(p.a,p.b)===pairKey(a,b);}).length; }

function autoSwapPairs(courtId){
  var c=S.courts.find(function(x){return x.id===courtId;});
  if(!c||!c.players||c.players.some(function(p){return p==null;})) return;
  var ids=c.players.slice(); // [p0,p1,p2,p3] - p0&p1 vs p2&p3
  // 各プレイヤーのレベルorder取得
  var orders=ids.map(getLevelOrder);
  // 最適ペアリング: なるべく異レベルを同チームに、かつ過去ペアが少ない組合せ
  // 6通りの組み合わせを試す
  var combos=[
    [[0,1],[2,3]], [[0,2],[1,3]], [[0,3],[1,2]]
  ];
  var best=null, bestScore=Infinity;
  combos.forEach(function(combo){
    var t1=combo[0], t2=combo[1];
    // スコア: レベル差（同チームは差が大きいほど良い=スコア小）+ ペア履歴ペナルティ
    var lvlDiff1=Math.abs(orders[t1[0]]-orders[t1[1]]);
    var lvlDiff2=Math.abs(orders[t2[0]]-orders[t2[1]]);
    var pairPenalty=countPairs(ids[t1[0]],ids[t1[1]])+countPairs(ids[t2[0]],ids[t2[1]]);
    // 異レベルが同チームになるほど良い（スコア低い）、ペア重複は悪い
    var score = (4-lvlDiff1) + (4-lvlDiff2) + pairPenalty*3;
    if(score<bestScore){ bestScore=score; best=combo; }
  });
  if(best){
    var t1=best[0], t2=best[1];
    c.players=[ids[t1[0]],ids[t1[1]],ids[t2[0]],ids[t2[1]]];
  }
}
function recordPairs(courtId){
  var c=S.courts.find(function(x){return x.id===courtId;});
  if(!c||!c.players) return;
  var ids=c.players.filter(function(p){return p!=null;});
  if(ids.length>=2) todayPairHistory.push({a:ids[0],b:ids[1]});
  if(ids.length>=4) todayPairHistory.push({a:ids[2],b:ids[3]});
}

/* ============================================================
   BOOT
============================================================ */
init();
