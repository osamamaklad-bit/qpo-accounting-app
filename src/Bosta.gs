/*********************************************************
 * Bosta payout (cash out) -> QuickBooks Online journal
 *
 * doPost موجودة في Core.gs (بتحوّل الويب هوك هنا).
 * الملف ده فيه كمان دوال QBO المشتركة لكل المشروع:
 *   req_, getQboToken_, qboPost_, json_
 *********************************************************/

// ---------- Entry points ----------

function handleBostaWebhook_(e) {
  if (!e || !e.parameter) throw new Error('Run via the web app URL. To test from the editor, run runSync.');
  if (e.parameter.token !== req_('BOSTA_WEBHOOK_TOKEN')) return json_({ ok: false, error: 'unauthorized' });
  out_('', 'Bosta webhook body: ' + (e.postData ? e.postData.contents : ''));
  return json_(syncBostaPayouts_()); // webhook is only a "ping"
}

// Run from the editor or the dashboard (respects BOSTA_DRY_RUN)
function runSync() {
  const r = syncBostaPayouts_();
  out_('', JSON.stringify(r));
  return r;
}

// Used by the daily trigger (cron_bosta)
function dailySync() {
  return syncBostaPayouts_();
}

// Lists which required properties are set (no secrets printed)
function checkProps() {
  const P = PropertiesService.getScriptProperties();
  const need = ['BOSTA_WEBHOOK_TOKEN','BOSTA_API_KEY','BOSTA_AUTH_HEADER_NAME','BOSTA_FEES_URL',
    'BOSTA_PAYOUT_ORDERS_URL','BOSTA_PAYOUT_START_DATE','BOSTA_DRY_RUN','QBO_CLIENT_ID','QBO_CLIENT_SECRET',
    'QBO_REFRESH_TOKEN','QBO_REALM_ID','QBO_BOSTA_CLEARING_ACCOUNT_ID','QBO_BOSTA_FEES_ACCOUNT_ID',
    'QBO_UNDEPOSITED_FUNDS_ACCOUNT_ID'];
  need.forEach(k => out_('', (P.getProperty(k) ? 'OK       ' : 'MISSING  ') + k));
}

// ---------- Main sync ----------

function syncBostaPayouts_() {
  const P = PropertiesService.getScriptProperties();
  // نفس السكريبت مش بيشتغل مرتين مع بعض: القفل في runLogged_ (Core.gs)، فمفيش قفل هنا يعطّل باقي السكريبتات
  try {
    const start = laterDate_(P.getProperty('BOSTA_PAYOUT_START_DATE') || '9999-12-31', goLive_());   // مش قبل GO_LIVE_DATE
    const dry = String(P.getProperty('BOSTA_DRY_RUN') || '').trim().toLowerCase() !== 'false';   // أي حاجة غير false = تجربة
    const tx = fetchBostaTransactions_(3); // newest first

    const payouts = tx.filter(t => t.category === 2)
      .sort((a, b) => a.transaction_date < b.transaction_date ? -1 : 1); // oldest first

    const results = [];
    payouts.forEach((po, i) => {
      if (i === 0) return; // needs a previous payout to define its window
      if (po.transaction_date.slice(0, 10) < start) return;
      const key = 'BOSTA_PAYOUT_' + po.transaction_id;
      if (P.getProperty(key)) return; // already booked

      try {
        const prev = payouts[i - 1];
        // other items inside this payout's window (e.g. pickup fees, category 13)
        const extras = tx.filter(t => [0, 1, 2].indexOf(t.category) === -1 &&
          t.transaction_date > prev.transaction_date && t.transaction_date < po.transaction_date);
        const orders = fetchBostaPayoutOrders_(po.transaction_id);
        const je = buildBostaPayoutJournal_(po, extras, orders);

        if (dry) {
          out_('', JSON.stringify(je, null, 2));
          results.push({ payout: po.transaction_id, dry: true, lines: je.Line.length });
          return;
        }
        const res = qboPost_('journalentry', je);
        P.setProperty(key, String(res.JournalEntry.Id));
        results.push({ payout: po.transaction_id, qboId: res.JournalEntry.Id });
      } catch (err) {
        out_('ERROR', err);
        results.push({ payout: po.transaction_id, error: String(err) });
      }
    });
    return { ok: true, dryRun: dry, results: results };
  } finally {
    // nothing to release
  }
}

// ---------- Bosta API ----------

function req_(name) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error('Missing script property: ' + name);
  return String(v).trim();
}

function bostaHeaders_() {
  const P = PropertiesService.getScriptProperties();
  const h = {};
  h[(P.getProperty('BOSTA_AUTH_HEADER_NAME') || 'Authorization').trim()] = req_('BOSTA_API_KEY');
  return h;
}

function fetchPaged_(baseUrl, maxPages) {
  if (!baseUrl) throw new Error('fetchPaged_ received an empty URL');

  // drop any paging params already in the saved URL; keep the other filters
  const parts = baseUrl.split('?');
  const qs = (parts[1] || '').split('&').filter(s => s && !/^(page|limit|pageSize)=/i.test(s));

  let all = [];
  for (let p = 1; p <= maxPages; p++) {
    // Bosta needs page & pageSize BEFORE the other params
    const url = parts[0] + '?page=' + p + '&pageSize=50' + (qs.length ? '&' + qs.join('&') : '');
    if (p === 1) out_('', 'Bosta GET ' + url);
    const r = UrlFetchApp.fetch(url, { headers: bostaHeaders_(), muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw new Error('Bosta ' + r.getResponseCode() + ': ' + r.getContentText().substring(0, 300));
    const body = JSON.parse(r.getContentText());
    const d = body.data;
    if (!d || !Array.isArray(d.list)) {
      throw new Error('Unexpected Bosta response from ' + parts[0] +
        ' | top-level keys: ' + Object.keys(body).join(',') +
        ' | data keys: ' + (d && typeof d === 'object' ? Object.keys(d).join(',') : typeof d));
    }
    all = all.concat(d.list);
    if (!d.pages || p >= d.pages) break;
  }
  return all;
}

// Test ONE payout. LIVE=false only logs the journal; LIVE=true posts it to QBO.
function testOnePayout() {
  const ID = 'THUCOD15OCT26';   // <-- payout to test
  const LIVE = false;          // <-- change to true to post

  const P = PropertiesService.getScriptProperties();
  const key = 'BOSTA_PAYOUT_' + ID;
  if (LIVE && P.getProperty(key)) throw new Error(ID + ' is already booked (QBO journal ' + P.getProperty(key) + ')');

  const tx = fetchBostaTransactions_(3);
  const payouts = tx.filter(t => t.category === 2)
    .sort((a, b) => a.transaction_date < b.transaction_date ? -1 : 1);
  const i = payouts.findIndex(p => p.transaction_id === ID);
  if (i === -1) throw new Error(ID + ' not found in the latest transactions');
  if (i === 0) throw new Error(ID + ' is the oldest payout fetched, so its window is unknown');

  const po = payouts[i], prev = payouts[i - 1];
  const extras = tx.filter(t => [0, 1, 2].indexOf(t.category) === -1 &&
    t.transaction_date > prev.transaction_date && t.transaction_date < po.transaction_date);
  const orders = fetchBostaPayoutOrders_(ID);
  const je = buildBostaPayoutJournal_(po, extras, orders);

  out_('', JSON.stringify(je, null, 2));
  out_('', 'Lines: ' + je.Line.length + ' | orders: ' + orders.length + ' | extras: ' + extras.length);

  if (!LIVE) { out_('', 'DRY: nothing posted. Set LIVE = true to post.'); return; }
  const res = qboPost_('journalentry', je);
  P.setProperty(key, String(res.JournalEntry.Id));
  out_('', 'POSTED to QBO, journal id ' + res.JournalEntry.Id + ', DocNumber ' + je.DocNumber);
}

function fetchBostaTransactions_(maxPages) {
  return fetchPaged_(req_('BOSTA_FEES_URL'), maxPages);
}

function fetchBostaPayoutOrders_(payoutId) {
  const base = req_('BOSTA_PAYOUT_ORDERS_URL').replace('{id}', encodeURIComponent(payoutId));
  return fetchPaged_(base, 20);
}

// ---------- Journal builder ----------

function buildBostaPayoutJournal_(po, extras, orders) {
  const P = PropertiesService.getScriptProperties();
  const CLEARING = req_('QBO_BOSTA_CLEARING_ACCOUNT_ID');
  const FEES     = req_('QBO_BOSTA_FEES_ACCOUNT_ID');
  const UNDEP    = req_('QBO_UNDEPOSITED_FUNDS_ACCOUNT_ID');
  const CREDITS  = (P.getProperty('QBO_BOSTA_CREDITS_ACCOUNT_ID') || FEES).trim();
  const r2 = x => Math.round(Number(x) * 100) / 100;

  const lines = [];
  const add = (type, acct, amt, desc) => {
    amt = r2(amt);
    if (!amt) return;
    lines.push({
      DetailType: 'JournalEntryLineDetail',
      Amount: amt,
      Description: desc,
      JournalEntryLineDetail: { PostingType: type, AccountRef: { value: acct } }
    });
  };

  // Net payout
  add('Debit', CLEARING, po.amount, 'Bosta payout net ' + po.transaction_id);

  // Per order: cash collection + Bosta fee
  let credits = 0;
  orders.forEach(o => {
    const cash = Number(o.cash_collected) + Number(o.online_payment_amount || 0);
    add('Credit', UNDEP, cash, 'Cash collection of order ' + o.tracking_number);
    add('Debit', FEES, o.bosta_fees, 'Bosta fee of order ' + o.tracking_number);
    credits += Number(o.bosta_credits_consumed || 0);
  });

  // Credits: only post the credits line if it is what makes the entry balance
  const sum = type => lines.filter(l => l.JournalEntryLineDetail.PostingType === type)
                           .reduce((s, l) => s + l.Amount, 0);
  let dr = r2(sum('Debit')), cr = r2(sum('Credit'));
  credits = r2(credits);

  if (credits > 0) {
    if (Math.abs((cr - dr) - 0) <= 0.01) {
      // already balanced: order fees are net of credits, so no credits line
    } else if (Math.abs(dr - (cr + credits)) <= 0.01) {
      // credits paid part of the fees: the payout is higher than cash - fees
      add('Credit', CREDITS, credits, 'Bosta credits consumed');
      dr = r2(sum('Debit')); cr = r2(sum('Credit'));
    } else if (Math.abs((dr + credits) - cr) <= 0.01) {
      // credits were deducted on top of the fees: the payout is lower than cash - fees
      add('Debit', CREDITS, credits, 'Bosta credits consumed');
      dr = r2(sum('Debit')); cr = r2(sum('Credit'));
    }
  }

  if (Math.abs(dr - cr) > 0.01) {
    throw new Error('Payout ' + po.transaction_id + ' does not match its orders: Dr ' + dr +
      ' vs Cr ' + cr + ' (diff ' + r2(cr - dr) + ')');
  }

  return {
    DocNumber: po.transaction_id.substring(0, 21),
    TxnDate: po.transaction_date.slice(0, 10),
    PrivateNote: 'Bosta payout ' + po.transaction_id,
    Line: lines
  };
}

// ---------- QuickBooks Online (shared by every file) ----------

// The argument is ignored (older files pass props).
function getQboToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('QBO_ACCESS_TOKEN');
  if (cached) return cached;

  // تجديد واحد بس في نفس الوقت: لو مهمتين احتاجوا توكن مع بعض، التانية بتاخد التوكن اللي الأولى جددته
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const again = cache.get('QBO_ACCESS_TOKEN');
    if (again) return again;
    return refreshQboToken_(cache);
  } finally {
    lock.releaseLock();
  }
}

function refreshQboToken_(cache) {
  const P = PropertiesService.getScriptProperties();
  const basic = Utilities.base64Encode(req_('QBO_CLIENT_ID') + ':' + req_('QBO_CLIENT_SECRET'));
  const r = UrlFetchApp.fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'post',
    headers: { Authorization: 'Basic ' + basic, Accept: 'application/json' },
    contentType: 'application/x-www-form-urlencoded',
    payload: { grant_type: 'refresh_token', refresh_token: req_('QBO_REFRESH_TOKEN') },
    muteHttpExceptions: true
  });
  if (r.getResponseCode() !== 200) throw new Error('QBO token refresh failed: ' + r.getContentText());
  const t = JSON.parse(r.getContentText());
  if (t.refresh_token) P.setProperty('QBO_REFRESH_TOKEN', t.refresh_token); // keep rotated token
  cache.put('QBO_ACCESS_TOKEN', t.access_token, 3000);
  return t.access_token;
}

function qboPost_(entity, payload) {
  const r = UrlFetchApp.fetch('https://quickbooks.api.intuit.com/v3/company/' + req_('QBO_REALM_ID') + '/' + entity + '?minorversion=70', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + getQboToken_(), Accept: 'application/json' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  if (r.getResponseCode() >= 300) throw new Error('QBO ' + r.getResponseCode() + ': ' + r.getContentText());
  return JSON.parse(r.getContentText());
}

// ---------- Helpers ----------

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function testCycles() {
  const b = 'https://app.bosta.co/api/v2/wallet/cycles';
  const variants = {
    'A payout id, cat 2':      b + '?page=1&pageSize=50&transaction_id=THUCOD15OCT26&category=2',
    'B payout id, no cat':     b + '?page=1&pageSize=50&transaction_id=THUCOD15OCT26',
    'C cash cycle id, cat 0':  b + '?page=1&pageSize=50&transaction_id=3243107216&category=0',
    'D fees cycle id, cat 1':  b + '?page=1&pageSize=50&transaction_id=3247063402&category=1',
    'E cashout_id param':      b + '?page=1&pageSize=50&cashout_id=THUCOD15OCT26'
  };
  Object.keys(variants).forEach(k => {
    const r = UrlFetchApp.fetch(variants[k], { headers: bostaHeaders_(), muteHttpExceptions: true });
    const t = r.getContentText();
    let info = t.substring(0, 150);
    try {
      const d = JSON.parse(t).data;
      if (d && d.list) info = 'OK rows=' + d.list.length + ' total=' + d.total +
        ' first=' + (d.list[0] ? Object.keys(d.list[0]).slice(0, 8).join(',') : '-');
    } catch (e) {}
    out_('', k + ' -> ' + r.getResponseCode() + ' ' + info);
  });
}
