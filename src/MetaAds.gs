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
