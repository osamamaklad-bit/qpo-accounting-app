function googleAdsDailyRun() {
  const p = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.openById(p.getProperty('SPREAD_SHEET_ID2'));
  Logger.log('Sheet: ' + ss.getUrl());
  const sh = ss.getSheetByName('GADS');
  if (!sh) { Logger.log('NO TAB named GADS'); return; }
  if (!sh.getLastRow()) { Logger.log('GADS tab is empty'); return; }
  const done = JSON.parse(p.getProperty('GADS_DAYS_PROCESSED') || '[]');
  Logger.log('Already processed: ' + done.join(', '));
  const rows = sh.getRange(1, 1, sh.getLastRow(), 3).getDisplayValues();

  rows.forEach(function (r, i) {
    const day = r[0], amt = Number(String(r[1]).replace(/,/g, ''));
    Logger.log('Row ' + (i + 1) + ': ' + JSON.stringify(r));
    if (!day) { Logger.log(' -> skipped: empty date'); return; }
    if (!amt) { Logger.log(' -> skipped: amount is 0 or not a number'); return; }
    if (done.includes(day)) { Logger.log(' -> skipped: already processed'); return; }
    if (beforeGoLive_(day)) { Logger.log(' -> skipped: before GO_LIVE_DATE'); return; }
    if (day >= Utilities.formatDate(new Date(), 'Africa/Cairo', 'yyyy-MM-dd')) { Logger.log(' -> skipped: day not finished yet'); return; }
    const desc = 'Google Ads spend ' + day + ' (' + r[2] + ')';
    const je = {
      DocNumber: 'GADS-' + day, TxnDate: day, PrivateNote: desc,
      Line: [
        metaLine_('Debit',  amt, p.getProperty('QBO_GADS_EXPENSE_ACCOUNT_ID'),  desc),
        metaLine_('Credit', amt, p.getProperty('QBO_GADS_CLEARING_ACCOUNT_ID'), desc)
      ]
    };
    const q = UrlFetchApp.fetch(
      'https://quickbooks.api.intuit.com/v3/company/' + p.getProperty('QBO_REALM_ID') + '/journalentry?minorversion=70', {
      method: 'post', contentType: 'application/json',
      headers: {Authorization: 'Bearer ' + getQboToken_(p), Accept: 'application/json'},
      payload: JSON.stringify(je), muteHttpExceptions: true
    });
    if (q.getResponseCode() >= 300) throw new Error(q.getContentText());
    done.push(day);
    p.setProperty('GADS_DAYS_PROCESSED', fitJson_(done.slice(-60)));
    Logger.log(' -> POSTED ' + day + ' ' + amt);
  });
}
function writeTestRow() {
  const p = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.openById(p.getProperty('SPREAD_SHEET_ID2'));
  const sh = ss.getSheetByName('GADS') || ss.insertSheet('GADS');
  const row = sh.getLastRow() + 1;
  sh.getRange(row, 1).setNumberFormat('@').setValue('2026-10-11');
  sh.getRange(row, 2, 1, 2).setValues([[10, 'EGP']]);
}
function metaLine_(type, amt, acctId, desc) {
  return {
    DetailType: 'JournalEntryLineDetail', Amount: amt, Description: desc,
    JournalEntryLineDetail: {PostingType: type, AccountRef: {value: acctId}}
  };
}
function gadsSync50(dryRun) {
  const t0 = Date.now(), p = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.openById(p.getProperty('SPREAD_SHEET_ID2'));
  const sh = ss.getSheetByName('GADS_TX');
  if (!sh) throw new Error('No tab GADS_TX | tabs: ' + ss.getSheets().map(function (s) { return s.getName(); }).join(', '));
  const v = sh.getDataRange().getDisplayValues();
  const raw = sh.getDataRange().getValues();
  const sheetTz = ss.getSpreadsheetTimeZone() || 'Africa/Cairo';
  let badDates = 0;
  const H = v[0].map(function (h) { return String(h).trim().toLowerCase(); });
  const c = {date: H.indexOf('date'), type: H.indexOf('type'), desc: H.indexOf('description'),
             cost: H.indexOf('costs'), credit: H.indexOf('credits'), bal: H.indexOf('running balance')};
  if ([c.date, c.type, c.cost, c.credit].some(function (x) { return x < 0; })) throw new Error('Headers not recognised: ' + H.join(' | '));
  const num = function (s) { const n = Number(String(s).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };

  // 1) تجميع الأحداث
  const byDay = {}, events = [], seen = {};
  v.slice(1).forEach(function (r, i) {
    const day = gadsDay_(raw[i + 1][c.date], r[c.date], sheetTz);
    if (!day) { if (String(r[c.date]).trim()) badDates++; return; }
    const text = (String(r[c.type]) + ' ' + String(c.desc >= 0 ? r[c.desc] : '')).trim();
    const low = text.toLowerCase();
    const cost = num(r[c.cost]), credit = num(r[c.credit]);

    if (/declin|fail|reject|insufficient/.test(low)) return;          // دفعة فاشلة
    if (/payment/.test(low)) {                                         // سداد
      let amt = Math.abs(credit || cost);
      if (!amt) { const m = text.match(/for\s+([\d,]+\.?\d*)/i); if (m) amt = num(m[1]); }
      const base = ['PAY', day, text.slice(0, 40), amt, c.bal >= 0 ? r[c.bal] : ''].join('|');
      seen[base] = (seen[base] || 0) + 1;
      events.push({kind: 'PAY', day: day, amt: amt, signed: 1, key: seen[base] > 1 ? base + '#' + seen[base] : base, text: text});
    } else if (credit !== 0) {                                         // رصيد/تسوية
      const base = ['CR', day, text.slice(0, 40), credit, c.bal >= 0 ? r[c.bal] : ''].join('|');
      seen[base] = (seen[base] || 0) + 1;
      events.push({kind: 'CREDIT', day: day, amt: Math.abs(credit), signed: credit > 0 ? 1 : -1, key: seen[base] > 1 ? base + '#' + seen[base] : base, text: text});
    } else if (cost) {                                                 // مصروف (يُجمع باليوم)
      byDay[day] = (byDay[day] || 0) + cost;
    }
  });
  // مصروف اليوم بيترحّل بعد ما اليوم يخلص بس (بتوقيت القاهرة)، عشان ما يترحّلش ناقص
  const today = Utilities.formatDate(new Date(), 'Africa/Cairo', 'yyyy-MM-dd');
  Object.keys(byDay).forEach(function (day) {
    if (day >= today) { Logger.log(day + ' | EXP | ' + byDay[day] + ' | WAIT: day not finished yet'); return; }
    events.push({kind: 'EXP', day: day, amt: Math.round(byDay[day] * 100) / 100, signed: 1, key: day, text: 'spend'});
  });

  if (badDates) out_('WARN', 'WARN: ' + badDates + ' صف اتخطّى لأن التاريخ مش مفهوم. خلي عمود Date تاريخ حقيقي أو بصيغة yyyy-MM-dd.');

  // 2) أحدث 50 حركة
  events.sort(function (a, b) { return a.day < b.day ? 1 : a.day > b.day ? -1 : 0; });
  const list = events.filter(function (e) {
    if (!beforeGoLive_(e.day)) return true;
    return false;                                   // قبل GO_LIVE_DATE: مش بيترحّل
  }).slice(0, 50);
  if (goLive_()) Logger.log('GO_LIVE_DATE ' + goLive_() + ': الحركات قبله مش بتترحّل');

  const doneDays = JSON.parse(p.getProperty('GADS_DAYS_PROCESSED') || '[]');
  const doneTx = JSON.parse(p.getProperty('GADS_TX_PROCESSED') || '[]');
  const exp = p.getProperty('QBO_GADS_EXPENSE_ACCOUNT_ID'), clr = p.getProperty('QBO_GADS_CLEARING_ACCOUNT_ID'), pay = p.getProperty('QBO_META_PAYMENT_ACCOUNT_ID');
  let n = 0;

  for (const e of list) {
    if (Date.now() - t0 > 270000) { Logger.log('Time limit, run again'); break; }
    const isDone = e.kind === 'EXP' ? doneDays.includes(e.key) : doneTx.includes(e.key);
    Logger.log([e.day, e.kind, e.amt, isDone ? 'DONE' : 'NEW', e.text.slice(0, 50)].join(' | '));
    if (!e.amt || isDone || dryRun) continue;

    let dr, cr, doc;
    if (e.kind === 'EXP')      { dr = exp; cr = clr; doc = 'GADS-' + e.day; }
    else if (e.kind === 'PAY') { dr = clr; cr = pay; doc = 'GT-' + e.day.replace(/-/g, '') + '-' + (Math.abs(hash_(e.key)) % 100000); }
    else {                       dr = e.signed > 0 ? clr : exp; cr = e.signed > 0 ? exp : clr; doc = 'GC-' + e.day.replace(/-/g, '') + '-' + (Math.abs(hash_(e.key)) % 100000); }
    const desc = 'Google Ads ' + e.kind + ' ' + e.day;
    const je = {DocNumber: doc, TxnDate: e.day, PrivateNote: desc,
                Line: [metaLine_('Debit', e.amt, dr, desc), metaLine_('Credit', e.amt, cr, desc)]};
    const q = UrlFetchApp.fetch('https://quickbooks.api.intuit.com/v3/company/' + p.getProperty('QBO_REALM_ID') + '/journalentry?minorversion=70', {
      method: 'post', contentType: 'application/json',
      headers: {Authorization: 'Bearer ' + getQboToken_(p), Accept: 'application/json'},
      payload: JSON.stringify(je), muteHttpExceptions: true});
    if (q.getResponseCode() >= 300) throw new Error(q.getContentText());
    if (e.kind === 'EXP') { doneDays.push(e.key); p.setProperty('GADS_DAYS_PROCESSED', fitJson_(doneDays.slice(-400))); }
    else { doneTx.push(e.key); p.setProperty('GADS_TX_PROCESSED', fitJson_(doneTx.slice(-400))); }
    n++;
  }
  Logger.log('Posted ' + n);
}
// التاريخ من الخلية نفسها لو تاريخ حقيقي، أو من النص لو yyyy-MM-dd أو صيغة يفهمها JavaScript
function gadsDay_(rawVal, disp, tz) {
  if (rawVal instanceof Date && !isNaN(rawVal)) return Utilities.formatDate(rawVal, tz, 'yyyy-MM-dd');
  const s = String(disp || rawVal || '').trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  const sl = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);   // 11/19/2026 (شهر/يوم) زي الأول، و19/11/2026 لو أول رقم > 12
  if (sl) {
    const a = Number(sl[1]), b = Number(sl[2]);
    const mon = a > 12 ? b : a, day = a > 12 ? a : b;
    return mon > 12 || day > 31 ? '' : sl[3] + '-' + ('0' + mon).slice(-2) + '-' + ('0' + day).slice(-2);
  }
  const d = new Date(s);
  return isNaN(d) ? '' : Utilities.formatDate(d, 'Africa/Cairo', 'yyyy-MM-dd');
}
function hash_(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
function gadsSync50Dry()  { gadsSync50(true); }
function gadsSync50Post() { gadsSync50(false); }
