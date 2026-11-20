/*********************************************************
 * Payroll.gs — الإيجارات والرواتب ← قيود QBO
 *
 * البنود (الأسماء والمبالغ) متخزنة في Script Property اسمها PAYROLL_ITEMS، مش في الكود،
 * عشان الريبو عام. بتتعدل من تاب "الرواتب والإيجارات" في الواجهة.
 *
 * قيد الإيجار:  مدين مصروف الإيجار            / دائن الصندوق أو البنك
 * قيد الراتب:   مدين مصروف الرواتب (الإجمالي) / دائن الصندوق أو البنك (الصافي)
 *                                              / دائن الجزاءات أو سلف الموظفين (الخصم)
 * سلفة جديدة:   مدين سلف الموظفين             / دائن الصندوق أو البنك  (ورصيد السلفة بيزيد)
 *
 * الأمان: وضع التجربة PAYROLL_DRY_RUN (أي قيمة غير false = تجربة)، GO_LIVE_DATE،
 * ونفس البند مينفعش يتدفع مرتين في نفس الشهر (PAYROLL_POSTED).
 *********************************************************/

const PAY = { ITEMS: 'PAYROLL_ITEMS', POSTED: 'PAYROLL_POSTED', DRY: 'PAYROLL_DRY_RUN' };

function payItems_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(PAY.ITEMS) || '[]'); }
  catch (e) { return []; }
}
function paySaveItems_(items) { PropertiesService.getScriptProperties().setProperty(PAY.ITEMS, JSON.stringify(items)); }
function payPosted_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(PAY.POSTED) || '{}'); }
  catch (e) { return {}; }
}
function payDry_() { return String(PropertiesService.getScriptProperties().getProperty(PAY.DRY) || '').trim().toLowerCase() !== 'false'; }
function payPeriod_(d) { return Utilities.formatDate(d || new Date(), APP.TZ, 'yyyy-MM'); }
const payR2_ = x => Math.round(Number(x) * 100) / 100;

// بيتأكد من شكل البند قبل الحفظ
function payClean_(it) {
  const type = it.type === 'rent' ? 'rent' : 'salary';
  const ded = it.deduction || {};
  const kind = type === 'salary' && (ded.kind === 'penalty' || ded.kind === 'advance') ? ded.kind : 'none';
  return {
    id: String(it.id || Utilities.getUuid().substring(0, 8)).replace(/[^A-Za-z0-9]/g, '').substring(0, 10),
    type: type,
    name: String(it.name || '').trim().substring(0, 60),
    amount: Math.max(0, payR2_(it.amount || 0)),
    payFrom: it.payFrom === 'bank' ? 'bank' : 'cash',
    recurrence: it.recurrence === 'manual' ? 'manual' : 'monthly',
    day: Math.min(28, Math.max(1, Math.round(Number(it.day) || 1))),
    deduction: { kind: kind, amount: kind === 'none' ? 0 : Math.max(0, payR2_(ded.amount || 0)), note: String(ded.note || '').substring(0, 80) },
    advanceBalance: type === 'salary' ? Math.max(0, payR2_(it.advanceBalance || 0)) : 0
  };
}

function payAccounts_() {
  return {
    rent: req_('QBO_RENT_EXPENSE_ACCOUNT_ID'),
    salary: req_('QBO_SALARY_EXPENSE_ACCOUNT_ID'),
    cash: req_('QBO_CASH_ACCOUNT_ID'),
    bank: req_('QBO_BANK_ACCOUNT_ID')
  };
}

function payLine_(type, acct, amount, desc) {
  return { DetailType: 'JournalEntryLineDetail', Amount: payR2_(amount), Description: String(desc).substring(0, 400),
    JournalEntryLineDetail: { PostingType: type, AccountRef: { value: String(acct) } } };
}

// قيد بند واحد عن شهر معيّن
function payBuildJournal_(it, period) {
  const A = payAccounts_();
  const from = it.payFrom === 'bank' ? A.bank : A.cash;
  const label = (it.type === 'rent' ? 'إيجار ' : 'راتب ') + it.name + ' ' + period;
  const lines = [];
  let ded = 0, kind = 'none';

  if (it.type === 'rent') {
    lines.push(payLine_('Debit', A.rent, it.amount, label));
    lines.push(payLine_('Credit', from, it.amount, label + (it.payFrom === 'bank' ? ' (بنك)' : ' (صندوق)')));
  } else {
    kind = it.deduction.kind;
    ded = kind === 'none' ? 0 : Math.min(it.deduction.amount, it.amount);
    if (kind === 'advance') ded = Math.min(ded, it.advanceBalance);
    const net = payR2_(it.amount - ded);
    lines.push(payLine_('Debit', A.salary, it.amount, label));
    if (net > 0) lines.push(payLine_('Credit', from, net, 'صافي ' + label + (it.payFrom === 'bank' ? ' (بنك)' : ' (صندوق)')));
    if (ded > 0) {
      const acct = kind === 'penalty' ? req_('QBO_PENALTIES_ACCOUNT_ID') : req_('QBO_ADVANCES_ACCOUNT_ID');
      lines.push(payLine_('Credit', acct, ded, (kind === 'penalty' ? 'جزاء ' : 'خصم سلفة ') + it.name +
        (it.deduction.note ? ' - ' + it.deduction.note : '')));
    }
  }
  return {
    je: { DocNumber: ('PR' + period.replace('-', '') + '-' + it.id).substring(0, 21), TxnDate: Utilities.formatDate(new Date(), APP.TZ, 'yyyy-MM-dd'),
      PrivateNote: 'PetFriend payroll ' + period + ' ' + it.id + ' | ' + label, Line: lines },
    ded: ded, kind: kind
  };
}

// بيرحّل بند واحد (أو بيطبع القيد لو تجربة). بيرجع ملخص.
function payPostOne_(it, period, posted) {
  const key = period + ':' + it.id;
  if (posted[key]) return { id: it.id, name: it.name, skipped: 'already paid ' + period + ' (QBO ' + posted[key] + ')' };
  if (!(it.amount > 0)) return { id: it.id, name: it.name, skipped: 'amount is 0' };
  const b = payBuildJournal_(it, period);
  if (payDry_()) {
    out_('', 'DRY ' + key + ' ' + JSON.stringify(b.je));
    return { id: it.id, name: it.name, dry: true, net: payR2_(it.amount - b.ded), deduction: b.ded };
  }
  if (beforeGoLive_(todayCairo_())) return { id: it.id, name: it.name, skipped: 'before GO_LIVE_DATE ' + goLive_() };
  const res = qboPost_('journalentry', b.je);
  posted[key] = String(res.JournalEntry.Id);
  PropertiesService.getScriptProperties().setProperty(PAY.POSTED, JSON.stringify(posted));
  // الخصم اتطبق مرة واحدة: بيتمسح، ورصيد السلفة بيقل
  const items = payItems_(), cur = items.filter(function (x) { return x.id === it.id; })[0];
  if (cur && b.kind !== 'none') {
    if (b.kind === 'advance') cur.advanceBalance = payR2_(Math.max(0, cur.advanceBalance - b.ded));
    cur.deduction = { kind: 'none', amount: 0, note: '' };
    paySaveItems_(items);
  }
  return { id: it.id, name: it.name, qboId: posted[key], net: payR2_(it.amount - b.ded), deduction: b.ded };
}

/* ---------- اللي بيتشغّل من الكارت والموعد ---------- */

// البنود الشهرية اللي ميعادها جه الشهر ده ولسه متدفعتش
function payrollRunDue() {
  const period = payPeriod_(), day = Number(Utilities.formatDate(new Date(), APP.TZ, 'd'));
  const posted = payPosted_(), results = [];
  payItems_().forEach(function (it) {
    if (it.recurrence !== 'monthly' || it.day > day) return;
    try { results.push(payPostOne_(it, period, posted)); }
    catch (err) { out_('ERROR', it.name + ': ' + err); results.push({ id: it.id, name: it.name, error: String(err) }); }
  });
  return { ok: true, period: period, dryRun: payDry_(), results: results };
}

// تجربة لكل البنود (الشهري واليدوي) من غير ترحيل
function payrollPreview() {
  const period = payPeriod_(), posted = payPosted_(), out = [];
  payItems_().forEach(function (it) {
    const key = period + ':' + it.id;
    try {
      const b = payBuildJournal_(it, period);
      out_('', (posted[key] ? '[PAID] ' : '') + it.name + ' | ' + it.type + ' | gross ' + it.amount + ' | deduction ' + b.ded + ' | net ' + payR2_(it.amount - b.ded) +
        ' | ' + (it.payFrom === 'bank' ? 'bank' : 'cash') + ' | ' + it.recurrence + (it.recurrence === 'monthly' ? ' day ' + it.day : ''));
      out.push({ id: it.id, paid: !!posted[key], net: payR2_(it.amount - b.ded) });
    } catch (err) { out_('ERROR', it.name + ': ' + err); out.push({ id: it.id, error: String(err) }); }
  });
  return { ok: true, period: period, items: out.length };
}

/* ---------- API للتاب ---------- */

function api_payroll(t) {
  auth_(t);
  const all = PropertiesService.getScriptProperties().getProperties();
  const period = payPeriod_(), posted = payPosted_();
  const need = ['QBO_RENT_EXPENSE_ACCOUNT_ID', 'QBO_SALARY_EXPENSE_ACCOUNT_ID', 'QBO_CASH_ACCOUNT_ID', 'QBO_BANK_ACCOUNT_ID',
    'QBO_PENALTIES_ACCOUNT_ID', 'QBO_ADVANCES_ACCOUNT_ID'];
  return {
    items: payItems_(),
    period: period,
    paid: Object.keys(posted).filter(function (k) { return k.indexOf(period + ':') === 0; })
      .reduce(function (m, k) { m[k.split(':')[1]] = posted[k]; return m; }, {}),
    dry: payDry_(),
    goLive: all.GO_LIVE_DATE || '',
    missing: need.filter(function (k) { return !all[k]; })
  };
}

function api_payrollSave(t, items) {
  auth_(t);
  if (!Array.isArray(items) || items.length > 60) throw new Error('قايمة غير صحيحة');
  const clean = items.map(payClean_).filter(function (x) { return x.name; });
  const ids = {};
  clean.forEach(function (x) { while (ids[x.id]) x.id = Utilities.getUuid().substring(0, 8); ids[x.id] = 1; });
  paySaveItems_(clean);
  return api_payroll(t);
}

function api_payrollPay(t, id) {
  auth_(t);
  const it = payItems_().filter(function (x) { return x.id === id; })[0];
  if (!it) throw new Error('البند مش موجود');
  const r = runLogged_('payroll', 'manual', 'payrollPay:' + it.name, function () {
    const res = payPostOne_(it, payPeriod_(), payPosted_());
    if (res.skipped) throw new Error(res.skipped);
    return res;
  });
  return { status: r.status, error: r.error, summary: r.summary, log: r.log, secs: r.secs, state: api_payroll(t) };
}

// سلفة جديدة لموظف: قيد + زيادة الرصيد
function api_payrollAdvance(t, id, amount) {
  auth_(t);
  amount = payR2_(amount);
  if (!(amount > 0)) throw new Error('اكتب مبلغ السلفة');
  const it = payItems_().filter(function (x) { return x.id === id && x.type === 'salary'; })[0];
  if (!it) throw new Error('الموظف مش موجود');
  const r = runLogged_('payroll', 'manual', 'payrollAdvance:' + it.name, function () {
    const A = payAccounts_(), from = it.payFrom === 'bank' ? A.bank : A.cash;
    const day = Utilities.formatDate(new Date(), APP.TZ, 'yyyy-MM-dd');
    const je = { DocNumber: ('ADV' + day.replace(/-/g, '') + '-' + it.id).substring(0, 21), TxnDate: day,
      PrivateNote: 'PetFriend advance ' + it.id + ' | سلفة ' + it.name,
      Line: [payLine_('Debit', req_('QBO_ADVANCES_ACCOUNT_ID'), amount, 'سلفة ' + it.name),
             payLine_('Credit', from, amount, 'سلفة ' + it.name + (it.payFrom === 'bank' ? ' (بنك)' : ' (صندوق)'))] };
    if (payDry_()) { out_('', 'DRY advance ' + JSON.stringify(je)); return { dry: true, amount: amount }; }
    if (beforeGoLive_(day)) throw new Error('before GO_LIVE_DATE ' + goLive_());
    const res = qboPost_('journalentry', je);
    const items = payItems_(), cur = items.filter(function (x) { return x.id === id; })[0];
    if (cur) { cur.advanceBalance = payR2_((cur.advanceBalance || 0) + amount); paySaveItems_(items); }
    return { qboId: res.JournalEntry.Id, amount: amount };
  });
  return { status: r.status, error: r.error, summary: r.summary, log: r.log, secs: r.secs, state: api_payroll(t) };
}
