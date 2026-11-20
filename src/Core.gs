/*********************************************************
 * Core.gs — تطبيق واحد لكل سكريبتات QuickBooks
 * المشتريات (PO) + Google Ads + Meta + بوسطة + كاشير + مزامنة المنتجات
 *
 * النشر: Deploy > New deployment > Web app
 *   Execute as: Me    |    Who has access: Anyone
 *   (Anyone مطلوبة عشان webhooks بوسطة وشوبيفاي، والواجهة محمية بكلمة السر)
 *
 * كلمة السر: أضف Script Property باسم APP_PASSWORD
 *   تتحول تلقائياً لـ hash عند أول دخول وتتمسح.
 *
 * الملف ده بيحتوي على doGet و doPost الوحيدين في المشروع.
 *********************************************************/

const APP = {
  TITLE: 'PetFriend • QBO',
  FAVICON: 'https://cdn.shopify.com/s/files/1/0690/9218/0245/files/Logo_32_-_32_Pix-01.png',
  WEBAPP_URL: 'https://script.google.com/macros/s/AKfycby5qiOh4iZ902dce7d7sPaKOmZy3pH92fCqL6mDwAfnPtIIC3ZjRDUlFCVsMhALMTUv/exec',   // يُستخدم لو Script Property WEBAPP_URL فاضية
  TZ: 'Africa/Cairo',
  SESSION_SEC: 6 * 3600,   // 6 ساعات (الحد الأقصى للكاش)
  LOG_TAB: 'Runs',
  LOG_KEEP: 1500,          // عدد صفوف السجل المحفوظة
  LOG_MAX: 45000           // أقصى طول للوج في الخلية
};

const GROUPS = [
  { id: 'A', name: 'المشتريات والإعلانات', name_en: 'Purchasing & Ads' },
  { id: 'B', name: 'التحصيلات والمنتجات', name_en: 'Collections & Products' }
];

// ---------- كل السكريبتات ----------
// actions: الدوال المسموح تشغيلها من الواجهة
//   post: بيرحّل لـ QBO فعلاً، فالواجهة بتطلب تأكيد (إلا لو السكريبت في وضع التجربة)
//   confirm: بيطلب تأكيد دايماً
// triggers: المواعيد اللي الواجهة بتديرها (كل تشغيل مجدول بيتسجل في السجل)
const JOBS = [
  {
    id: 'po', group: 'A', name: 'استلام أوامر الشراء ← Bill في QBO', name_en: 'Purchase orders → QBO bills',
    desc: 'يسحب التحويلات المستلمة من شوبيفاي، يكتب الأصناف في تاب PO، وينشئ Bill + قيد إعادة تصنيف.',
    desc_en: 'Pulls received transfers from Shopify, writes the items to the PO tab, and creates a bill plus a reclass journal.',
    actions: [
      { fn: 'dailyRun', label: 'تشغيل الآن', label_en: 'Run now', post: true },
      { fn: 'testOne', label: 'معالجة آخر تحويل مستلم', label_en: 'Process latest received transfer', post: true },
      { fn: 'reclassExistingBills', label: 'إعادة تصنيف الفواتير الحالية', label_en: 'Reclass existing bills', post: true },
      { fn: 'markExistingAsProcessed', label: 'اعتبار كل التحويلات الحالية مُعالجة', label_en: 'Mark all current transfers as processed', confirm: true }
    ],
    triggers: [{ fn: 'cron_po', label: 'يومياً', label_en: 'Daily', type: 'daily', hour: 15 }],
    props: ['SPREAD_SHEET_ID', 'QBO_INVENTORY_ASSET_ACCOUNT_ID', 'QBO_INVENTORY_OFFSET_ACCOUNT_ID']
  },
  {
    id: 'gads', group: 'A', name: 'Google Ads ← قيود QBO', name_en: 'Google Ads → QBO journals',
    desc: 'يقرأ تاب GADS_TX: مصروف يومي (بعد ما اليوم يخلص)، سداد، وأرصدة.',
    desc_en: 'Reads the GADS_TX tab: daily spend (once the day is over), payments and credits.',
    actions: [
      { fn: 'gadsSync50Dry', label: 'تجربة (بدون ترحيل)', label_en: 'Dry run (no posting)' },
      { fn: 'gadsSync50Post', label: 'ترحيل آخر 50 حركة', label_en: 'Post latest 50 items', post: true },
      { fn: 'googleAdsDailyRun', label: 'ترحيل من تاب GADS (القديم)', label_en: 'Post from old GADS tab', post: true }
    ],
    triggers: [{ fn: 'cron_gads', label: 'يومياً', label_en: 'Daily', type: 'daily', hour: 10 }],
    props: ['SPREAD_SHEET_ID2', 'QBO_GADS_EXPENSE_ACCOUNT_ID', 'QBO_GADS_CLEARING_ACCOUNT_ID', 'QBO_META_PAYMENT_ACCOUNT_ID']
  },
  {
    id: 'meta', group: 'A', name: 'Meta Ads ← قيود QBO', name_en: 'Meta Ads → QBO journals',
    desc: 'المجدول يرحّل الـ Charges فقط. الفواتير يدوي عشان ما يتكررش نفس المبلغ مرتين.',
    desc_en: 'The schedule posts charges only. Invoices are manual so the same amount is never posted twice.',
    actions: [
      { fn: 'metaChargesDryRun', label: 'تجربة Charges', label_en: 'Dry run charges' },
      { fn: 'metaChargesPost', label: 'ترحيل Charges', label_en: 'Post charges', post: true },
      { fn: 'metaInvoicesDry', label: 'تجربة الفواتير', label_en: 'Dry run invoices' },
      { fn: 'metaInvoicesPost', label: 'ترحيل الفواتير', label_en: 'Post invoices', post: true },
      { fn: 'metaFindBusiness', label: 'معرفة Business ID', label_en: 'Find Business ID' }
    ],
    triggers: [{ fn: 'cron_meta', label: 'يومياً (Charges)', label_en: 'Daily (charges)', type: 'daily', hour: 11 }],
    props: ['META_AD_ACCOUNT_ID', 'META_BUSINESS_ID', 'META_TOKEN', 'QBO_META_CLEARING_ACCOUNT_ID', 'QBO_META_PAYMENT_ACCOUNT_ID']
  },
  {
    id: 'bosta', group: 'B', name: 'تحويلات بوسطة ← قيد QBO', name_en: 'Bosta payouts → QBO journal',
    desc: 'قيد لكل Cash-out: تحصيل كل أوردر، رسوم بوسطة، والكريدت.',
    desc_en: 'One journal per cash-out: each order’s collection, Bosta fees and credits.',
    dryKey: 'BOSTA_DRY_RUN', webhook: 'bosta',
    actions: [
      { fn: 'runSync', label: 'تشغيل الآن', label_en: 'Run now', post: true },
      { fn: 'checkProps', label: 'فحص الإعدادات', label_en: 'Check settings' }
    ],
    triggers: [{ fn: 'cron_bosta', label: 'يومياً', label_en: 'Daily', type: 'daily', hour: 12 }],
    props: ['BOSTA_API_KEY', 'BOSTA_AUTH_HEADER_NAME', 'BOSTA_WEBHOOK_TOKEN', 'BOSTA_FEES_URL', 'BOSTA_PAYOUT_ORDERS_URL',
      'BOSTA_PAYOUT_START_DATE', 'BOSTA_DRY_RUN', 'QBO_BOSTA_CLEARING_ACCOUNT_ID', 'QBO_BOSTA_FEES_ACCOUNT_ID',
      'QBO_BOSTA_CREDITS_ACCOUNT_ID']
  },
  {
    id: 'kashier', group: 'B', name: 'تحويلات كاشير ← قيد QBO', name_en: 'Kashier payouts → QBO journal',
    desc: 'قيد لكل Payout مفصّل بالمدفوعات والرسوم لكل Settlement.',
    desc_en: 'One journal per payout, itemized by payment, with fees per settlement.',
    dryKey: 'KASHIER_PAYOUT_DRY_RUN',
    actions: [
      { fn: 'kashierPayoutRun', label: 'تشغيل الآن', label_en: 'Run now', post: true },
      { fn: 'checkKashierProps', label: 'فحص الإعدادات', label_en: 'Check settings' },
      { fn: 'kashierWhyEmpty', label: 'ليه مفيش قيود؟', label_en: 'Why no journals?' },
      { fn: 'kashierListBooked', label: 'التحويلات المسجلة', label_en: 'Booked payouts' },
      { fn: 'kashierCheckUrls', label: 'فحص الروابط', label_en: 'Check URLs' },
      { fn: 'kashierTokenExpiry', label: 'انتهاء التوكن', label_en: 'Token expiry' }
    ],
    triggers: [{ fn: 'cron_kashier', label: 'يومياً', label_en: 'Daily', type: 'daily', hour: 13 }],
    props: ['KASHIER_API_KEY', 'KASHIER_AUTH_HEADER', 'KASHIER_API_URL', 'KASHIER_SETTLEMENTS_URL', 'KASHIER_PAYMENTS_URL',
      'KASHIER_PAYOUT_START_DATE', 'KASHIER_PAYOUT_DRY_RUN', 'KASHIER_QBO_CLEARING_ACC_ID', 'KASHIER_FEES_ACC_ID',
      'KASHIER_LOGIN_URL', 'KASHIER_LOGIN_BODY', 'KASHIER_TOKEN_FIELD']
  },
  {
    id: 'products', group: 'B', name: 'مزامنة المنتجات شوبيفاي ← QBO', name_en: 'Product sync Shopify → QBO',
    desc: 'الاسم والـ SKU والسعر والتكلفة. الكمية لا تُزامن. بتشتغل مرة في اليوم، أو يدوي من الزرار. لو المنتجات كتير ووقفت قبل ما تخلص، دوس الزرار تاني وهتكمّل.',
    desc_en: 'Name, SKU, price and cost (not quantity). Runs once a day or from the button. If it stops before finishing, press it again to continue.',
    actions: [
      { fn: 'pqSyncAll', label: 'زامن المنتجات الآن (شوبيفاي ← QBO)', label_en: 'Sync products now (Shopify → QBO)', confirm: true },
      { fn: 'pqDryRun', label: 'تجربة (بدون تعديل)', label_en: 'Dry run (no changes)' },
      { fn: 'debugShopifyToken', label: 'فحص اتصال شوبيفاي', label_en: 'Check Shopify connection' },
      { fn: 'pqClearQueue', label: 'مسح الطابور القديم', label_en: 'Clear old queue', confirm: true }
    ],
    triggers: [
      { fn: 'cron_pqDaily', label: 'مزامنة كاملة يومية', label_en: 'Daily full sync', type: 'daily', hour: 3 }
    ],
    props: ['QBO_INCOME_ACCOUNT_ID', 'QBO_EXPENSE_ACCOUNT_ID', 'QBO_ASSET_ACCOUNT_ID',
      'QBO_INV_START_DATE', 'SHEET_ID']
  }
];

const SHARED_PROPS = ['GO_LIVE_DATE', 'QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'QBO_REFRESH_TOKEN', 'QBO_REALM_ID',
  'QBO_UNDEPOSITED_FUNDS_ACCOUNT_ID', 'SHOP', 'CLIENT_ID', 'CLIENT_SECRET', 'WEBAPP_URL'];

const SECRET_KEYS = ['QBO_CLIENT_SECRET', 'QBO_REFRESH_TOKEN', 'CLIENT_SECRET', 'CLIENT_SECRET_QBO', 'META_TOKEN',
  'BOSTA_API_KEY', 'BOSTA_WEBHOOK_TOKEN', 'KASHIER_API_KEY', 'KASHIER_LOGIN_BODY', 'KASHIER_TEST_KEY', 'WEBHOOK_KEY'];
const BOOL_KEYS = ['BOSTA_DRY_RUN', 'KASHIER_PAYOUT_DRY_RUN'];

// ---------- تاريخ البدء الفعلي ----------
// GO_LIVE_DATE (yyyy-MM-dd): أي حركة قبله مش بتترحّل في أي سكريبت. فاضي = مفيش حد.
function goLive_() {
  const v = String(PropertiesService.getScriptProperties().getProperty('GO_LIVE_DATE') || '').trim();
  if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('GO_LIVE_DATE لازم يكون بالشكل 2027-01-01، القيمة الحالية: ' + v);
  return v;
}
function todayCairo_() { return Utilities.formatDate(new Date(), 'Africa/Cairo', 'yyyy-MM-dd'); }
function beforeGoLive_(day) { const g = goLive_(); return !!g && String(day) < g; }
function laterDate_(a, b) { return !b ? a : (a > b ? a : b); }

// ---------- المواعيد المجدولة (كلها بتسجل في السجل) ----------
function cron_po()      { cronRun_('po', 'dailyRun'); }
function cron_gads()    { cronRun_('gads', 'gadsSync50Post'); }
function cron_meta()    { cronRun_('meta', 'metaChargesPost'); }
function cron_bosta()   { cronRun_('bosta', 'dailySync'); }
function cron_kashier() { cronRun_('kashier', 'kashierPayoutDaily'); }
function cron_pqDaily() { cronRun_('products', 'pqSyncAll'); }
// اتلغى: المنتجات بقت بتتزامن مرة في اليوم أو يدوي.
// لو الموعد القديم (كل دقيقة) لسه موجود، أول ما يشتغل بيمسح نفسه.
function cron_pqQueue() {
  ScriptApp.getProjectTriggers().forEach(function (x) {
    if (x.getHandlerFunction() === 'cron_pqQueue') ScriptApp.deleteTrigger(x);
  });
}

// الخطأ بيتسجل في السجل بس. مش بنرمي exception عشان جوجل ما يبعتش إيميل فشل.
function cronRun_(jobId, fn) {
  runLogged_(jobId, 'schedule', fn, function () { return globalThis[fn](); });
}

// ---------- Wrappers ----------
function metaChargesPost()  { return metaChargesLast50(false); }
// فواتير ميتا وCharges بيمثلوا نفس الفلوس: ممنوع ترحيل الفواتير وموعد الـ Charges شغال
function metaInvoicesPost() {
  if (ScriptApp.getProjectTriggers().some(function (x) { return x.getHandlerFunction() === 'cron_meta'; })) {
    throw new Error('موعد Charges ميتا شغال، فترحيل الفواتير هيكرر نفس المبالغ. اقفل الموعد الأول لو عايز ترحّل بالفواتير.');
  }
  return metaInvoices(false);
}
function pqClearQueue() {
  const P = PropertiesService.getScriptProperties();
  const keys = pqQueueKeys_();
  keys.forEach(function (k) { P.deleteProperty(k); });
  out_('', 'Cleared ' + keys.length + ' queued products');
}

/* ============================================================
   WEB APP
   ============================================================ */

function doGet(e) {
  // اختبار سريع: افتح رابط /exec?ping=1 ← لو ظهر {"ok":true,"ui":true} يبقى النسخة الجديدة متنشرة
  if (e && e.parameter && e.parameter.ping) return uiJson_({ ok: true, ui: true, time: new Date().toISOString() });
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP.TITLE)
    .setFaviconUrl(APP.FAVICON)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  const p = (e && e.parameter) || {};
  if (p.src === 'ui') return uiApi_(e);             // الواجهة على GitHub Pages
  if (p.src === 'pq') return uiJson_({ ok: true, ignored: 'products sync daily or manually' });   // ويب هوك شوبيفاي القديم
  const r = runLogged_('bosta', 'webhook', 'handleBostaWebhook_', function () { return handleBostaWebhook_(e); });
  return r.result || uiJson_({ ok: false, error: r.error || r.summary });
}

// الواجهة اللي برة Apps Script (GitHub Pages) بتبعت POST بـ {fn, args}
// كل دالة هنا بتتحقق من التوكن بنفسها (auth_) ما عدا الدخول والخروج.
const UI_API = ['api_login', 'api_logout', 'api_changePassword', 'api_state', 'api_runAction', 'api_setTrigger',
  'api_deleteTrigger', 'api_logs', 'api_logDetail', 'api_settings', 'api_saveSettings', 'api_qboAccounts',
  'api_testConnections', 'api_importProps', 'api_cleanupProps', 'api_healthCheck'];

function uiApi_(e) {
  let out;
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const fn = String(body.fn || '');
    if (UI_API.indexOf(fn) < 0) throw new Error('Unknown API: ' + fn);
    const args = Array.isArray(body.args) ? body.args : [];
    out = { ok: true, result: globalThis[fn].apply(null, args) };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return uiJson_(out);
}

// مستقلة عن json_ اللي في Bosta.gs عشان الواجهة تشتغل حتى لو الملف ده مش موجود
function uiJson_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
   تسجيل التشغيل
   ============================================================ */

function nowStr_(d) { return Utilities.formatDate(d || new Date(), APP.TZ, 'yyyy-MM-dd HH:mm:ss'); }

// تشغيل "شغال" من أكتر من 7 دقايق يبقى جوجل وقفه (الحد 6 دقايق)
function isStale_(time) { return String(time) < nowStr_(new Date(Date.now() - 7 * 60000)); }

// قفل لكل سكريبت: يمنع نفس السكريبت يشتغل مرتين في نفس الوقت (زرار اتداس مرتين، أو يدوي + موعد)
function acquireJob_(jobId) {
  const L = LockService.getScriptLock();   // بيتمسك أجزاء من الثانية بس
  if (!L.tryLock(15000)) return false;
  try {
    const c = CacheService.getScriptCache();
    if (c.get('APP_RUN_' + jobId)) return false;
    c.put('APP_RUN_' + jobId, String(Date.now()), 420);   // بيتفك لوحده بعد 7 دقايق لو التشغيل اتقطع
    return true;
  } finally {
    L.releaseLock();
  }
}
function releaseJob_(jobId) { CacheService.getScriptCache().remove('APP_RUN_' + jobId); }

function runLogged_(jobId, source, action, fn) {
  const P = PropertiesService.getScriptProperties();
  const id = 'r' + Utilities.getUuid().replace(/-/g, '').substring(0, 9);
  const startTime = nowStr_();

  if (!acquireJob_(jobId)) {
    const msg = 'اتخطّى: السكريبت ده شغال بالفعل. استنى لما يخلص وجرّب تاني.';
    writeLog_([id, startTime, jobId, source, action, 'warn', 0, msg, msg]);
    return { id: id, status: 'warn', error: '', summary: msg, secs: 0, log: msg, result: undefined };
  }

  try {
    // بيتسجل أول ما يبدأ، عشان لو جوجل وقفه عند 6 دقايق يفضل باين في السجل
    writeLog_([id, startTime, jobId, source, action, 'running', '', 'شغال...', '']);
    P.setProperty('APP_LAST_' + jobId,
      JSON.stringify({ time: startTime, status: 'running', action: action, source: source, summary: 'شغال...' }));

    const buf = [];
    const t0 = Date.now();
    try { Logger.clear(); } catch (x) {}

    let result, error = '';
    try {
      result = fn();
    } catch (err) {
      error = String((err && err.message) || err);
      buf.push('ERROR: ' + ((err && err.stack) || err));
    }

    let lg = '';
    try { lg = Logger.getLog(); } catch (x) {}
    const text = ((lg ? lg + '\n' : '') + buf.join('\n')).trim();
    const resText = resultText_(result);
    const status = error ? 'error'
      : /"error"\s*:|FAILED|Failed |WARN: |"timedOut":true/.test(resText + '\n' + text) ? 'warn' : 'ok';
    const lines = text.split('\n').filter(String)
      .map(function (l) { return l.replace(/^.*?\b(INFO|WARNING|SEVERE): /, ''); });   // من غير ختم الوقت بتاع Logger
    const summary = (error || resText || lines[lines.length - 1] || 'تم بدون مخرجات · Done, no output').substring(0, 300);
    const secs = Math.round((Date.now() - t0) / 100) / 10;

    finishLog_(id, [id, startTime, jobId, source, action, status, secs, summary,
      (resText ? 'RESULT: ' + resText + '\n\n' : '') + text]);

    P.setProperty('APP_LAST_' + jobId,
      JSON.stringify({ time: startTime, status: status, action: action, source: source, summary: summary.substring(0, 200) }));

    return { id: id, status: status, error: error, summary: summary, secs: secs,
      log: text.slice(-20000), result: result };
  } finally {
    releaseJob_(jobId);
  }
}

// كل السكريبتات بتكتب هنا بدل console.log: Logger هو اللي بيوصل لسجل الواجهة
// (تبديل console.log مش بيشتغل في Apps Script، فاللوج كان بيضيع)
function out_(level) {
  const msg = Array.prototype.slice.call(arguments, 1).map(function (a) {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || String(a);
    try { return JSON.stringify(a); } catch (x) { return String(a); }
  }).join(' ');
  Logger.log((level ? level + ': ' : '') + msg);
}

function resultText_(r) {
  if (r === undefined || r === null) return '';
  if (typeof r.getContent === 'function') return r.getContent();
  if (typeof r === 'object') { try { return JSON.stringify(r); } catch (x) { return String(r); } }
  return String(r);
}

function logSheet_() {
  const P = PropertiesService.getScriptProperties();
  const id = P.getProperty('APP_LOG_SHEET_ID');
  let ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (x) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('PetFriend QBO – سجل التشغيل');
    P.setProperty('APP_LOG_SHEET_ID', ss.getId());
  }
  const sh = ss.getSheetByName(APP.LOG_TAB) || ss.insertSheet(APP.LOG_TAB);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 9).setValues([['Id', 'Time', 'Job', 'Source', 'Action', 'Status', 'Seconds', 'Summary', 'Log']]);
    sh.setFrozenRows(1);
  }
  if (P.getProperty('APP_LOG_FMT') !== '2') {     // كل الأعمدة نص، عشان الوقت والـ Id ما يتحولوش لأرقام
    sh.getRange('A:I').setNumberFormat('@');
    P.setProperty('APP_LOG_FMT', '2');
  }
  return sh;
}

function logRow_(row) {
  row[8] = String(row[8]).substring(0, APP.LOG_MAX);
  return row.map(function (v) { return typeof v === 'number' ? v : String(v); });
}

// appendRow عملية واحدة، فتشغيلين في نفس اللحظة ما يكتبوش فوق بعض
function writeLog_(row) {
  try {
    const sh = logSheet_();
    sh.appendRow(logRow_(row));
    const last = sh.getLastRow();
    if (last > APP.LOG_KEEP + 1) sh.deleteRows(2, last - APP.LOG_KEEP - 1);   // أقدم صفوف
  } catch (err) {
    out_('ERROR', 'Log write failed: ' + err);
  }
}

function finishLog_(id, row) {
  try {
    const sh = logSheet_();
    const cell = sh.getRange('A:A').createTextFinder(id).matchEntireCell(true).findNext();
    if (!cell) return writeLog_(row);
    sh.getRange(cell.getRow(), 1, 1, row.length).setValues([logRow_(row)]);
  } catch (err) {
    out_('ERROR', 'Log update failed: ' + err);
  }
}

/* ============================================================
   كلمة السر والجلسات
   ============================================================ */

function pwHash_(pw) {
  const P = PropertiesService.getScriptProperties();
  let salt = P.getProperty('APP_PW_SALT');
  if (!salt) { salt = Utilities.getUuid(); P.setProperty('APP_PW_SALT', salt); }
  let h = salt + '|' + pw;
  for (let i = 0; i < 300; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8));
  }
  return h;
}

function safeEq_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function sessionGen_() {
  return PropertiesService.getScriptProperties().getProperty('APP_SESSION_GEN') || '1';
}

function auth_(token) {
  const v = token ? CacheService.getScriptCache().get('APP_S_' + token) : null;
  if (!v || v !== sessionGen_()) throw new Error('AUTH');
}

function api_login(pw) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('APP_FAILS') || 0);
  if (fails >= 5) throw new Error('محاولات كثيرة خاطئة. جرّب بعد 15 دقيقة.');

  const P = PropertiesService.getScriptProperties();
  const plain = P.getProperty('APP_PASSWORD');
  if (plain) {
    P.setProperty('APP_PASSWORD_HASH', pwHash_(plain));
    P.deleteProperty('APP_PASSWORD');
  }
  const hash = P.getProperty('APP_PASSWORD_HASH');
  if (!hash) throw new Error('لم يتم ضبط كلمة السر. أضف Script Property باسم APP_PASSWORD.');

  if (!safeEq_(pwHash_(String(pw || '')), hash)) {
    cache.put('APP_FAILS', String(fails + 1), 900);
    throw new Error('كلمة السر غير صحيحة');
  }
  cache.remove('APP_FAILS');
  const token = Utilities.getUuid() + Utilities.getUuid();
  cache.put('APP_S_' + token, sessionGen_(), APP.SESSION_SEC);
  return token;
}

function api_logout(t) {
  if (t) CacheService.getScriptCache().remove('APP_S_' + t);
  return true;
}

function api_changePassword(t, oldPw, newPw) {
  auth_(t);
  const P = PropertiesService.getScriptProperties();
  if (!safeEq_(pwHash_(String(oldPw || '')), P.getProperty('APP_PASSWORD_HASH') || '')) {
    throw new Error('كلمة السر الحالية غير صحيحة');
  }
  if (String(newPw || '').length < 8) throw new Error('كلمة السر الجديدة لازم تكون 8 حروف على الأقل');
  P.setProperty('APP_PASSWORD_HASH', pwHash_(newPw));
  P.setProperty('APP_SESSION_GEN', String(Number(sessionGen_()) + 1));   // يخرج كل الجلسات
  return true;
}

/* ============================================================
   API للواجهة
   ============================================================ */

function findJob_(id) {
  const j = JOBS.filter(function (x) { return x.id === id; })[0];
  if (!j) throw new Error('Unknown job: ' + id);
  return j;
}

function webhookUrl_(kind) {
  const P = PropertiesService.getScriptProperties();
  let base = (P.getProperty('WEBAPP_URL') || APP.WEBAPP_URL || '').trim();
  if (!base) { try { base = ScriptApp.getService().getUrl(); } catch (x) {} }
  if (!base) return '';
  if (kind === 'bosta') {
    const t = P.getProperty('BOSTA_WEBHOOK_TOKEN');
    return t ? base + '?token=' + encodeURIComponent(t) : '';
  }
  return '';
}

function lastRun_(json) {
  const L = JSON.parse(json || 'null');
  if (L && L.status === 'running' && isStale_(L.time)) { L.status = 'stopped'; L.summary = 'اتوقف: عدّى حد الـ 6 دقايق بتاع جوجل'; }
  return L;
}

function api_state(t) {
  auth_(t);
  const P = PropertiesService.getScriptProperties();
  const all = P.getProperties();
  const trig = ScriptApp.getProjectTriggers();
  const known = {};

  const jobs = JOBS.map(function (j) {
    return {
      id: j.id, group: j.group, name: j.name, name_en: j.name_en || '', desc: j.desc || '', desc_en: j.desc_en || '',
      actions: j.actions,
      last: lastRun_(all['APP_LAST_' + j.id]),
      dryKey: j.dryKey || '',
      dry: j.dryKey ? String(all[j.dryKey] || '').trim().toLowerCase() !== 'false' : null,   // أي حاجة غير false = تجربة
      webhook: j.webhook ? webhookUrl_(j.webhook) : null,
      queue: j.id === 'products' ? Object.keys(all).filter(function (k) { return k.indexOf('PQ_Q_') === 0; }).length : null,
      triggers: j.triggers.map(function (tr) {
        known[tr.fn] = 1;
        return {
          fn: tr.fn, label: tr.label, label_en: tr.label_en || '', type: tr.type, every: tr.every || null,
          hour: Number(all['APP_TRG_' + tr.fn] || tr.hour || 0),
          enabled: trig.some(function (x) { return x.getHandlerFunction() === tr.fn; })
        };
      })
    };
  });

  const others = trig.filter(function (x) { return !known[x.getHandlerFunction()]; })
    .map(function (x) { return { id: x.getUniqueId(), fn: x.getHandlerFunction(), type: String(x.getEventType()) }; });

  return {
    groups: GROUPS, jobs: jobs, others: others, goLive: all.GO_LIVE_DATE || '',
    health: JSON.parse(all.APP_HEALTH || 'null'),
    logUrl: all.APP_LOG_SHEET_ID ? 'https://docs.google.com/spreadsheets/d/' + all.APP_LOG_SHEET_ID : ''
  };
}

function api_runAction(t, jobId, fn) {
  auth_(t);
  const job = findJob_(jobId);
  if (!job.actions.some(function (a) { return a.fn === fn; })) throw new Error('Action not allowed: ' + fn);
  if (typeof globalThis[fn] !== 'function') {
    throw new Error('الدالة ' + fn + ' مش موجودة. تأكد إنك نسخت ملف السكريبت بتاعها في المشروع.');
  }
  const r = runLogged_(jobId, 'manual', fn, function () { return globalThis[fn](); });
  return { id: r.id, status: r.status, error: r.error, summary: r.summary, secs: r.secs, log: r.log };
}

function api_setTrigger(t, fn, enabled, hour) {
  auth_(t);
  let def = null;
  JOBS.forEach(function (j) { j.triggers.forEach(function (tr) { if (tr.fn === fn) def = tr; }); });
  if (!def) throw new Error('Unknown trigger: ' + fn);

  ScriptApp.getProjectTriggers().forEach(function (x) {
    if (x.getHandlerFunction() === fn) ScriptApp.deleteTrigger(x);
  });

  const h = Math.max(0, Math.min(23, Number(hour) || 0));
  if (def.type === 'daily') PropertiesService.getScriptProperties().setProperty('APP_TRG_' + fn, String(h));   // الساعة بتتحفظ حتى لو الموعد مقفول

  if (enabled) {
    if (def.type === 'minutes') {
      ScriptApp.newTrigger(fn).timeBased().everyMinutes(def.every || 1).create();
    } else {
      ScriptApp.newTrigger(fn).timeBased().everyDays(1).atHour(h).inTimezone(APP.TZ).create();
    }
  }
  return api_state(t);
}

function api_deleteTrigger(t, uid) {
  auth_(t);
  ScriptApp.getProjectTriggers().forEach(function (x) {
    if (x.getUniqueId() === uid) ScriptApp.deleteTrigger(x);
  });
  return api_state(t);
}

function api_logs(t, jobId, limit) {
  auth_(t);
  const sh = logSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 8).getDisplayValues()
    .filter(function (r) { return r[0] && (!jobId || r[2] === jobId); })
    .sort(function (a, b) { return a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0; })   // الأحدث الأول
    .slice(0, Math.min(Number(limit) || 150, 500))
    .map(function (r) {
      const stale = r[5] === 'running' && isStale_(r[1]);
      return { id: r[0], time: r[1], job: r[2], source: r[3], action: r[4], status: stale ? 'stopped' : r[5],
        secs: r[6], summary: stale ? 'اتوقف: عدّى حد الـ 6 دقايق بتاع جوجل' : r[7] };
    });
}

function api_logDetail(t, id) {
  auth_(t);
  const sh = logSheet_();
  const cell = sh.getRange('A:A').createTextFinder(String(id)).matchEntireCell(true).findNext();
  if (!cell) throw new Error('السجل غير موجود');
  const r = sh.getRange(cell.getRow(), 1, 1, 9).getDisplayValues()[0];
  const stale = r[5] === 'running' && isStale_(r[1]);
  return { id: r[0], time: r[1], job: r[2], source: r[3], action: r[4], status: stale ? 'stopped' : r[5], secs: r[6],
    summary: stale ? 'اتوقف: عدّى حد الـ 6 دقايق بتاع جوجل، فاللوج بتاعه مش متسجل' : r[7], log: r[8] };
}

/* ---------- الإعدادات (Script Properties) ---------- */

function propType_(k) {
  if (SECRET_KEYS.indexOf(k) > -1) return 'secret';
  if (BOOL_KEYS.indexOf(k) > -1) return 'bool';
  if (/_ACC(OUNT)?_ID$/.test(k)) return 'account';
  if (/_DATE$/.test(k)) return 'date';
  return 'text';
}

function isStateKey_(k) {
  return /^APP_/.test(k) || isProtectedKey_(k);
}

// علامات اللي اترحّل قبل كده: تعديلها أو مسحها ممكن يرحّل نفس القيد تاني
function isProtectedKey_(k) {
  if (STATE_KEYS.indexOf(k) > -1 || /PROCESSED$/.test(k) || /^PQ_Q_/.test(k)) return true;
  if (/^BOSTA_PAYOUT_/.test(k) && k !== 'BOSTA_PAYOUT_START_DATE' && k !== 'BOSTA_PAYOUT_ORDERS_URL') return true;
  if (/^KASHIER_PAYOUT_/.test(k) && k !== 'KASHIER_PAYOUT_START_DATE' && k !== 'KASHIER_PAYOUT_DRY_RUN') return true;
  return false;
}

function api_settings(t) {
  auth_(t);
  const all = PropertiesService.getScriptProperties().getProperties();
  const used = {};
  const mk = function (k) {
    used[k] = 1;
    const type = propType_(k);
    const v = all[k];
    return { key: k, type: type, set: v !== undefined && v !== '', value: type === 'secret' ? '' : (v || '') };
  };

  const sections = [{ id: 'shared', name: 'إعدادات مشتركة (QBO + شوبيفاي)', name_en: 'Shared settings (QBO + Shopify)', items: SHARED_PROPS.map(mk) }]
    .concat(JOBS.map(function (j) { return { id: j.id, name: j.name, name_en: j.name_en, items: j.props.map(mk) }; }));

  const others = Object.keys(all).filter(function (k) { return !used[k] && !isStateKey_(k); }).sort().map(mk);
  const stateCount = Object.keys(all).filter(isStateKey_).length;
  return { sections: sections, others: others, stateCount: stateCount };
}

function api_saveSettings(t, changes) {
  auth_(t);
  const P = PropertiesService.getScriptProperties();
  let n = 0, qbo = false, shop = false;
  Object.keys(changes || {}).forEach(function (k) {
    if (!/^[A-Za-z0-9_\-]+$/.test(k) || /^APP_/.test(k)) throw new Error('اسم غير مسموح: ' + k);
    if (isProtectedKey_(k)) throw new Error(k + ': ده من بيانات الحالة الداخلية (اللي اترحّل قبل كده)، ومينفعش يتعدل من هنا عشان القيود ما تتكررش.');
    const v = changes[k];
    if (v === null) { P.deleteProperty(k); n++; }
    else if (propType_(k) === 'secret' && v === '') { return; }
    else { P.setProperty(k, String(v).trim()); n++; }
    if (/^QBO_(CLIENT|REFRESH|REALM)/.test(k)) qbo = true;
    if (k === 'SHOP' || /^CLIENT_/.test(k)) shop = true;
  });
  const c = CacheService.getScriptCache();
  if (qbo) c.removeAll(['QBO_ACCESS_TOKEN', 'qbo_access_token']);
  if (shop) c.remove('shopify_access_token');
  return { saved: n };
}

function api_qboAccounts(t) {
  auth_(t);
  const q = "select * from Account where Active = true maxresults 1000";
  const r = UrlFetchApp.fetch('https://quickbooks.api.intuit.com/v3/company/' + req_('QBO_REALM_ID') +
    '/query?minorversion=70&query=' + encodeURIComponent(q), {
    headers: { Authorization: 'Bearer ' + getQboToken_(), Accept: 'application/json' },
    muteHttpExceptions: true
  });
  if (r.getResponseCode() >= 300) throw new Error('QBO ' + r.getResponseCode() + ': ' + r.getContentText().substring(0, 300));
  return ((JSON.parse(r.getContentText()).QueryResponse || {}).Account || [])
    .map(function (a) { return { id: a.Id, name: a.FullyQualifiedName || a.Name, type: a.AccountType }; })
    .sort(function (a, b) { return a.name < b.name ? -1 : 1; });
}

/* ---------- فحص الاتصالات (قراية بس، مفيش أي ترحيل) ---------- */
function hc_(id, name, nameEn, fn) {
  const r = { id: id, name: name, name_en: nameEn, status: 'ok', msg: '', fix: '', fix_en: '' };
  try {
    const o = fn() || {};
    r.status = o.status || 'ok'; r.msg = o.msg || ''; r.fix = o.fix || ''; r.fix_en = o.fix_en || '';
  } catch (err) {
    r.status = 'error';
    r.msg = String((err && err.message) || err).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').substring(0, 220);
  }
  return r;
}
function hcGet_(url, headers) {
  const res = UrlFetchApp.fetch(url, { headers: headers || {}, muteHttpExceptions: true });
  return { code: res.getResponseCode(), text: res.getContentText().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').substring(0, 200) };
}
function hcFix_(r, ar, en) { if (r.status !== 'ok') { r.fix = r.fix || ar; r.fix_en = r.fix_en || en; } return r; }

function api_healthCheck(t) {
  auth_(t);
  const P = PropertiesService.getScriptProperties();
  const all = P.getProperties();
  const out = [];

  out.push(hcFix_(hc_('qbo', 'كيو بي او', 'QuickBooks', function () {
    const realm = req_('QBO_REALM_ID');
    const res = UrlFetchApp.fetch('https://quickbooks.api.intuit.com/v3/company/' + realm + '/companyinfo/' + realm + '?minorversion=70',
      { headers: { Authorization: 'Bearer ' + getQboToken_(), Accept: 'application/json' }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return { status: 'error', msg: 'HTTP ' + res.getResponseCode() + ': ' + res.getContentText().substring(0, 200) };
    return { msg: JSON.parse(res.getContentText()).CompanyInfo.CompanyName };
  }), 'اربط كيو بي او من جديد، وحط QBO_REFRESH_TOKEN الجديد في الإعدادات.', 'Reconnect QuickBooks and paste the new QBO_REFRESH_TOKEN in Settings.'));

  out.push(hcFix_(hc_('shopify', 'شوبيفاي', 'Shopify', function () {
    return { msg: pqShopify_('{ shop { name } }').data.shop.name };
  }), 'حط CLIENT_ID و CLIENT_SECRET الصح بتوع تطبيق شوبيفاي، وجرّب زرار "فحص اتصال شوبيفاي".', 'Set the Shopify app’s correct CLIENT_ID and CLIENT_SECRET, then use “Check Shopify connection”.'));

  out.push(hcFix_(hc_('bosta', 'بوسطة', 'Bosta', function () {
    const base = req_('BOSTA_FEES_URL').split('?')[0];
    const r = hcGet_(base + '?page=1&pageSize=1', bostaHeaders_());
    return r.code === 200 ? { msg: 'API OK' } : { status: 'error', msg: 'HTTP ' + r.code + ': ' + r.text };
  }), 'حط مفتاح API جديد في BOSTA_API_KEY من لوحة بوسطة.', 'Paste a new API key from the Bosta dashboard into BOSTA_API_KEY.'));

  out.push(hcFix_(hc_('kashier', 'كاشير', 'Kashier', function () {
    const res = kashierGet_(req_('KASHIER_API_URL'));
    const code = res.getResponseCode();
    return code === 200 ? { msg: 'API OK' } : { status: 'error', msg: 'HTTP ' + code };
  }), 'هات توكن جديد من لوحة كاشير وحطه في KASHIER_API_KEY.', 'Get a new token from the Kashier dashboard and paste it into KASHIER_API_KEY.'));

  out.push(hc_('meta', 'ميتا', 'Meta', function () {
    const acc = req_('META_AD_ACCOUNT_ID'), tok = req_('META_TOKEN');
    const a = hcGet_('https://graph.facebook.com/v21.0/act_' + acc + '?fields=name&access_token=' + encodeURIComponent(tok));
    if (a.code !== 200) return { status: 'error', msg: 'HTTP ' + a.code + ': ' + a.text.replace(tok, '***'),
      fix: 'التوكن مرفوض: حط META_TOKEN جديد.', fix_en: 'The token was rejected: paste a new META_TOKEN.' };
    const tx = hcGet_('https://graph.facebook.com/v21.0/act_' + acc + '/transactions?limit=1&access_token=' + encodeURIComponent(tok));
    if (tx.code !== 200) return { status: 'warn', msg: 'Token OK · transactions: HTTP ' + tx.code,
      fix: 'التوكن شغال، بس ترحيل الـ Charges محتاج يتعدل لأن فيسبوك قفل transactions.', fix_en: 'The token works, but posting charges needs an update: Facebook closed the transactions endpoint.' };
    return { msg: 'Token OK' };
  }));

  out.push(hcFix_(hc_('sheets', 'شيتات جوجل', 'Google Sheets', function () {
    const notes = [];
    const po = SpreadsheetApp.openById(req_('SPREAD_SHEET_ID'));
    if (!po.getSheetByName('PO')) return { status: 'error', msg: 'SPREAD_SHEET_ID: tab "PO" missing' };
    const g = SpreadsheetApp.openById(req_('SPREAD_SHEET_ID2')).getSheetByName('GADS_TX');
    if (!g) return { status: 'error', msg: 'SPREAD_SHEET_ID2: tab "GADS_TX" missing' };
    const vals = g.getDataRange().getValues(), H = vals[0].map(function (h) { return String(h).trim().toLowerCase(); });
    const di = H.indexOf('date');
    let newest = '';
    vals.slice(1).forEach(function (r) {
      const d = r[di] instanceof Date ? Utilities.formatDate(r[di], APP.TZ, 'yyyy-MM-dd') : String(r[di]).substring(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d > newest) newest = d;
    });
    notes.push('PO ✓', 'GADS_TX ✓ (' + (newest || '?') + ')');
    const stale = newest && newest < Utilities.formatDate(new Date(Date.now() - 3 * 864e5), APP.TZ, 'yyyy-MM-dd');
    return stale ? { status: 'warn', msg: notes.join(' · '),
      fix: 'تاب GADS_TX آخر بيانات فيه ' + newest + '. اتأكد إن اللي بيملاه لسه شغال.', fix_en: 'The newest row in GADS_TX is ' + newest + '. Check that whatever fills it is still running.' }
      : { msg: notes.join(' · ') };
  }), 'اتأكد من SPREAD_SHEET_ID و SPREAD_SHEET_ID2 وإن الحساب ليه صلاحية عليهم.', 'Check SPREAD_SHEET_ID and SPREAD_SHEET_ID2 and that this account can open them.'));

  out.push(hc_('setup', 'الإعدادات العامة', 'General setup', function () {
    const trig = ScriptApp.getProjectTriggers().length;
    const dry = ['BOSTA_DRY_RUN', 'KASHIER_PAYOUT_DRY_RUN'].filter(function (k) { return String(all[k] || '').toLowerCase() !== 'false'; });
    const msg = 'GO_LIVE_DATE: ' + (all.GO_LIVE_DATE || '—') + ' · schedules: ' + trig + (dry.length ? ' · dry: ' + dry.join(', ') : '');
    if (!all.GO_LIVE_DATE) return { status: 'warn', msg: msg, fix: 'حدد GO_LIVE_DATE في الإعدادات المشتركة.', fix_en: 'Set GO_LIVE_DATE in the shared settings.' };
    if (!trig) return { status: 'warn', msg: msg, fix: 'مفيش ولا موعد شغال: فعّل المواعيد من الرئيسية لما الاتصالات تبقى تمام.', fix_en: 'No schedules are on: turn them on from the overview once the connections are OK.' };
    return { msg: msg };
  }));

  const res = { time: nowStr_(), checks: out };
  P.setProperty('APP_HEALTH', JSON.stringify(res));
  return res;
}

function api_testConnections(t) {
  auth_(t);
  const out = {};
  try {
    const r = UrlFetchApp.fetch('https://quickbooks.api.intuit.com/v3/company/' + req_('QBO_REALM_ID') +
      '/companyinfo/' + req_('QBO_REALM_ID') + '?minorversion=70', {
      headers: { Authorization: 'Bearer ' + getQboToken_(), Accept: 'application/json' }, muteHttpExceptions: true
    });
    out.qbo = r.getResponseCode() === 200
      ? 'متصل: ' + JSON.parse(r.getContentText()).CompanyInfo.CompanyName
      : 'خطأ ' + r.getResponseCode() + ': ' + r.getContentText().substring(0, 200);
  } catch (err) { out.qbo = 'خطأ: ' + err; }
  try {
    out.shopify = 'متصل: ' + pqShopify_('{ shop { name } }').data.shop.name;
  } catch (err) { out.shopify = 'خطأ: ' + err; }
  return out;
}

// ---------- مسح الخصائص غير المطلوبة ----------
// بيتمسح أي مفتاح مش في الإعدادات (المشتركة + إعدادات كل سكريبت) ومش من بيانات الحالة.
// بيانات الحالة (اللي اترحّل قبل كده، الجلسات، السجل) عمرها ما بتتمسح عشان القيود ما تتكررش.
const STATE_KEYS = ['PROCESSED', 'GADS_DAYS_PROCESSED', 'GADS_TX_PROCESSED', 'META_CHARGES_PROCESSED',
  'META_INVOICES_PROCESSED'];

function keepProp_(k) {
  if (/^APP_/.test(k)) return true;                                   // كلمة السر والجلسات والسجل والمواعيد
  if (STATE_KEYS.indexOf(k) > -1) return true;
  if (/^BOSTA_PAYOUT_/.test(k) || /^KASHIER_PAYOUT_/.test(k)) return true;   // تحويلات اترحّلت + إعداداتها
  if (SHARED_PROPS.indexOf(k) > -1) return true;
  return JOBS.some(function (j) { return j.props.indexOf(k) > -1; });
}

function api_cleanupProps(t, apply) {
  auth_(t);
  const P = PropertiesService.getScriptProperties();
  const extra = Object.keys(P.getProperties()).filter(function (k) { return !keepProp_(k); }).sort();
  if (apply) extra.forEach(function (k) { P.deleteProperty(k); });
  return { keys: extra, deleted: !!apply };
}

// استيراد الإعدادات من المشاريع القديمة (JSON من exportAllProps)
function api_importProps(t, text, overwrite) {
  auth_(t);
  text = String(text || '').trim();
  const m = text.match(/[-\w]{25,}/);
  if (text.charAt(0) !== '{' && m) text = DriveApp.getFileById(m[0]).getBlob().getDataAsString();

  let obj;
  try { obj = JSON.parse(text); } catch (err) { throw new Error('النص مش JSON صحيح'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('النص مش JSON صحيح');

  // مشروع المشتريات القديم كان بيستخدم CLIENT_ID_QBO / CLIENT_SECRET_QBO
  if (obj.CLIENT_ID_QBO && !obj.QBO_CLIENT_ID) obj.QBO_CLIENT_ID = obj.CLIENT_ID_QBO;
  if (obj.CLIENT_SECRET_QBO && !obj.QBO_CLIENT_SECRET) obj.QBO_CLIENT_SECRET = obj.CLIENT_SECRET_QBO;

  const P = PropertiesService.getScriptProperties();
  const cur = P.getProperties();
  const res = { added: 0, overwritten: [], skipped: [] };
  const toSet = {};

  // بيانات الدخول تتنقل كمجموعة واحدة عشان الـ refresh token يفضل مع نفس الـ client id
  [['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'QBO_REFRESH_TOKEN', 'QBO_REALM_ID'],
   ['SHOP', 'CLIENT_ID', 'CLIENT_SECRET']].forEach(function (grp) {
    if (!grp.some(function (k) { return obj[k]; })) return;
    const exists = grp.some(function (k) { return cur[k]; });
    grp.forEach(function (k) {
      if (obj[k] === undefined) return;
      if (exists && !overwrite) { if (cur[k] !== obj[k]) res.skipped.push(k); }
      else { if (cur[k] && cur[k] !== obj[k]) res.overwritten.push(k); else if (!cur[k]) res.added++; toSet[k] = obj[k]; }
      delete obj[k];
    });
  });

  Object.keys(obj).forEach(function (k) {
    if (/^APP_/.test(k) || !/^[A-Za-z0-9_\-]+$/.test(k)) return;
    const v = String(obj[k]);
    if (cur[k] === undefined) { toSet[k] = v; res.added++; }
    else if (cur[k] === v) return;
    else if (overwrite) { toSet[k] = v; res.overwritten.push(k); }
    else res.skipped.push(k);
  });

  P.setProperties(toSet, false);
  CacheService.getScriptCache().removeAll(['QBO_ACCESS_TOKEN', 'qbo_access_token', 'shopify_access_token']);
  return res;
}
