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
  FAVICON: 'https://cdn.shopify.com/s/files/1/0690/9218/0245/files/Logo_32_-_32_Pix-01.png?v=1755790239',
  WEBAPP_URL: 'https://script.google.com/macros/s/AKfycby5qiOh4iZ902dce7d7sPaKOmZy3pH92fCqL6mDwAfnPtIIC3ZjRDUlFCVsMhALMTUv/exec',   // يُستخدم لو Script Property WEBAPP_URL فاضية
  TZ: 'Africa/Cairo',
  SESSION_SEC: 6 * 3600,   // 6 ساعات (الحد الأقصى للكاش)
  LOG_TAB: 'Runs',
  LOG_KEEP: 1500,          // عدد صفوف السجل المحفوظة
  LOG_MAX: 45000           // أقصى طول للوج في الخلية
};

const GROUPS = [
  { id: 'A', name: 'المشتريات والإعلانات' },
  { id: 'B', name: 'التحصيلات والمنتجات' }
];

// ---------- كل السكريبتات ----------
// actions: الدوال المسموح تشغيلها من الواجهة
// triggers: المواعيد اللي الواجهة بتديرها (كل تشغيل مجدول بيتسجل في السجل)
const JOBS = [
  {
    id: 'po', group: 'A', name: 'استلام أوامر الشراء ← Bill في QBO',
    desc: 'يسحب التحويلات المستلمة من شوبيفاي، يبعت Excel بالإيميل، وينشئ Bill + قيد إعادة تصنيف.',
    actions: [
      { fn: 'dailyRun', label: 'تشغيل الآن' },
      { fn: 'testOne', label: 'معالجة آخر تحويل مستلم' },
      { fn: 'reclassExistingBills', label: 'إعادة تصنيف الفواتير الحالية', confirm: true },
      { fn: 'markExistingAsProcessed', label: 'اعتبار كل التحويلات الحالية مُعالجة', confirm: true }
    ],
    triggers: [{ fn: 'cron_po', label: 'يومياً', type: 'daily', hour: 15 }],
    props: ['SPREAD_SHEET_ID', 'QBO_INVENTORY_ASSET_ACCOUNT_ID', 'QBO_INVENTORY_OFFSET_ACCOUNT_ID']
  },
  {
    id: 'gads', group: 'A', name: 'Google Ads ← قيود QBO',
    desc: 'يقرأ تاب GADS_TX: مصروف يومي، سداد، وأرصدة.',
    actions: [
      { fn: 'gadsSync50Dry', label: 'تجربة (بدون ترحيل)' },
      { fn: 'gadsSync50Post', label: 'ترحيل آخر 50 حركة' },
      { fn: 'googleAdsDailyRun', label: 'ترحيل من تاب GADS (القديم)', confirm: true }
    ],
    triggers: [{ fn: 'cron_gads', label: 'يومياً', type: 'daily', hour: 10 }],
    props: ['SPREAD_SHEET_ID2', 'QBO_GADS_EXPENSE_ACCOUNT_ID', 'QBO_GADS_CLEARING_ACCOUNT_ID', 'QBO_META_PAYMENT_ACCOUNT_ID']
  },
  {
    id: 'meta', group: 'A', name: 'Meta Ads ← قيود QBO',
    desc: 'المجدول يرحّل الـ Charges فقط. الفواتير يدوي عشان ما يتكررش نفس المبلغ مرتين.',
    actions: [
      { fn: 'metaChargesDryRun', label: 'تجربة Charges' },
      { fn: 'metaChargesPost', label: 'ترحيل Charges' },
      { fn: 'metaInvoicesDry', label: 'تجربة الفواتير' },
      { fn: 'metaInvoicesPost', label: 'ترحيل الفواتير', confirm: true },
      { fn: 'metaFindBusiness', label: 'معرفة Business ID' }
    ],
    triggers: [{ fn: 'cron_meta', label: 'يومياً (Charges)', type: 'daily', hour: 11 }],
    props: ['META_AD_ACCOUNT_ID', 'META_BUSINESS_ID', 'META_TOKEN', 'QBO_META_CLEARING_ACCOUNT_ID', 'QBO_META_PAYMENT_ACCOUNT_ID']
  },
  {
    id: 'bosta', group: 'B', name: 'تحويلات بوسطة ← قيد QBO',
    desc: 'قيد لكل Cash-out: تحصيل كل أوردر، رسوم بوسطة، والكريدت.',
    dryKey: 'BOSTA_DRY_RUN', webhook: 'bosta',
    actions: [
      { fn: 'runSync', label: 'تشغيل الآن' },
      { fn: 'checkProps', label: 'فحص الإعدادات' }
    ],
    triggers: [{ fn: 'cron_bosta', label: 'يومياً', type: 'daily', hour: 12 }],
    props: ['BOSTA_API_KEY', 'BOSTA_AUTH_HEADER_NAME', 'BOSTA_WEBHOOK_TOKEN', 'BOSTA_FEES_URL', 'BOSTA_PAYOUT_ORDERS_URL',
      'BOSTA_PAYOUT_START_DATE', 'BOSTA_DRY_RUN', 'QBO_BOSTA_CLEARING_ACCOUNT_ID', 'QBO_BOSTA_FEES_ACCOUNT_ID',
      'QBO_BOSTA_CREDITS_ACCOUNT_ID']
  },
  {
    id: 'kashier', group: 'B', name: 'تحويلات كاشير ← قيد QBO',
    desc: 'قيد لكل Payout مفصّل بالمدفوعات والرسوم لكل Settlement.',
    dryKey: 'KASHIER_PAYOUT_DRY_RUN',
    actions: [
      { fn: 'kashierPayoutRun', label: 'تشغيل الآن' },
      { fn: 'checkKashierProps', label: 'فحص الإعدادات' },
      { fn: 'kashierWhyEmpty', label: 'ليه مفيش قيود؟' },
      { fn: 'kashierListBooked', label: 'التحويلات المسجلة' },
      { fn: 'kashierCheckUrls', label: 'فحص الروابط' },
      { fn: 'kashierTokenExpiry', label: 'انتهاء التوكن' }
    ],
    triggers: [{ fn: 'cron_kashier', label: 'يومياً', type: 'daily', hour: 13 }],
    props: ['KASHIER_API_KEY', 'KASHIER_AUTH_HEADER', 'KASHIER_API_URL', 'KASHIER_SETTLEMENTS_URL', 'KASHIER_PAYMENTS_URL',
      'KASHIER_PAYOUT_START_DATE', 'KASHIER_PAYOUT_DRY_RUN', 'KASHIER_QBO_CLEARING_ACC_ID', 'KASHIER_FEES_ACC_ID',
      'KASHIER_LOGIN_URL', 'KASHIER_LOGIN_BODY', 'KASHIER_TOKEN_FIELD']
  },
  {
    id: 'products', group: 'B', name: 'مزامنة المنتجات شوبيفاي ← QBO',
    desc: 'الاسم والـ SKU والسعر والتكلفة. الكمية لا تُزامن.',
    webhook: 'pq',
    actions: [
      { fn: 'pqDryRun', label: 'تجربة مزامنة كاملة' },
      { fn: 'pqSyncAll', label: 'مزامنة كاملة الآن', confirm: true },
      { fn: 'pqProcessQueue', label: 'معالجة الطابور' },
      { fn: 'pqClearQueue', label: 'مسح الطابور', confirm: true }
    ],
    triggers: [
      { fn: 'cron_pqQueue', label: 'طابور الويب هوك', type: 'minutes', every: 1 },
      { fn: 'cron_pqDaily', label: 'مزامنة كاملة يومية', type: 'daily', hour: 3 }
    ],
    props: ['WEBHOOK_KEY', 'QBO_INCOME_ACCOUNT_ID', 'QBO_EXPENSE_ACCOUNT_ID', 'QBO_ASSET_ACCOUNT_ID',
      'QBO_INV_START_DATE', 'SHEET_ID']
  }
];

const SHARED_PROPS = ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'QBO_REFRESH_TOKEN', 'QBO_REALM_ID',
  'QBO_UNDEPOSITED_FUNDS_ACCOUNT_ID', 'SHOP', 'CLIENT_ID', 'CLIENT_SECRET', 'EMAIL_TO', 'WEBAPP_URL'];

const SECRET_KEYS = ['QBO_CLIENT_SECRET', 'QBO_REFRESH_TOKEN', 'CLIENT_SECRET', 'CLIENT_SECRET_QBO', 'META_TOKEN',
  'BOSTA_API_KEY', 'BOSTA_WEBHOOK_TOKEN', 'KASHIER_API_KEY', 'KASHIER_LOGIN_BODY', 'KASHIER_TEST_KEY', 'WEBHOOK_KEY'];
const BOOL_KEYS = ['BOSTA_DRY_RUN', 'KASHIER_PAYOUT_DRY_RUN'];

// ---------- المواعيد المجدولة (كلها بتسجل في السجل) ----------
function cron_po()      { cronRun_('po', 'dailyRun'); }
function cron_gads()    { cronRun_('gads', 'gadsSync50Post'); }
function cron_meta()    { cronRun_('meta', 'metaChargesPost'); }
function cron_bosta()   { cronRun_('bosta', 'dailySync'); }
function cron_kashier() { cronRun_('kashier', 'kashierPayoutDaily'); }
function cron_pqDaily() { cronRun_('products', 'pqSyncAll'); }
function cron_pqQueue() {
  if (!pqQueueKeys_().length) return;            // كل دقيقة: ما يسجلش لو الطابور فاضي
  cronRun_('products', 'pqProcessQueue');
}

function cronRun_(jobId, fn) {
  const r = runLogged_(jobId, 'schedule', fn, function () { return globalThis[fn](); });
  if (r.status === 'error') throw new Error(r.error);
}

// ---------- Wrappers ----------
function metaChargesPost()  { return metaChargesLast50(false); }
function metaInvoicesPost() { return metaInvoices(false); }
function pqClearQueue() {
  const P = PropertiesService.getScriptProperties();
  const keys = pqQueueKeys_();
  keys.forEach(function (k) { P.deleteProperty(k); });
  console.log('Cleared ' + keys.length + ' queued products');
}

/* ============================================================
   WEB APP
   ============================================================ */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP.TITLE)
    .setFaviconUrl(APP.FAVICON)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  const p = (e && e.parameter) || {};
  if (p.src === 'pq') return pqHandleWebhook_(e);   // شوبيفاي محتاج رد في أقل من 5 ثواني
  const r = runLogged_('bosta', 'webhook', 'handleBostaWebhook_', function () { return handleBostaWebhook_(e); });
  return r.result || json_({ ok: false, error: r.error });
}

/* ============================================================
   تسجيل التشغيل
   ============================================================ */

function runLogged_(jobId, source, action, fn) {
  const buf = [];
  const t0 = Date.now();
  const restore = hookConsole_(buf);
  try { Logger.clear(); } catch (x) {}

  let result, error = '';
  try {
    result = fn();
  } catch (err) {
    error = String((err && err.message) || err);
    buf.push('ERROR: ' + ((err && err.stack) || err));
  } finally {
    restore();
  }

  let lg = '';
  try { lg = Logger.getLog(); } catch (x) {}
  const text = ((lg ? lg + '\n' : '') + buf.join('\n')).trim();
  const resText = resultText_(result);
  const status = error ? 'error'
    : /"error"\s*:|FAILED|Failed /.test(resText + '\n' + text) ? 'warn' : 'ok';
  const lines = text.split('\n').filter(String);
  const summary = (error || resText || lines[lines.length - 1] || 'تم بدون مخرجات').substring(0, 300);
  const secs = Math.round((Date.now() - t0) / 100) / 10;
  const time = Utilities.formatDate(new Date(), APP.TZ, 'yyyy-MM-dd HH:mm:ss');
  const id = Utilities.getUuid().substring(0, 8);

  writeLog_([id, time, jobId, source, action, status, secs, summary,
    (resText ? 'RESULT: ' + resText + '\n\n' : '') + text]);

  PropertiesService.getScriptProperties().setProperty('APP_LAST_' + jobId,
    JSON.stringify({ time: time, status: status, action: action, source: source, summary: summary.substring(0, 200) }));

  if (status === 'error' && source !== 'manual') {
    const to = PropertiesService.getScriptProperties().getProperty('EMAIL_TO');
    if (to) {
      try { MailApp.sendEmail(to, 'QBO app FAILED: ' + jobId + ' / ' + action, error); } catch (x) {}
    }
  }

  return { id: id, status: status, error: error, summary: summary, secs: secs,
    log: text.slice(-20000), result: result };
}

function hookConsole_(buf) {
  const saved = {};
  ['log', 'info', 'warn', 'error'].forEach(function (k) {
    saved[k] = console[k];
    try {
      console[k] = function () {
        try {
          buf.push((k === 'log' || k === 'info' ? '' : k.toUpperCase() + ': ') +
            Array.prototype.map.call(arguments, function (a) {
              return typeof a === 'string' ? a : JSON.stringify(a);
            }).join(' '));
        } catch (x) {}
        return saved[k].apply(console, arguments);
      };
    } catch (x) {}
  });
  return function () {
    Object.keys(saved).forEach(function (k) { try { console[k] = saved[k]; } catch (x) {} });
  };
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
  return sh;
}

function writeLog_(row) {
  try {
    row[8] = String(row[8]).substring(0, APP.LOG_MAX);
    const sh = logSheet_();
    sh.insertRowBefore(2);
    const range = sh.getRange(2, 1, 1, row.length);
    range.setNumberFormat('@');
    range.setValues([row.map(function (v) { return typeof v === 'number' ? v : String(v); })]);
    const last = sh.getLastRow();
    if (last > APP.LOG_KEEP + 1) sh.deleteRows(APP.LOG_KEEP + 2, last - APP.LOG_KEEP - 1);
  } catch (err) {
    console.error('Log write failed: ' + err);
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
  if (kind === 'pq') {
    const k = P.getProperty('WEBHOOK_KEY');
    return k ? base + '?key=' + encodeURIComponent(k) + '&src=pq' : '';
  }
  return '';
}

function api_state(t) {
  auth_(t);
  const P = PropertiesService.getScriptProperties();
  const all = P.getProperties();
  const trig = ScriptApp.getProjectTriggers();
  const known = {};

  const jobs = JOBS.map(function (j) {
    return {
      id: j.id, group: j.group, name: j.name, desc: j.desc || '',
      actions: j.actions,
      last: JSON.parse(all['APP_LAST_' + j.id] || 'null'),
      dryKey: j.dryKey || '',
      dry: j.dryKey ? String(all[j.dryKey] || '').toLowerCase() === 'true' : null,
      webhook: j.webhook ? webhookUrl_(j.webhook) : null,
      queue: j.id === 'products' ? Object.keys(all).filter(function (k) { return k.indexOf('PQ_Q_') === 0; }).length : null,
      triggers: j.triggers.map(function (tr) {
        known[tr.fn] = 1;
        return {
          fn: tr.fn, label: tr.label, type: tr.type, every: tr.every || null,
          hour: Number(all['APP_TRG_' + tr.fn] || tr.hour || 0),
          enabled: trig.some(function (x) { return x.getHandlerFunction() === tr.fn; })
        };
      })
    };
  });

  const others = trig.filter(function (x) { return !known[x.getHandlerFunction()]; })
    .map(function (x) { return { id: x.getUniqueId(), fn: x.getHandlerFunction(), type: String(x.getEventType()) }; });

  return {
    groups: GROUPS, jobs: jobs, others: others,
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

  if (enabled) {
    if (def.type === 'minutes') {
      ScriptApp.newTrigger(fn).timeBased().everyMinutes(def.every || 1).create();
    } else {
      const h = Math.max(0, Math.min(23, Number(hour)));
      PropertiesService.getScriptProperties().setProperty('APP_TRG_' + fn, String(h));
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
  const n = Math.min(last - 1, jobId ? 1000 : Math.min(Number(limit) || 150, 500));
  return sh.getRange(2, 1, n, 8).getDisplayValues()
    .filter(function (r) { return !jobId || r[2] === jobId; })
    .slice(0, Number(limit) || 150)
    .map(function (r) {
      return { id: r[0], time: r[1], job: r[2], source: r[3], action: r[4], status: r[5], secs: r[6], summary: r[7] };
    });
}

function api_logDetail(t, id) {
  auth_(t);
  const sh = logSheet_();
  const cell = sh.getRange('A:A').createTextFinder(String(id)).matchEntireCell(true).findNext();
  if (!cell) throw new Error('السجل غير موجود');
  const r = sh.getRange(cell.getRow(), 1, 1, 9).getDisplayValues()[0];
  return { id: r[0], time: r[1], job: r[2], source: r[3], action: r[4], status: r[5], secs: r[6], summary: r[7], log: r[8] };
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
  if (/^APP_/.test(k) || /^PQ_Q_/.test(k) || /PROCESSED$/.test(k)) return true;
  if (/^KASHIER_PAYOUT_BT-/.test(k)) return true;
  if (/^BOSTA_PAYOUT_/.test(k) && k !== 'BOSTA_PAYOUT_START_DATE' && k !== 'BOSTA_PAYOUT_ORDERS_URL') return true;
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

  const sections = [{ id: 'shared', name: 'إعدادات مشتركة (QBO + شوبيفاي)', items: SHARED_PROPS.map(mk) }]
    .concat(JOBS.map(function (j) { return { id: j.id, name: j.name, items: j.props.map(mk) }; }));

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
