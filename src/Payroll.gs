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
// كل تغيير في البنود بيزوّد رقم النسخة، والواجهة لازم تحفظ على آخر نسخة (عشان الحفظ ما يرجّعش رصيد أو خصم قديم)
function payRev_() { return Number(PropertiesService.getScriptProperties().getProperty('PAYROLL_REV') || 0); }
function paySaveItems_(items) {
  const P = PropertiesService.getScriptProperties();
  P.setProperties({ PAYROLL_ITEMS: JSON.stringify(items), PAYROLL_REV: String(payRev_() + 1) }, false);
}
function payPosted_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(PAY.POSTED) || '{}'); }
  catch (e) { return {}; }
}
function payDry_() { return String(PropertiesService.getScriptProperties().getProperty(PAY.DRY) || '').trim().toLowerCase() !== 'false'; }
// تعديل بند واحد تحت قفل (عشان ما يتعارضش مع حفظ من الواجهة في نفس اللحظة)
/* ---------- كشف حساب السلف: كل سلفة وكل خصم وكل تعديل يدوي للرصيد ----------
 * متخزن في PAYROLL_ADV_HIST = { id: [ {d, k:'adv'|'ded'|'edit', a: +زيادة/-نقص, b: الرصيد بعدها, q: رقم قيد QBO, n: ملاحظة} ] }
 * بيتكتب جوه نفس القفل اللي بيغيّر الرصيد، وبيحتفظ بآخر 60 حركة لكل موظف. */
const PAY_HIST = 'PAYROLL_ADV_HIST', PAY_HIST_MAX = 60;
function payHist_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(PAY_HIST) || '{}'); } catch (e) { return {}; }
}
function payHistAdd_(id, e) {
  const h = payHist_(), list = h[id] || [];
  e.d = e.d || Utilities.formatDate(new Date(), APP.TZ, 'yyyy-MM-dd');
  list.push(e);
  h[id] = list.slice(-PAY_HIST_MAX);
  PropertiesService.getScriptProperties().setProperty(PAY_HIST, JSON.stringify(h));
}

function payUpdateItem_(id, fn) {
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const items = payItems_(), cur = items.filter(function (x) { return x.id === id; })[0];
    if (cur) { fn(cur); paySaveItems_(items); }
  } finally { lock.releaseLock(); }
}
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

// الخصم والصافي (من غير حسابات، عشان التجربة تشتغل حتى لو الحسابات لسه ناقصة)
function payCalc_(it) {
  if (it.type !== 'salary') return { ded: 0, kind: 'none', net: payR2_(it.amount) };
  const kind = (it.deduction && it.deduction.kind) || 'none';
  let ded = kind === 'none' ? 0 : Math.min(it.deduction.amount || 0, it.amount);
  if (kind === 'advance') ded = Math.min(ded, it.advanceBalance || 0);
  ded = payR2_(ded);
  return { ded: ded, kind: ded > 0 ? kind : 'none', net: payR2_(it.amount - ded) };
}
const PAY_ACCOUNT_KEYS = ['QBO_RENT_EXPENSE_ACCOUNT_ID', 'QBO_SALARY_EXPENSE_ACCOUNT_ID', 'QBO_CASH_ACCOUNT_ID', 'QBO_BANK_ACCOUNT_ID',
  'QBO_PENALTIES_ACCOUNT_ID', 'QBO_ADVANCES_ACCOUNT_ID'];

// قيد بند واحد عن شهر معيّن
function payBuildJournal_(it, period) {
  const A = payAccounts_();
  const from = it.payFrom === 'bank' ? A.bank : A.cash;
  const label = (it.type === 'rent' ? 'إيجار ' : 'راتب ') + it.name + ' ' + period;
  const lines = [];
  const c = payCalc_(it), ded = c.ded, kind = c.kind;

  if (it.type === 'rent') {
    lines.push(payLine_('Debit', A.rent, it.amount, label));
    lines.push(payLine_('Credit', from, it.amount, label + (it.payFrom === 'bank' ? ' (بنك)' : ' (صندوق)')));
  } else {
    const net = c.net;
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
  if (b.kind !== 'none') payUpdateItem_(it.id, function (cur) {
    if (b.kind === 'advance') {
      cur.advanceBalance = payR2_(Math.max(0, cur.advanceBalance - b.ded));
      payHistAdd_(it.id, { k: 'ded', a: -b.ded, b: cur.advanceBalance, q: posted[key], n: payPeriod_() + (it.deduction.note ? ' - ' + it.deduction.note : '') });
    }
    cur.deduction = { kind: 'none', amount: 0, note: '' };
  });
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

// تجربة لكل البنود (الشهري واليدوي) من غير ترحيل: المبالغ بتظهر حتى لو الحسابات ناقصة
function payrollPreview() {
  const period = payPeriod_(), posted = payPosted_(), all = PropertiesService.getScriptProperties().getProperties();
  const missing = PAY_ACCOUNT_KEYS.filter(function (k) { return !all[k]; });
  const tot = { rent: 0, salaries: 0, deductions: 0, net: 0, cash: 0, bank: 0 };
  const items = payItems_();
  items.forEach(function (it) {
    const c = payCalc_(it), paid = posted[period + ':' + it.id];
    tot[it.type === 'rent' ? 'rent' : 'salaries'] += it.amount; tot.deductions += c.ded; tot.net += c.net; tot[it.payFrom === 'bank' ? 'bank' : 'cash'] += c.net;
    out_('', (paid ? '[PAID QBO ' + paid + '] ' : '') + (it.type === 'rent' ? 'إيجار ' : 'راتب ') + it.name + ' | ' + it.amount +
      (c.ded ? ' - ' + (c.kind === 'penalty' ? 'جزاء ' : 'سلفة ') + c.ded : '') + ' = ' + c.net + ' | ' + (it.payFrom === 'bank' ? 'بنك' : 'صندوق') +
      ' | ' + (it.recurrence === 'monthly' ? 'شهري يوم ' + it.day : 'يدوي'));
  });
  if (missing.length) out_('WARN', 'حسابات ناقصة في الإعدادات (التجربة شغالة، بس الترحيل محتاجها): ' + missing.join(', '));
  Object.keys(tot).forEach(function (k) { tot[k] = payR2_(tot[k]); });
  return { ok: true, period: period, lines: items.length, totals: tot };
}

/* ---------- API للتاب ---------- */

// كشف حساب سلف موظف
function api_payrollStatement(t, id) {
  auth_(t);
  const it = payItems_().filter(function (x) { return x.id === id; })[0];
  if (!it) throw new Error('الموظف مش موجود / Employee not found');
  const list = payHist_()[id] || [];
  const moved = list.reduce(function (s, e) { return s + (Number(e.a) || 0); }, 0);
  return { name: it.name, balance: it.advanceBalance || 0, opening: payR2_((it.advanceBalance || 0) - moved), entries: list, max: PAY_HIST_MAX };
}

function api_payroll(t) {
  auth_(t);
  const all = PropertiesService.getScriptProperties().getProperties();
  const period = payPeriod_(), posted = payPosted_();
  const need = PAY_ACCOUNT_KEYS;
  return {
    items: payItems_(),
    rev: payRev_(),
    period: period,
    paid: Object.keys(posted).filter(function (k) { return k.indexOf(period + ':') === 0; })
      .reduce(function (m, k) { m[k.split(':')[1]] = posted[k]; return m; }, {}),
    dry: payDry_(),
    goLive: all.GO_LIVE_DATE || '',
    missing: need.filter(function (k) { return !all[k]; }),
    accounts: need.reduce(function (m, k) { m[k] = all[k] || ''; return m; }, {})
  };
}

function api_payrollSave(t, items, rev) {
  auth_(t);
  if (!Array.isArray(items) || items.length > 60) throw new Error('قايمة غير صحيحة');
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
  if (rev !== undefined && rev !== null && Number(rev) !== payRev_()) {
    throw new Error('البنود اتغيرت من وقت ما فتحت الصفحة (دفعة أو سلفة اتسجلت). اعمل تحديث للتاب، وعدّل تاني، واحفظ. / The lines changed since you opened this tab. Reload, re-apply your edits and save.');
  }
  const clean = items.map(payClean_).filter(function (x) { return x.name; });
  const ids = {};
  clean.forEach(function (x) { while (ids[x.id]) x.id = Utilities.getUuid().substring(0, 8); ids[x.id] = 1; });
  // أي تغيير يدوي في رصيد السلفة يتسجل في الكشف (من غير قيد QBO)
  const old = payItems_().reduce(function (m, x) { m[x.id] = x.advanceBalance || 0; return m; }, {});
  clean.forEach(function (x) {
    if (x.type !== 'salary') return;
    const before = old[x.id] || 0, diff = payR2_((x.advanceBalance || 0) - before);
    if (diff) payHistAdd_(x.id, { k: 'edit', a: diff, b: x.advanceBalance || 0 });
  });
  paySaveItems_(clean);
  } finally { lock.releaseLock(); }
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
    payUpdateItem_(id, function (cur) {
      cur.advanceBalance = payR2_((cur.advanceBalance || 0) + amount);
      payHistAdd_(id, { d: day, k: 'adv', a: amount, b: cur.advanceBalance, q: String(res.JournalEntry.Id) });
    });
    return { qboId: res.JournalEntry.Id, amount: amount };
  });
  return { status: r.status, error: r.error, summary: r.summary, log: r.log, secs: r.secs, state: api_payroll(t) };
}
