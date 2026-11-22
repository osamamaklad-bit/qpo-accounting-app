/*********************************************************
 * Alex.gs — مندوب إسكندرية (شيت "Orders Flow" ← تاب "Alex orders") ← قيد QBO
 *
 * الشيت = مستند صرف نقدية لدفعة أوردرات مع المندوب:
 *   صف الإجماليات: E = إجمالي التحصيل، F = الشحن الإجمالي، G = الصافي (المقدم)
 *   صف العناوين فيه "شحن اجمالي"، وبعده الأوردرات:
 *   A العنوان · B العدد · C صفة الشحنة · D نوع الخدمة · E قيمة الأوردر · F شحن · G مقدم · H رقم الأوردر · I التليفون
 *
 * القيد (الفلوس بتروح الصندوق):
 *   مدين الصندوق                  = إجمالي التحصيل - الشحن
 *   مدين مصروف شحن المندوب        = الشحن
 *   دائن التحصيلات (Undeposited)   = قيمة كل أوردر (سطر لكل أوردر)
 *
 * الأمان: ALEX_DRY_RUN (أي قيمة غير false = تجربة)، GO_LIVE_DATE، ونفس الدفعة مينفعش تترحّل مرتين (ALEX_POSTED).
 *********************************************************/

const ALEX = { POSTED: 'ALEX_POSTED', DRY: 'ALEX_DRY_RUN', HIST: 'ALEX_HIST', HIST_MAX: 30 };

// سجل الصندوق: كل دفعة اترحّلت {d, key, n, total, ship, net, cum (إجمالي اللي دخل الصندوق لحد الدفعة دي), q, o (أرقام الأوردرات)}
function alexHist_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(ALEX.HIST) || '[]'); } catch (e) { return []; }
}
// أوردرات اترحّلت في دفعات قبل كده (عشان نفس الأوردر ميتحسبش مرتين)
function alexDupOrders_(b) {
  const seen = {};
  alexHist_().forEach(function (h) { String(h.o || '').split(' ').forEach(function (o) { if (o) seen[o] = h.d; }); });
  return b.orders.filter(function (o) { return seen[o.order]; }).map(function (o) { return o.order + ' (' + seen[o.order] + ')'; });
}
function alexProblems_(b, c) {
  const dup = alexDupOrders_(b);
  return dup.length ? c.problems.concat(['أوردرات اترحّلت في دفعة قبل كده: ' + dup.join('، ')]) : c.problems;
}

function alexDry_() { return String(PropertiesService.getScriptProperties().getProperty(ALEX.DRY) || '').trim().toLowerCase() !== 'false'; }
function alexNum_(v) {
  const s = String(v == null ? '' : v).replace(/[٠-٩]/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'.indexOf(d); }).replace(/[,\s]/g, '');
  const n = Number(s);
  return isNaN(n) ? NaN : Math.round(n * 100) / 100;
}

// بيقرا الدفعة الحالية من التاب
function alexReadBatch_() {
  const P = PropertiesService.getScriptProperties();
  const tab = (P.getProperty('ALEX_TAB') || 'Alex orders').trim();
  const sh = SpreadsheetApp.openById(req_('ALEX_SHEET_ID')).getSheetByName(tab);
  if (!sh) throw new Error('التاب "' + tab + '" مش موجود في شيت ALEX_SHEET_ID');
  const v = sh.getDataRange().getDisplayValues();

  let head = -1;
  for (let i = 0; i < v.length; i++) {
    if (v[i].some(function (c) { return /شحن\s*اجمالي|شحن\s*إجمالي/.test(c); })) { head = i; break; }
  }
  if (head < 1) throw new Error('مش لاقي صف العناوين (اللي فيه "شحن اجمالي") في التاب "' + tab + '"');

  const tot = v[head - 1];
  const batch = { tab: tab, total: alexNum_(tot[4]), shipping: alexNum_(tot[5]), net: alexNum_(tot[6]), orders: [] };

  for (let i = head + 1; i < v.length; i++) {
    const r = v[i], no = String(r[7] || '').trim();
    if (!/^#?\d+$/.test(no)) continue;
    const val = alexNum_(r[4]);
    batch.orders.push({ row: i + 1, order: no.charAt(0) === '#' ? no : '#' + no, value: isNaN(val) ? 0 : val,
      shipping: alexNum_(r[5]) || 0, service: String(r[3] || '').trim(), address: String(r[0] || '').trim() });
  }
  return batch;
}

// مفتاح الدفعة = أرقام الأوردرات مرتبة (نفس الأوردرات = نفس الدفعة)
function alexKey_(batch) {
  const ids = batch.orders.map(function (o) { return o.order; }).sort().join(',');
  const d = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, ids, Utilities.Charset.UTF_8);
  return d.slice(0, 5).map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function alexCheck_(b) {
  const problems = [];
  if (!b.orders.length) problems.push('مفيش أوردرات في التاب');
  const sum = Math.round(b.orders.reduce(function (s, o) { return s + o.value; }, 0) * 100) / 100;
  if (!isNaN(b.total) && Math.abs(sum - b.total) > 0.01) problems.push('مجموع الأوردرات ' + sum + ' مش مساوي لإجمالي التحصيل ' + b.total);
  if (isNaN(b.shipping)) problems.push('الشحن الإجمالي مش رقم');
  const total = isNaN(b.total) ? sum : b.total, ship = isNaN(b.shipping) ? 0 : b.shipping;
  if (!isNaN(b.net) && Math.abs((total - ship) - b.net) > 0.01) problems.push('الصافي ' + b.net + ' مش مساوي للإجمالي ناقص الشحن (' + (total - ship) + ')');
  return { problems: problems, sum: sum, total: total, ship: ship, net: Math.round((total - ship) * 100) / 100 };
}

function alexBuildJournal_(b, c, key) {
  const cash = req_('QBO_CASH_ACCOUNT_ID'), undep = req_('QBO_UNDEPOSITED_FUNDS_ACCOUNT_ID');
  const shipAcc = req_('QBO_ALEX_SHIPPING_ACCOUNT_ID');
  const day = Utilities.formatDate(new Date(), APP.TZ, 'yyyy-MM-dd');
  const label = 'مندوب إسكندرية ' + day + ' (' + b.orders.length + ' أوردر)';
  const lines = [];
  const add = function (type, acct, amt, desc) {
    amt = Math.round(Number(amt) * 100) / 100;
    if (!amt) return;
    lines.push({ DetailType: 'JournalEntryLineDetail', Amount: amt, Description: String(desc).substring(0, 400),
      JournalEntryLineDetail: { PostingType: type, AccountRef: { value: String(acct) } } });
  };
  add('Debit', cash, c.net, 'صافي ' + label + ' (صندوق)');
  add('Debit', shipAcc, c.ship, 'شحن ' + label);
  b.orders.forEach(function (o) { add('Credit', undep, o.value, 'تحصيل أوردر ' + o.order + ' - مندوب إسكندرية'); });
  return { DocNumber: ('ALX' + day.replace(/-/g, '') + '-' + key).substring(0, 21), TxnDate: day,
    PrivateNote: 'PetFriend Alex rider batch ' + key + ' | ' + b.orders.map(function (o) { return o.order; }).join(' '), Line: lines };
}

/* ---------- اللي بيتشغّل من الكارت ---------- */

function alexPreview() {
  const b = alexReadBatch_(), c = alexCheck_(b), key = alexKey_(b), posted = JSON.parse(PropertiesService.getScriptProperties().getProperty(ALEX.POSTED) || '{}');
  b.orders.forEach(function (o) { out_('', o.order + ' | ' + o.value + ' | ' + o.service + ' | ' + o.address.substring(0, 40)); });
  out_('', 'إجمالي ' + c.total + ' - شحن ' + c.ship + ' = صافي للصندوق ' + c.net);
  if (posted[key]) out_('WARN', 'الدفعة دي اترحّلت قبل كده (QBO ' + posted[key] + ')');
  const probs = posted[key] ? c.problems : alexProblems_(b, c);
  probs.forEach(function (p) { out_('WARN', p); });
  return { ok: !probs.length, orders: b.orders.length, total: c.total, shipping: c.ship, net: c.net, alreadyPosted: !!posted[key] };
}

function alexPost() {
  const P = PropertiesService.getScriptProperties();
  const b = alexReadBatch_(), c = alexCheck_(b), key = alexKey_(b);
  const posted = JSON.parse(P.getProperty(ALEX.POSTED) || '{}');
  if (posted[key]) throw new Error('الدفعة دي اترحّلت قبل كده (QBO ' + posted[key] + '). امسح الأوردرات من التاب وحط الدفعة الجديدة.');
  const probs = alexProblems_(b, c);
  if (probs.length) throw new Error('مش هيترحّل لحد ما تتصلح: ' + probs.join(' · '));
  const je = alexBuildJournal_(b, c, key);
  if (alexDry_()) { out_('', 'DRY ' + JSON.stringify(je)); return { dry: true, orders: b.orders.length, net: c.net, shipping: c.ship }; }
  if (beforeGoLive_(todayCairo_())) throw new Error('قبل تاريخ البدء ' + goLive_());
  const res = qboPost_('journalentry', je);
  posted[key] = String(res.JournalEntry.Id);
  P.setProperty(ALEX.POSTED, fitJson_(posted));
  const hist = alexHist_(), prev = hist.length ? Number(hist[hist.length - 1].cum) || 0 : 0;
  hist.push({ d: je.TxnDate, key: key, n: b.orders.length, total: c.total, ship: c.ship, net: c.net,
    cum: Math.round((prev + c.net) * 100) / 100, q: posted[key], o: b.orders.map(function (o) { return o.order; }).join(' ') });
  try { P.setProperty(ALEX.HIST, fitJson_(hist.slice(-ALEX.HIST_MAX))); } catch (err) { out_('WARN', 'WARN: سجل الصندوق متسجلش: ' + err); }
  return { qboId: res.JournalEntry.Id, orders: b.orders.length, net: c.net, shipping: c.ship };
}

/* ---------- تاب "صندوق إسكندرية" في الواجهة ---------- */
function api_alexBox(t) {
  auth_(t);
  const all = PropertiesService.getScriptProperties().getProperties();
  const out = {
    dry: alexDry_(), goLive: all.GO_LIVE_DATE || '', sheetId: all.ALEX_SHEET_ID || '', tab: (all.ALEX_TAB || 'Alex orders').trim(),
    missing: ['ALEX_SHEET_ID', 'QBO_CASH_ACCOUNT_ID', 'QBO_UNDEPOSITED_FUNDS_ACCOUNT_ID', 'QBO_ALEX_SHIPPING_ACCOUNT_ID'].filter(function (k) { return !all[k]; }),
    hist: alexHist_().reverse(), histMax: ALEX.HIST_MAX
  };
  try {
    const b = alexReadBatch_(), c = alexCheck_(b), key = alexKey_(b), posted = JSON.parse(all[ALEX.POSTED] || '{}');
    out.batch = { key: key, orders: b.orders, total: c.total, shipping: c.ship, net: c.net, postedId: posted[key] || '',
      problems: posted[key] ? c.problems : alexProblems_(b, c) };
  } catch (e) { out.batchError = e.message; }
  return out;
}
