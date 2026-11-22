function metaChargesLast50(dryRun) {
  const p = PropertiesService.getScriptProperties();
  const done = JSON.parse(p.getProperty('META_CHARGES_PROCESSED') || '[]');
  const url = 'https://graph.facebook.com/v21.0/act_' + p.getProperty('META_AD_ACCOUNT_ID') +
    '/transactions?limit=50&fields=id,time,status,charge_type,provider_amount,payment_option' +
    '&access_token=' + p.getProperty('META_TOKEN');
  const r = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
  const res = JSON.parse(r.getContentText());
  if (!res.data) throw new Error(r.getContentText());

  res.data.forEach(function (t) {
    if (done.includes(t.id)) return;
    if (t.status && t.status !== 'PAID' && t.status !== 'COMPLETED') return;
    const amt = Number(t.provider_amount && t.provider_amount.amount);
    if (!amt) return;
    const day = Utilities.formatDate(new Date(t.time), 'Africa/Cairo', 'yyyy-MM-dd');
    if (beforeGoLive_(day)) { Logger.log(day + ' | ' + t.id + ' | before GO_LIVE_DATE, skipped'); return; }
    const desc = 'Meta Ads charge ' + t.id;
    if (dryRun) { Logger.log(day + ' | ' + amt + ' | ' + t.id + ' | ' + t.status); return; }

    const je = {
      DocNumber: 'MC-' + String(t.id).slice(-18),
      TxnDate: day,
      PrivateNote: desc,
      Line: [
        metaLine_('Debit',  amt, p.getProperty('QBO_META_CLEARING_ACCOUNT_ID'), desc),
        metaLine_('Credit', amt, p.getProperty('QBO_META_PAYMENT_ACCOUNT_ID'),  desc)
      ]
    };
    qboPost_('journalentry', je);   // بيتأكد الأول إن رقم المستند مش موجود في QBO
    done.push(t.id);
    p.setProperty('META_CHARGES_PROCESSED', fitJson_(done.slice(-300)));
  });
}

function metaChargesDryRun() { metaChargesLast50(true); }
function metaInvoicesDryRun() {
  const p = PropertiesService.getScriptProperties();
  const end = new Date(), start = new Date(Date.now() - 90 * 864e5);
  const f = function (d) { return Utilities.formatDate(d, 'Africa/Cairo', 'yyyy-MM-dd'); };
  const url = 'https://graph.facebook.com/v21.0/' + p.getProperty('META_BUSINESS_ID') +
    '/business_invoices?start_date=' + f(start) + '&end_date=' + f(end) +
    '&limit=50&access_token=' + p.getProperty('META_TOKEN');
  const r = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
  Logger.log(r.getContentText());
}
function metaFindBusiness() {
  const p = PropertiesService.getScriptProperties();
  const url = 'https://graph.facebook.com/v21.0/act_' + p.getProperty('META_AD_ACCOUNT_ID') +
    '?fields=name,business&access_token=' + p.getProperty('META_TOKEN');
  const r = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
  Logger.log(r.getContentText());
}
function metaInvoices(dryRun) {
  const p = PropertiesService.getScriptProperties();
  const done = JSON.parse(p.getProperty('META_INVOICES_PROCESSED') || '[]');
  const f = function (d) { return Utilities.formatDate(d, 'Africa/Cairo', 'yyyy-MM-dd'); };
  const url = 'https://graph.facebook.com/v21.0/' + p.getProperty('META_BUSINESS_ID') +
    '/business_invoices?start_date=' + f(new Date(Date.now() - 180 * 864e5)) +
    '&end_date=' + f(new Date()) + '&limit=50' +
    '&fields=id,invoice_id,invoice_date,payment_status,type,amount_due,billed_amount_details' +
    '&access_token=' + p.getProperty('META_TOKEN');
  const r = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
  const res = JSON.parse(r.getContentText());
  if (!res.data) throw new Error(r.getContentText().replace(/access_token=[^&"]+/g, ''));
  if (!res.data.length) { Logger.log('No invoices returned'); return; }

  res.data.forEach(function (inv) {
    const amt = Number(inv.amount_due && inv.amount_due.amount);
    Logger.log([inv.invoice_id, inv.invoice_date, inv.payment_status, inv.type, amt].join(' | '));
    if (dryRun || done.includes(inv.id)) return;
    if (inv.payment_status !== 'PAID' || inv.type !== 'INVOICE' || !amt) return;
    if (beforeGoLive_(inv.invoice_date)) { Logger.log(inv.invoice_id + ' before GO_LIVE_DATE, skipped'); return; }

    const desc = 'Meta Ads invoice ' + inv.invoice_id;
    const je = {
      DocNumber: 'MI-' + String(inv.invoice_id).slice(-18),
      TxnDate: inv.invoice_date,
      PrivateNote: desc,
      Line: [
        metaLine_('Debit',  amt, p.getProperty('QBO_META_CLEARING_ACCOUNT_ID'), desc),
        metaLine_('Credit', amt, p.getProperty('QBO_META_PAYMENT_ACCOUNT_ID'),  desc)
      ]
    };
    qboPost_('journalentry', je);   // بيتأكد الأول إن رقم المستند مش موجود في QBO
    done.push(inv.id);
    p.setProperty('META_INVOICES_PROCESSED', fitJson_(done.slice(-300)));
  });
}

function metaInvoicesDry() { metaInvoices(true); }

/* ============================================================
 * مصروف ميتا اليومي (بديل الـ Charges بعد ما فيسبوك قفل transactions)
 *
 * بيقرا مصروف كل يوم من Insights ويرحّل قيد واحد لكل يوم بعد ما اليوم يخلص:
 *   مدين  QBO_META_EXPENSE_ACCOUNT_ID   (مصروف إعلانات ميتا)
 *   دائن  QBO_META_CLEARING_ACCOUNT_ID  (ميتا وسيط = المستحق لميتا)
 * الدفع لميتا (كارت البنك) بيدخل من الـ bank feed في QBO ويتطابق على حساب ميتا الوسيط.
 * الأمان: META_DAYS_PROCESSED + فحص رقم المستند META-yyyy-MM-dd في QBO + GO_LIVE_DATE.
 * ============================================================ */
function metaSpendSync(dryRun) {
  const t0 = Date.now(), p = PropertiesService.getScriptProperties();
  const acc = req_('META_AD_ACCOUNT_ID'), tok = req_('META_TOKEN');
  const tz = 'Africa/Cairo', today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const f = function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };
  const since = f(new Date(Date.now() - 35 * 864e5)), until = f(new Date(Date.now() - 864e5));
  const exp = dryRun ? p.getProperty('QBO_META_EXPENSE_ACCOUNT_ID') : req_('QBO_META_EXPENSE_ACCOUNT_ID');
  const clr = dryRun ? p.getProperty('QBO_META_CLEARING_ACCOUNT_ID') : req_('QBO_META_CLEARING_ACCOUNT_ID');
  if (dryRun && !exp) out_('WARN', 'WARN: QBO_META_EXPENSE_ACCOUNT_ID لسه مش متحدد (حساب مصروف إعلانات ميتا). لازم قبل الترحيل.');

  // كل الأيام من Insights (مع الصفحات)
  let url = 'https://graph.facebook.com/v21.0/act_' + acc + '/insights?level=account&time_increment=1&limit=100' +
    '&fields=' + encodeURIComponent('spend,account_currency,date_start') +
    '&time_range=' + encodeURIComponent(JSON.stringify({ since: since, until: until })) +
    '&access_token=' + encodeURIComponent(tok);
  const rows = [];
  for (let page = 0; url && page < 10; page++) {
    const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const body = r.getContentText();
    let res; try { res = JSON.parse(body); } catch (e) { res = {}; }
    if (r.getResponseCode() >= 300 || !res.data) {
      throw new Error('Meta Insights HTTP ' + r.getResponseCode() + ': ' + body.split(tok).join('***').substring(0, 400));
    }
    res.data.forEach(function (x) { rows.push(x); });
    url = res.paging && res.paging.next;
  }
  rows.sort(function (a, b) { return a.date_start < b.date_start ? -1 : 1; });

  const done = JSON.parse(p.getProperty('META_DAYS_PROCESSED') || '[]');
  const sum = { days: rows.length, posted: 0, pending: 0, done: 0, beforeGoLive: 0, total: 0, currency: '' };
  for (let i = 0; i < rows.length; i++) {
    if (Date.now() - t0 > 270000) { out_('WARN', 'WARN: وقف قبل حد الوقت، شغّله تاني يكمّل.'); break; }
    const day = rows[i].date_start, amt = Math.round(Number(rows[i].spend || 0) * 100) / 100;
    sum.currency = rows[i].account_currency || sum.currency;
    if (!amt || day >= today) continue;
    let state;
    if (done.indexOf(day) > -1) { state = 'DONE'; sum.done++; }
    else if (beforeGoLive_(day)) { state = 'before GO_LIVE_DATE'; sum.beforeGoLive++; }
    else { state = dryRun ? 'NEW' : 'POST'; sum.pending++; sum.total = Math.round((sum.total + amt) * 100) / 100; }
    out_('', day + ' | ' + amt + ' ' + (rows[i].account_currency || '') + ' | ' + state);
    if (state !== 'POST') continue;

    const desc = 'Meta Ads spend ' + day;
    const je = { DocNumber: 'META-' + day, TxnDate: day, PrivateNote: desc + ' | act_' + acc,
      Line: [metaLine_('Debit', amt, exp, desc), metaLine_('Credit', amt, clr, desc)] };
    qboPost_('journalentry', je);   // بيتأكد الأول إن رقم المستند مش موجود في QBO
    done.push(day);
    p.setProperty('META_DAYS_PROCESSED', fitJson_(done.slice(-120)));
    sum.posted++;
  }
  if (goLive_()) out_('', 'GO_LIVE_DATE ' + goLive_() + ': الأيام قبله مش بتترحّل');
  return sum;
}
function metaSpendDry()  { return metaSpendSync(true); }
function metaSpendPost() { return metaSpendSync(false); }
