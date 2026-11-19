/*********************************************************
 * Kashier payout -> QuickBooks Online journal
 *
 * Flow: payout (BT-...) = sum of settlements (STB-...) in its window
 *       settlement = sum of payments (settlementBatchId = STB-...)
 * Journal per payout:
 *   Dr Kashier clearing         net payout
 *   Cr Undeposited funds        one line per payment
 *   Dr Kashier fees             one line per settlement (fees + VAT)
 *
 * Needs from Bosta.gs: req_, getQboToken_, qboPost_
 * الموعد اليومي بيتدار من الواجهة (cron_kashier).
 *********************************************************/

// ---------- Entry points ----------

// Run from the editor or the dashboard (respects KASHIER_PAYOUT_DRY_RUN)
function kashierPayoutRun() {
  const r = kashierSyncPayouts_();
  out_('', JSON.stringify(r));
  return r;
}

// Used by the daily trigger (errors show up in the dashboard log)
function kashierPayoutDaily() {
  return kashierSyncPayouts_();
}

// Lists which properties are set (no values printed)
function checkKashierProps() {
  const P = PropertiesService.getScriptProperties();
  const need = ['KASHIER_API_KEY', 'KASHIER_API_URL', 'KASHIER_SETTLEMENTS_URL', 'KASHIER_PAYMENTS_URL',
    'KASHIER_FEES_ACC_ID', 'KASHIER_QBO_CLEARING_ACC_ID', 'QBO_UNDEPOSITED_FUNDS_ACCOUNT_ID',
    'KASHIER_PAYOUT_START_DATE', 'KASHIER_PAYOUT_DRY_RUN'];
  const optional = ['KASHIER_AUTH_HEADER', 'KASHIER_LOGIN_URL', 'KASHIER_LOGIN_BODY', 'KASHIER_TOKEN_FIELD'];
  need.forEach(k => out_('', (P.getProperty(k) ? 'OK       ' : 'MISSING  ') + k));
  optional.forEach(k => out_('', (P.getProperty(k) ? 'OK       ' : 'not set  ') + k + ' (optional)'));
  out_('', 'DRY RUN is ' + (kashierDryRun_() ? 'ON (nothing is posted)' : 'OFF (journals are POSTED to QBO)'));
}

// ---------- Small helpers ----------

function kashierProp_(name) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  return v ? String(v).trim() : '';
}

function kashierDryRun_() {
  return kashierProp_('KASHIER_PAYOUT_DRY_RUN').toLowerCase() !== 'false';   // أي حاجة غير false = تجربة
}

function kashierStartDate_() {
  const s = kashierProp_('KASHIER_PAYOUT_START_DATE') || '9999-12-31';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error('KASHIER_PAYOUT_START_DATE must look like 2026-10-04, got: [' + s + ']');
  }
  return s;
}

function kashierShiftDate_(ymd, days) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function kashierCairoDay_(iso) {
  return Utilities.formatDate(new Date(iso), 'Africa/Cairo', 'yyyy-MM-dd');
}

const kashierR2_ = x => Math.round(Number(x) * 100) / 100;

// ---------- Kashier API: auth ----------

function kashierHeaders_() {
  const h = {};
  h[kashierProp_('KASHIER_AUTH_HEADER') || 'Authorization'] = req_('KASHIER_API_KEY');
  return h;
}

// Optional auto-login. Needs KASHIER_LOGIN_URL, KASHIER_LOGIN_BODY (JSON text),
// KASHIER_TOKEN_FIELD (path to the token in the response, e.g. "token" or "data.token")
function kashierLogin_() {
  const r = UrlFetchApp.fetch(req_('KASHIER_LOGIN_URL'), {
    method: 'post',
    contentType: 'application/json',
    payload: req_('KASHIER_LOGIN_BODY'),
    muteHttpExceptions: true
  });
  if (r.getResponseCode() >= 300) {
    throw new Error('Kashier login failed ' + r.getResponseCode() + ': ' + r.getContentText().substring(0, 200));
  }
  const body = JSON.parse(r.getContentText());
  const field = req_('KASHIER_TOKEN_FIELD');
  const token = field.split('.').reduce((o, k) => (o ? o[k] : undefined), body);
  if (!token) throw new Error('No token at "' + field + '". Response keys: ' + Object.keys(body).join(','));
  PropertiesService.getScriptProperties().setProperty('KASHIER_API_KEY', String(token));
}

// GET that logs in again once if the session expired (only when login is configured)
function kashierGet_(url) {
  let r = UrlFetchApp.fetch(url, { headers: kashierHeaders_(), muteHttpExceptions: true });
  if (r.getResponseCode() === 401 && kashierProp_('KASHIER_LOGIN_URL')) {
    kashierLogin_();
    r = UrlFetchApp.fetch(url, { headers: kashierHeaders_(), muteHttpExceptions: true });
  }
  return r;
}

// Shows when the current token expires (prints no secret)
function kashierTokenExpiry() {
  const t = req_('KASHIER_API_KEY').replace(/^Bearer\s+/i, '');
  if (t.split('.').length !== 3) {
    out_('WARN', 'KASHIER_API_KEY مش توكن JWT، فمفيش تاريخ انتهاء جواه. لو الروابط بترجع 401 أو 404، هات توكن جديد من لوحة كاشير.');
    return;
  }
  const payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(t.split('.')[1])).getDataAsString());
  out_('', 'issued:  ' + (payload.iat ? new Date(payload.iat * 1000).toISOString() : '?'));
  out_('', 'expires: ' + (payload.exp ? new Date(payload.exp * 1000).toISOString() : '?'));
}

// ---------- Kashier API: lists ----------

// Pages through a list (newest first). Stops once items are older than stopBefore (YYYY-MM-DD).
function kashierFetchList_(baseUrl, stopBefore, dateField) {
  const parts = baseUrl.split('?');
  const qs = (parts[1] || '').split('&').filter(s => s && !/^page=/i.test(s));
  let all = [], prevFirstId = null;
  const rowKey = x => String(x._id || x.transactionId || x.originReference || JSON.stringify(x));

  for (let p = 1; p <= 30; p++) {
    const url = parts[0] + '?' + qs.concat('page=' + p).join('&');
    const r = kashierGet_(url);
    if (r.getResponseCode() === 404 && p > 1) break;          // بعض روابط كاشير بترجع 404 بعد آخر صفحة
    if (r.getResponseCode() !== 200) {
      throw new Error('Kashier ' + r.getResponseCode() + ' on ' + parts[0].replace(/^https?:\/\/[^/]+/, '') + ' page ' + p + ': ' +
        r.getContentText().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').substring(0, 200));
    }
    const body = JSON.parse(r.getContentText());
    const list = Array.isArray(body.data) ? body.data : Array.isArray(body.body) ? body.body : null;
    if (!list) throw new Error('Unexpected Kashier response, keys: ' + Object.keys(body).join(','));

    if (!list.length || rowKey(list[0]) === prevFirstId) break;   // empty, or API ignored the page param
    prevFirstId = rowKey(list[0]);
    all = all.concat(list);

    const last = list[list.length - 1];
    const oldest = String(last[dateField] || last.createdAt || '').slice(0, 10);
    const pages = body.pagination && body.pagination.pages;
    if ((oldest && oldest < stopBefore) || !pages || p >= pages) break;
  }
  return all;
}

function kashierMapPayout_(raw) {
  return {
    id:    String(raw.originReference || raw._id),
    date:  kashierCairoDay_(raw.valueDate),
    net:   Math.abs(Number(raw.amount)),
    gross: Math.abs(Number(raw.originalAmount))
  };
}

function kashierMapSettlement_(raw) {
  const gross = Math.abs(Number(raw.originalAmount));
  const net = Math.abs(Number(raw.amount));
  return {
    id: String(raw.originReference),
    gross: gross,
    net: net,
    fee: kashierR2_(gross - net),                 // fees + VAT
    method: (raw.metaData && raw.metaData.method) || ''
  };
}

function kashierMapPayment_(raw) {
  const notes = (raw.metaData && raw.metaData.displayNotes) || {};
  return {
    id:      String(raw.transactionId),
    batch:   String(raw.settlementBatchId),
    amount:  kashierR2_(raw.amount),
    order:   String(raw.orderReference || ''),
    shopify: String(notes['Shopify Order Id'] || ''),
    method:  String(raw.method || '')
  };
}

// ---------- Main sync ----------

function kashierSyncPayouts_() {
  const P = PropertiesService.getScriptProperties();
  // نفس السكريبت مش بيشتغل مرتين مع بعض: القفل في runLogged_ (Core.gs)، فمفيش قفل هنا يعطّل باقي السكريبتات
  try {
    const start = kashierStartDate_();
    const dry = kashierDryRun_();

    // payouts, oldest first (the one before the first payout of the range defines its window)
    const payouts = kashierFetchList_(req_('KASHIER_API_URL'), kashierShiftDate_(start, -10), 'valueDate')
      .filter(t => t.operation === 'payout' && t.isReflected)
      .sort((a, b) => a.valueDate < b.valueDate ? -1 : 1);

    const settlements = kashierFetchList_(req_('KASHIER_SETTLEMENTS_URL'), kashierShiftDate_(start, -10), 'valueDate')
      .filter(t => t.operation === 'settlement' && t.isReflected);

    // approved, captured payments grouped by their settlement batch (STB-...)
    const payByBatch = {};
    kashierFetchList_(kashierPaymentsUrl_(kashierShiftDate_(start, -21)), kashierShiftDate_(start, -21), 'date')
      .filter(t => t.type === 'PAYMENT' && t.status === 'Approved' && t.lastStatus === 'CAPTURED' && t.settlementBatchId)
      .map(kashierMapPayment_)
      .forEach(p => { (payByBatch[p.batch] = payByBatch[p.batch] || []).push(p); });

    const results = [];
    payouts.forEach((raw, i) => {
      if (i === 0) return;                                   // needs a previous payout for its window
      const po = kashierMapPayout_(raw);
      if (po.date < start) return;
      const key = 'KASHIER_PAYOUT_' + po.id;
      if (P.getProperty(key)) return;                        // already booked

      try {
        const prev = payouts[i - 1];
        const sts = settlements
          .filter(s => s.valueDate > prev.valueDate && s.valueDate <= raw.valueDate)
          .sort((a, b) => a.valueDate < b.valueDate ? -1 : a.valueDate > b.valueDate ? 1
                         : (a.originReference < b.originReference ? -1 : 1))
          .map(kashierMapSettlement_);

        const je = kashierBuildJournal_(po, sts, payByBatch);

        if (dry) {
          out_('', JSON.stringify(je, null, 2));
          results.push({ payout: po.id, dry: true, settlements: sts.length, lines: je.Line.length });
          return;
        }
        const res = qboPost_('journalentry', je);
        P.setProperty(key, String(res.JournalEntry.Id));
        results.push({ payout: po.id, qboId: res.JournalEntry.Id, settlements: sts.length, lines: je.Line.length });
      } catch (err) {
        out_('ERROR', err);
        results.push({ payout: po.id, error: String(err) });
      }
    });
    return { ok: true, dryRun: dry, results: results };
  } finally {
    // nothing to release
  }
}

// ---------- Journal builder ----------

function kashierBuildJournal_(po, sts, payByBatch) {
  const CLEARING = req_('KASHIER_QBO_CLEARING_ACC_ID');
  const FEES     = req_('KASHIER_FEES_ACC_ID');
  const UNDEP    = req_('QBO_UNDEPOSITED_FUNDS_ACCOUNT_ID');
  const r2 = kashierR2_;

  if (!sts.length) throw new Error('Kashier payout ' + po.id + ': no settlements found in its window');

  // settlements must explain the payout exactly
  const netSum = r2(sts.reduce((s, x) => s + x.net, 0));
  if (Math.abs(netSum - po.net) > 0.01) {
    throw new Error('Kashier payout ' + po.id + ' does not match its settlements: payout net ' + po.net +
      ' vs settlements net ' + netSum + ' (diff ' + r2(po.net - netSum) + ') | ' + sts.map(s => s.id).join(','));
  }

  const lines = [];
  const add = (type, acct, amt, desc) => {
    amt = r2(amt);
    if (!amt) return;
    lines.push({
      DetailType: 'JournalEntryLineDetail',
      Amount: amt,
      Description: String(desc).substring(0, 400),
      JournalEntryLineDetail: { PostingType: type, AccountRef: { value: acct } }
    });
  };

  add('Debit', CLEARING, po.net, 'Kashier payout net ' + po.id);

  let itemized = 0;
  sts.forEach(s => {
    const pays = ((payByBatch && payByBatch[s.id]) || []).slice().sort((a, b) => a.id < b.id ? -1 : 1);
    const paySum = r2(pays.reduce((x, p) => x + p.amount, 0));

    if (pays.length && Math.abs(paySum - s.gross) <= 0.01) {
      // one credit line per payment
      pays.forEach(p => add('Credit', UNDEP, p.amount,
        'Payment ' + p.id + ' | ' + p.order + (p.shopify ? ' | Shopify ' + p.shopify : '') + ' | ' + p.method));
      itemized++;
    } else {
      // payments missing or not adding up: book the settlement as one line instead
      if (pays.length) {
        out_('WARN', 'Settlement ' + s.id + ': payments ' + paySum + ' != settlement ' + s.gross + ', booked as one line');
      }
      add('Credit', UNDEP, s.gross, 'Settlement ' + s.id + (s.method ? ' (' + s.method + ')' : ''));
    }
    add('Debit', FEES, s.fee, 'Kashier fees + VAT, settlement ' + s.id);
  });

  // Balance check: if it fails, nothing is posted
  const sum = t => lines.filter(l => l.JournalEntryLineDetail.PostingType === t)
                        .reduce((x, l) => x + l.Amount, 0);
  const dr = r2(sum('Debit')), cr = r2(sum('Credit'));
  if (Math.abs(dr - cr) > 0.01) {
    throw new Error('Kashier payout ' + po.id + ' does not balance: Dr ' + dr + ' vs Cr ' + cr +
      ' (diff ' + r2(cr - dr) + ')');
  }

  return {
    DocNumber: po.id.replace('BT-', 'KP-').substring(0, 21),
    TxnDate: po.date,
    PrivateNote: 'Kashier payout ' + po.id + ' (' + sts.length + ' settlements, ' + itemized + ' itemized)',
    Line: lines
  };
}

// ---------- Maintenance tools ----------

// Lists payouts already booked by this script
function kashierListBooked() {
  const all = PropertiesService.getScriptProperties().getProperties();
  Object.keys(all).filter(k => k.indexOf('KASHIER_PAYOUT_BT-') === 0)
    .forEach(k => out_('', k + ' -> QBO journal ' + all[k]));
}

// Un-books payouts so a rerun can post them again.
// Delete their journals in QBO FIRST, otherwise you create duplicates.
function kashierClearBooked() {
  const ids = [
    // 'BT-1792472991507-443',
  ];
  const P = PropertiesService.getScriptProperties();
  ids.forEach(id => P.deleteProperty('KASHIER_PAYOUT_' + id));
  out_('', 'cleared ' + ids.length);
}

// Reads one journal back from QBO (posts nothing)
function kashierCheckJournal() {
  const id = '9003';
  const r = UrlFetchApp.fetch('https://quickbooks.api.intuit.com/v3/company/' + req_('QBO_REALM_ID') +
    '/journalentry/' + id + '?minorversion=70', {
    headers: { Authorization: 'Bearer ' + getQboToken_(), Accept: 'application/json' },
    muteHttpExceptions: true
  });
  out_('', r.getResponseCode() + ' ' + r.getContentText().substring(0, 800));
}

// STEP 1: run with DELETE = false. It only shows what it would delete.
// STEP 2: set DELETE = true and run again.
function kashierDeleteBookedJournals() {
  const DELETE = false;
  const ids = [
    // 'BT-1791695130565-374',
  ];
  const P = PropertiesService.getScriptProperties();
  const base = 'https://quickbooks.api.intuit.com/v3/company/' + req_('QBO_REALM_ID') + '/journalentry';
  const hdr = { Authorization: 'Bearer ' + getQboToken_(), Accept: 'application/json' };

  ids.forEach(id => {
    const key = 'KASHIER_PAYOUT_' + id;
    const qboId = P.getProperty(key);
    if (!qboId) { out_('', id + ': not booked, skipped'); return; }

    const g = UrlFetchApp.fetch(base + '/' + qboId + '?minorversion=70', { headers: hdr, muteHttpExceptions: true });
    if (g.getResponseCode() !== 200) { out_('', id + ': cannot read QBO ' + qboId + ' -> ' + g.getResponseCode()); return; }
    const je = JSON.parse(g.getContentText()).JournalEntry;

    // safety: only delete a journal that really belongs to this payout
    if (String(je.PrivateNote || '').indexOf(id) === -1) {
      out_('', id + ': QBO ' + qboId + ' does not match this payout, skipped');
      return;
    }
    out_('', id + ': QBO ' + qboId + ' | ' + je.DocNumber + ' | ' + je.TxnDate + ' | lines=' + je.Line.length);
    if (!DELETE) return;

    const d = UrlFetchApp.fetch(base + '?operation=delete&minorversion=70', {
      method: 'post', contentType: 'application/json', headers: hdr,
      payload: JSON.stringify({ Id: je.Id, SyncToken: je.SyncToken }),
      muteHttpExceptions: true
    });
    if (d.getResponseCode() < 300) {
      P.deleteProperty(key);
      out_('', id + ': DELETED');
    } else {
      out_('', id + ': delete failed ' + d.getResponseCode() + ' ' + d.getContentText().substring(0, 200));
    }
  });
}

function kashierTestPublicApi() {
  const key = kashierProp_('KASHIER_TEST_KEY');
  if (!key) throw new Error('Add script property KASHIER_TEST_KEY first');
  const host = 'https://api.kashier.io';
  const get = u => UrlFetchApp.fetch(host + u, { headers: { Authorization: key }, muteHttpExceptions: true });
  const rows = b => Array.isArray(b.data) ? b.data : Array.isArray(b.body) ? b.body : [];

  const tests = {
    ledger:       '/v2/balance/records/ACC-32674-427-01?page=1&limit=20',
    transactions: '/v2/aggregator/transactions?page=1&limit=5',
    settled:      '/v2/aggregator/settlement-transactions?page=1&limit=5'
  };
  let ledgerBody = null;
  Object.keys(tests).forEach(k => {
    const r = get(tests[k]);
    out_('', k + ' -> ' + r.getResponseCode() + ' ' + r.getContentText().substring(0, 140));
    if (k === 'ledger' && r.getResponseCode() === 200) ledgerBody = JSON.parse(r.getContentText());
  });

  // does payout-details give the payments of a payout directly?
  if (ledgerBody) {
    const po = rows(ledgerBody).find(x => x.operation === 'payout');
    if (po) {
      const r = get('/v2/balance/payout-details/' + po._id + '?page=1&limit=20');
      out_('', 'payout-details (' + po.originReference + ') -> ' + r.getResponseCode() + ' ' + r.getContentText().substring(0, 400));
    }
  }
}

function kashierCheckUrls() {
  ['KASHIER_API_URL', 'KASHIER_SETTLEMENTS_URL', 'KASHIER_PAYMENTS_URL'].forEach(name => {
    const url = kashierProp_(name);
    if (!url) { out_('', name + ': MISSING'); return; }
    const r = kashierGet_(url);
    out_('', name + ' -> ' + r.getResponseCode() + ' | ' + url.split('?')[0]);
  });
}

function kashierCheckShapes() {
  const rows = b => Array.isArray(b.data) ? b.data : Array.isArray(b.body) ? b.body : [];
  const load = name => {
    const r = kashierGet_(kashierProp_(name));
    if (r.getResponseCode() !== 200) throw new Error(name + ' -> ' + r.getResponseCode());
    return rows(JSON.parse(r.getContentText()));
  };
  const count = (list, f) => list.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});

  const po = load('KASHIER_API_URL'), st = load('KASHIER_SETTLEMENTS_URL'), pay = load('KASHIER_PAYMENTS_URL');
  out_('', 'payouts url rows: ' + po.length + ' | by operation: ' + JSON.stringify(count(po, x => x.operation)));
  out_('', 'settlements url rows: ' + st.length + ' | by operation: ' + JSON.stringify(count(st, x => x.operation)));
  out_('', 'payments rows: ' + pay.length);

  const need = ['transactionId', 'type', 'status', 'lastStatus', 'amount', 'orderReference', 'settlementBatchId', 'date'];
  out_('', 'payment fields missing on first row: ' +
    (pay[0] ? (need.filter(k => pay[0][k] === undefined).join(',') || 'none') : 'no rows'));
  out_('', 'payments approved+captured: ' + pay.filter(t => t.type === 'PAYMENT' && t.status === 'Approved' && t.lastStatus === 'CAPTURED').length +
    ' | with settlementBatchId: ' + pay.filter(t => t.settlementBatchId).length);
}

function kashierCheckPaging() {
  ['KASHIER_API_URL', 'KASHIER_SETTLEMENTS_URL', 'KASHIER_PAYMENTS_URL'].forEach(name => {
    const url = kashierProp_(name).replace(/([?&])page=\d+/i, '$1page=1');
    const r = kashierGet_(url);
    const b = JSON.parse(r.getContentText());
    out_('', name + ' -> pagination: ' + JSON.stringify(b.pagination) + ' | top keys: ' + Object.keys(b).join(','));
  });
}

function kashierShowPaymentsQuery() {
  const url = kashierProp_('KASHIER_PAYMENTS_URL');
  out_('', 'path: ' + url.split('?')[0]);
  (url.split('?')[1] || '').split('&').forEach(p => out_('', '  ' + p));
}

// Rebuilds the payments URL with a rolling date range, ignoring the dates saved in the property
function kashierPaymentsUrl_(fromYmd) {
  const parts = req_('KASHIER_PAYMENTS_URL').split('?');
  const qs = (parts[1] || '').split('&').filter(s => s && !/^(startDate|endDate)=/i.test(s));
  const tomorrow = kashierShiftDate_(Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd'), 1);
  qs.push('startDate=' + fromYmd + 'T00:00:00.000Z');
  qs.push('endDate=' + tomorrow + 'T23:59:59.999Z');
  return parts[0] + '?' + qs.join('&');
}

function kashierWhyEmpty() {
  const start = kashierStartDate_();
  out_('', 'start date: [' + start + '] | dry run: ' + kashierDryRun_());

  const raw = kashierFetchList_(kashierProp_('KASHIER_API_URL'), kashierShiftDate_(start, -10), 'valueDate');
  const po = raw.filter(t => t.operation === 'payout');
  const tally = {};
  po.forEach(t => { const k = String(t.isReflected); tally[k] = (tally[k] || 0) + 1; });
  out_('', 'rows fetched: ' + raw.length + ' | payouts: ' + po.length + ' | isReflected values: ' + JSON.stringify(tally));
  if (po[0]) out_('', 'payout fields: ' + Object.keys(po[0]).join(','));

  po.sort((a, b) => a.valueDate < b.valueDate ? -1 : 1).forEach(t => {
    const booked = kashierProp_('KASHIER_PAYOUT_' + t.originReference);
    out_('', t.originReference + ' | ' + t.valueDate + ' | reflected=' + t.isReflected +
      ' | ' + (booked ? 'BOOKED (QBO ' + booked + ')' : 'not booked') +
      ' | ' + (kashierCairoDay_(t.valueDate) < start ? 'before start date' : 'in range'));
  });
}
