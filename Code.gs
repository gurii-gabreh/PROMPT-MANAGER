/**
 * ============================================================
 * PROMPT MANAGER — Google Apps Script
 * chapro.jp からプロンプトデータを取得し、スプレッドシートに保存
 * GitHub Pages HTML からのリクエストを受け取るWeb App
 *
 * 取得方式：1分おきトリガーで1件ずつ処理（GASの6分実行制限を
 * 回避するため、1回の実行を極小化し、時間をかけて薄く処理する）
 * ============================================================
 */

// ===== 設定 =====
const SHEET_PROMPTS   = 'プロンプト一覧';
const SHEET_HISTORY   = '生成履歴';
const SHEET_SETTINGS  = '設定';
const BASE_URL        = 'https://chapro.jp';

// ===== スクリプトプロパティキー =====
const PROP_SS_ID        = 'SPREADSHEET_ID';
const PROP_LAST_ID      = 'LAST_FETCHED_ID';
const PROP_PENDING      = 'PENDING_IDS';       // 詳細取得待ちのIDキュー
const PROP_COLLECT_PAGE = 'COLLECT_PAGE';      // ID一覧収集の再開ページ番号
const PROP_BACKLOG_DONE = 'BACKLOG_DONE';      // バックログ全件取得が完了したか（'true'/未設定）
const PROP_RUN_DATE     = 'RUN_DATE';          // 実行回数カウントの対象日（yyyy-MM-dd）
const PROP_RUN_COUNT    = 'RUN_COUNT';         // 対象日における実行回数

// ===== 1日の実行回数上限 =====
// GAS無料枠の「1日合計実行時間90分」を守るための上限。
// 1回の処理が約11秒として 90分(5400秒) ÷ 11秒 ≒ 490回。
const DAILY_RUN_LIMIT = 490;

// ===== User-Agent =====
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function fetchOptions() {
  return {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
    },
    muteHttpExceptions: true,
    followRedirects: true
  };
}

// ============================================================
// Web App エントリーポイント
// ============================================================
function doGet(e) {
  const action = e.parameter.action || '';
  try {
    let result;
    switch (action) {
      case 'getPrompts':  result = getPromptsFromSheet(e.parameter); break;
      case 'getHistory':  result = getHistoryFromSheet(); break;
      case 'saveHistory': result = saveHistoryToSheet(e.parameter); break;
      case 'getStats':    result = getStats(); break;
      case 'fetchNow':    result = fetchOneCycle(); break;
      default: result = { status: 'error', message: '不明なアクション: ' + action };
    }
    return buildResponse(result);
  } catch (err) {
    return buildResponse({ status: 'error', message: err.message });
  }
}

function buildResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// スプレッドシート初期化
// ============================================================
function initSpreadsheet() {
  const props = PropertiesService.getScriptProperties();
  let ssId = props.getProperty(PROP_SS_ID);
  if (!ssId) {
    const ss = SpreadsheetApp.create('PROMPT MANAGER');
    ssId = ss.getId();
    props.setProperty(PROP_SS_ID, ssId);
    Logger.log('スプレッドシート作成完了: ' + ss.getUrl());
    initSheet(ss);
    return ss;
  }
  return SpreadsheetApp.openById(ssId);
}

function initSheet(ss) {
  let sheet = ss.getActiveSheet();
  sheet.setName(SHEET_PROMPTS);
  sheet.clearContents();
  const promptHeaders = ['ID','タイトル','カテゴリ','プロンプト本文','説明','作者','投稿日','取得日時','URL'];
  sheet.getRange(1, 1, 1, promptHeaders.length).setValues([promptHeaders]);
  sheet.getRange(1, 1, 1, promptHeaders.length)
    .setBackground('#1a73e8').setFontColor('#ffffff').setFontWeight('bold');
  sheet.setFrozenRows(1);
  [80,250,150,400,250,120,100,150,200].forEach((w,i) => sheet.setColumnWidth(i+1, w));

  const historySheet = ss.insertSheet(SHEET_HISTORY);
  const historyHeaders = ['日時','対象AI','目的・要件','生成されたプロンプト','参考プロンプトID'];
  historySheet.getRange(1, 1, 1, historyHeaders.length).setValues([historyHeaders]);
  historySheet.getRange(1, 1, 1, historyHeaders.length)
    .setBackground('#34a853').setFontColor('#ffffff').setFontWeight('bold');
  historySheet.setFrozenRows(1);
  [150,120,200,400,150].forEach((w,i) => historySheet.setColumnWidth(i+1, w));

  const settingsSheet = ss.insertSheet(SHEET_SETTINGS);
  settingsSheet.getRange('A1:B1').setValues([['キー','値']]);
  settingsSheet.getRange('A1:B1')
    .setBackground('#fbbc04').setFontColor('#000000').setFontWeight('bold');
  settingsSheet.getRange('A2:B5').setValues([
    ['lastFetchedAt',''],
    ['totalCount','0'],
    ['autoFetchEnabled','ON'],
    ['pendingCount','0'],
  ]);
  settingsSheet.setFrozenRows(1);
  Logger.log('全シート初期化完了');
}

// ============================================================
// ヘッダー行チェック＆復元（データ保存前に毎回確認）
// ============================================================
const PROMPT_HEADERS = ['ID','タイトル','カテゴリ','プロンプト本文','説明','作者','投稿日','取得日時','URL'];

function ensureHeaderRow(sheet) {
  const firstCell = sheet.getRange(1, 1).getValue();
  if (firstCell !== 'ID') {
    Logger.log('⚠️ ヘッダー行が見つかりません。復元します。');
    if (sheet.getLastRow() > 0 && firstCell !== '' && firstCell !== 'ID') {
      sheet.insertRowBefore(1);
    }
    sheet.getRange(1, 1, 1, PROMPT_HEADERS.length).setValues([PROMPT_HEADERS]);
    sheet.getRange(1, 1, 1, PROMPT_HEADERS.length)
      .setBackground('#1a73e8').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setFrozenRows(1);
    Logger.log('✅ ヘッダー行を復元しました');
  }
}

// 手動実行用：今すぐヘッダーを復旧したい場合に実行
function restoreHeaderNow() {
  const ss = initSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_PROMPTS);
  ensureHeaderRow(sheet);
  Logger.log('ヘッダー復旧処理 完了');
}

// 手動実行用：最終取得IDと未処理キューをリセット（最初から取得し直したい場合）
function resetLastId() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROP_LAST_ID);
  props.deleteProperty(PROP_PENDING);
  props.deleteProperty(PROP_COLLECT_PAGE);
  Logger.log('リセット完了（LAST_FETCHED_ID / PENDING_IDS / COLLECT_PAGE を削除しました）');
}

// ============================================================
// IDキュー管理（詳細取得待ちのID一覧）
// ============================================================
function getPendingIds() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(PROP_PENDING);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}

function setPendingIds(ids) {
  PropertiesService.getScriptProperties().setProperty(PROP_PENDING, JSON.stringify(ids));
}

function clearPendingIds() {
  PropertiesService.getScriptProperties().deleteProperty(PROP_PENDING);
}

// ============================================================
// 一覧ページからIDを1ページ分だけ収集（JSON API使用）
// キューが空になるたびに1ページ（30件）だけ追加取得する。
// ページ番号を記憶し、続きから再開する。
// ============================================================
const PROMPT_API_URL = 'https://chapro.jp/gpt/api/promptBox';

function collectOnePage() {
  const props = PropertiesService.getScriptProperties();
  const lastId = parseInt(props.getProperty(PROP_LAST_ID) || '0');
  let page = parseInt(props.getProperty(PROP_COLLECT_PAGE) || '1');
  const countPerPage = 30;

  const url = PROMPT_API_URL
    + '?page=' + page
    + '&sort=Register_DateTime&direction=desc'
    + '&countPerPage=' + countPerPage
    + '&promptCategory=Prompt&context=public'
    + '&types[]=1&types[]=2&types[]=3&types[]=4';

  let json;
  try {
    const res = UrlFetchApp.fetch(url, fetchOptions());
    json = JSON.parse(res.getContentText('UTF-8'));
  } catch (e) {
    Logger.log('APIページ取得失敗: page=' + page + ' / ' + e.message);
    return [];
  }

  const list = json.promptBoxList || [];
  if (list.length === 0) {
    Logger.log('データなし page=' + page + ' → 一覧の最後まで到達。次回はpage=1から再開');
    props.deleteProperty(PROP_COLLECT_PAGE);
    return [];
  }

  const ids = [];
  let foundOldId = false;
  for (const item of list) {
    const id = parseInt(item.id);
    if (id <= lastId) { foundOldId = true; break; }
    ids.push(id);
  }

  Logger.log('page=' + page + ' から ' + ids.length + '件収集 / 総数: ' + (json.links ? json.links.total : '?'));

  if (foundOldId || !json.links || !json.links.hasMorePages) {
    // 前回の最終IDに到達 or 一覧の最後 → 収集サイクル完了、次回page=1から
    props.deleteProperty(PROP_COLLECT_PAGE);
    Logger.log('ID収集サイクル完了（次回はpage=1から再スタート）');
  } else {
    props.setProperty(PROP_COLLECT_PAGE, String(page + 1));
  }

  return ids;
}

// ============================================================
// 詳細ページから1件取得
// ============================================================
function fetchPromptDetail(id) {
  const url = BASE_URL + '/prompt/' + id;
  try {
    const html = UrlFetchApp.fetch(url, fetchOptions()).getContentText('UTF-8');
    if (html.includes('404') || html.includes('ページが見つかりません')) return null;

    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    const catMatch = html.match(/\/prompt\/category\/[^"]+">([^<]+)<\/a>/);
    const category = catMatch ? catMatch[1].trim() : '';

    const descMatch = html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/);
    const description = descMatch ? descMatch[1].trim() : '';

    let promptBody = '';
    const bodyMatch = html.match(/プロンプト本文([\s\S]*?)(?:シェアする|プロンプトを生成|合体変数|<\/section>|$)/);
    if (bodyMatch) {
      promptBody = bodyMatch[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
        .replace(/\n{3,}/g, '\n\n').trim();
    }

    const authorMatch = html.match(/\/account\/\d+">([^<]+)<\/a>/);
    const author = authorMatch ? authorMatch[1].trim() : '';

    const dateMatch = html.match(/(\d{4}\/\d{2}\/\d{2})/);
    const date = dateMatch ? dateMatch[1] : '';

    if (!title) return null;
    return { id, title, category, body: promptBody, description, author, date, url };
  } catch (e) {
    Logger.log('詳細取得エラー ID=' + id + ': ' + e.message);
    return null;
  }
}

// ============================================================
// 1日の実行回数カウント管理（90分上限を超えないための自主停止）
// ============================================================
function getTodayRunCount() {
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const storedDate = props.getProperty(PROP_RUN_DATE);

  if (storedDate !== today) {
    // 日付が変わっていたらカウントリセット
    props.setProperty(PROP_RUN_DATE, today);
    props.setProperty(PROP_RUN_COUNT, '0');
    return 0;
  }
  return parseInt(props.getProperty(PROP_RUN_COUNT) || '0');
}

function incrementRunCount() {
  const props = PropertiesService.getScriptProperties();
  const current = getTodayRunCount(); // 日付チェック＆リセットも兼ねる
  props.setProperty(PROP_RUN_COUNT, String(current + 1));
}

// ============================================================
// メイン処理：1回の実行で「1件だけ」処理する
// 1分おきトリガーで呼ばれる想定。実行はほぼ一瞬で終わるため
// 6分制限には絶対に引っかからない。
// 1日の実行回数が DAILY_RUN_LIMIT に達したら、GASの90分上限に
// 達する前に自主的に処理を止める。
// ============================================================
function fetchOneCycle() {
  // 1日の実行回数上限チェック（90分上限を超えないための自主停止）
  const todayCount = getTodayRunCount();
  if (todayCount >= DAILY_RUN_LIMIT) {
    Logger.log('本日の実行回数上限（' + DAILY_RUN_LIMIT + '回）に達したため、今回は処理をスキップします。');
    return { status: 'ok', message: '本日の実行回数上限に到達。処理をスキップしました。', count: 0 };
  }
  incrementRunCount();

  const ss = initSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_PROMPTS);
  const settingsSheet = ss.getSheetByName(SHEET_SETTINGS);
  const props = PropertiesService.getScriptProperties();

  ensureHeaderRow(sheet);

  // キューが空なら1ページ分だけ補充
  let pendingIds = getPendingIds();
  if (pendingIds.length === 0) {
    pendingIds = collectOnePage();
    if (pendingIds.length === 0) {
      Logger.log('新規プロンプトなし（キュー空・収集分もなし）');
      return { status: 'ok', message: '新規プロンプトなし', count: 0 };
    }
    setPendingIds(pendingIds);
    Logger.log('キュー補充: ' + pendingIds.length + '件');
  }

  // 先頭から1件だけ取り出して処理
  const id = pendingIds.shift();
  setPendingIds(pendingIds); // 残りを保存（1件消費済み）

  // 既に保存済みでないか確認
  const existingIds = new Set();
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues()
      .forEach(row => { if (row[0]) existingIds.add(parseInt(row[0])); });
  }

  const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');

  if (existingIds.has(id)) {
    Logger.log('スキップ（重複）: ' + id);
    updateSetting(settingsSheet, 'pendingCount', pendingIds.length.toString());
    return { status: 'ok', message: '重複スキップ: ' + id, count: 0 };
  }

  const data = fetchPromptDetail(id);
  if (!data) {
    Logger.log('取得失敗（削除済み等）: ' + id);
    updateSetting(settingsSheet, 'pendingCount', pendingIds.length.toString());
    return { status: 'ok', message: '取得失敗: ' + id, count: 0 };
  }

  sheet.appendRow([
    data.id, data.title, data.category, data.body,
    data.description, data.author, data.date, now, data.url
  ]);

  // LAST_FETCHED_ID は「収集サイクルが1周完全に終わったとき」のみ更新するため
  // ここでは更新しない（COLLECT_PAGEがリセットされたタイミングで別途更新）
  const collectPage = props.getProperty(PROP_COLLECT_PAGE);
  if (!collectPage && pendingIds.length === 0) {
    // 収集サイクル完了 かつ キューを全部消費し終えた → 今回のidが最新到達点
    const prevLastId = parseInt(props.getProperty(PROP_LAST_ID) || '0');
    if (id > prevLastId) {
      props.setProperty(PROP_LAST_ID, String(id));
      Logger.log('LAST_FETCHED_ID 更新: ' + id);
    }

    // まだバックログ完了扱いになっていなければ、ここで完了とみなし
    // トリガーを「3分おき」から「2日おき」に切り替える
    if (props.getProperty(PROP_BACKLOG_DONE) !== 'true') {
      props.setProperty(PROP_BACKLOG_DONE, 'true');
      switchToLowFrequencyTrigger();
      Logger.log('🎉 バックログ全件取得が完了しました。以後は2日おきの差分チェックに切り替えます。');
    }
  }

  updateSetting(settingsSheet, 'lastFetchedAt', now);
  updateSetting(settingsSheet, 'totalCount', (sheet.getLastRow() - 1).toString());
  updateSetting(settingsSheet, 'pendingCount', pendingIds.length.toString());

  Logger.log('保存完了: ' + id + ' ' + data.title);
  return { status: 'ok', message: '保存: ' + data.title, count: 1 };
}

// ============================================================
// スプレッドシートからデータ読み込み
// ============================================================
function getPromptsFromSheet(params) {
  const ss = initSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_PROMPTS);
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'ok', data: [], total: 0 };

  const rows = sheet.getDataRange().getValues().slice(1);
  const keyword  = (params.keyword || '').toLowerCase();
  const category = params.category || '';
  const page     = parseInt(params.page || '1');
  const pageSize = parseInt(params.pageSize || '50');

  let filtered = rows.filter(row => {
    const keyOk = !keyword || (row[1]||'').toLowerCase().includes(keyword) || (row[3]||'').toLowerCase().includes(keyword);
    const catOk = !category || row[2] === category;
    return keyOk && catOk;
  });

  filtered.sort((a, b) => (b[0]||0) - (a[0]||0));

  const total = filtered.length;
  const paged = filtered.slice((page-1)*pageSize, page*pageSize);
  const data  = paged.map(row => ({
    id:row[0], title:row[1], category:row[2], body:row[3],
    description:row[4], author:row[5], date:row[6], fetchedAt:row[7], url:row[8]
  }));
  const categories = [...new Set(rows.map(r => r[2]).filter(Boolean))].sort();
  return { status:'ok', data, total, page, pageSize, categories };
}

function getHistoryFromSheet() {
  const ss = initSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_HISTORY);
  if (!sheet || sheet.getLastRow() <= 1) return { status:'ok', data:[] };
  const data = sheet.getDataRange().getValues().slice(1).reverse()
    .map(row => ({ datetime:row[0], targetAI:row[1], requirement:row[2], generated:row[3], refIds:row[4] }));
  return { status:'ok', data };
}

function saveHistoryToSheet(params) {
  const ss = initSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_HISTORY);
  const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  sheet.appendRow([
    now,
    decodeURIComponent(params.targetAI   || ''),
    decodeURIComponent(params.requirement || ''),
    decodeURIComponent(params.generated   || ''),
    decodeURIComponent(params.refIds      || '')
  ]);
  return { status:'ok', message:'履歴を保存しました', datetime:now };
}

function getStats() {
  const ss = initSpreadsheet();
  const promptSheet   = ss.getSheetByName(SHEET_PROMPTS);
  const historySheet  = ss.getSheetByName(SHEET_HISTORY);
  const settingsSheet = ss.getSheetByName(SHEET_SETTINGS);
  const totalPrompts  = Math.max(0, promptSheet  ? promptSheet.getLastRow()  - 1 : 0);
  const totalHistory  = Math.max(0, historySheet ? historySheet.getLastRow() - 1 : 0);
  let lastFetchedAt = '', pendingCount = '0';
  if (settingsSheet) {
    settingsSheet.getDataRange().getValues().forEach(row => {
      if (row[0] === 'lastFetchedAt') lastFetchedAt = row[1];
      if (row[0] === 'pendingCount')  pendingCount  = row[1];
    });
  }
  return { status:'ok', totalPrompts, totalHistory, lastFetchedAt, pendingCount };
}

// ============================================================
// ユーティリティ
// ============================================================
function updateSetting(sheet, key, value) {
  const data = sheet.getDataRange().getValues();
  for (let i = 0; i < data.length; i++) {
    if (data[i][0] === key) { sheet.getRange(i+1, 2).setValue(value); return; }
  }
  sheet.appendRow([key, value]);
}

// ============================================================
// タイムトリガー設定（バックログ取得中：1分おき・1回1件処理）
// ============================================================
function setNightlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'fetchOneCycle') ScriptApp.deleteTrigger(t);
  });

  // 1分おきに実行。ただし関数内の490回カウントにより
  // 1日の合計実行時間が90分を超える前に自主的に停止する。
  ScriptApp.newTrigger('fetchOneCycle')
    .timeBased()
    .everyMinutes(1)
    .create();

  Logger.log('トリガー設定完了（1分おき・1日490回で自主停止・バックログ取得モード）');
}

// ============================================================
// バックログ完了後：低頻度トリガーに切り替え（新着の差分チェックのみ）
// fetchOneCycle内でバックログ完了を検知すると自動的に呼ばれる
// ============================================================
function switchToLowFrequencyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'fetchOneCycle') ScriptApp.deleteTrigger(t);
  });

  // 2日に1回、朝9時に実行（新着プロンプトの差分チェックのみのため高頻度不要）
  ScriptApp.newTrigger('fetchOneCycle')
    .timeBased()
    .atHour(9)
    .everyDays(2)
    .inTimezone('Asia/Tokyo')
    .create();

  Logger.log('トリガー切り替え完了（2日に1回・9時実行・通常運用モード）');
}

// 手動実行用：低頻度モードに強制的に切り替えたい場合
function manualSwitchToLowFrequency() {
  switchToLowFrequencyTrigger();
  Logger.log('手動で低頻度モードに切り替えました');
}

// 手動実行用（1件だけ処理される）
function manualFetch() {
  const result = fetchOneCycle();
  Logger.log(JSON.stringify(result));
}

// 初回セットアップ（最初に1度だけ実行）
function setup() {
  const ss = initSpreadsheet();
  setNightlyTrigger();
  Logger.log('セットアップ完了');
  Logger.log('スプレッドシートURL: ' + ss.getUrl());
}
