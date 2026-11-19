# PetFriend • QBO accounting app

**رابط الواجهة (GitHub):** https://osamamaklad-bit.github.io/qpo-accounting-app/

**رابط الواجهة (Apps Script):** https://script.google.com/macros/s/AKfycby5qiOh4iZ902dce7d7sPaKOmZy3pH92fCqL6mDwAfnPtIIC3ZjRDUlFCVsMhALMTUv/exec

مشروع Google Apps Script واحد بيجمع كل أتمتة QuickBooks Online لـ PetFriend Stores، وليه واجهة إدارة واحدة محمية بكلمة سر.

| الملف | الوظيفة |
|---|---|
| `src/Core.gs` | `doGet` و `doPost` الوحيدين، الدخول بكلمة السر، السجل، المواعيد، الإعدادات |
| `src/Index.html` | واجهة الإدارة (عربي، RTL) |
| `src/PO.gs` | استلام أوامر الشراء من شوبيفاي ← Bill + قيد إعادة تصنيف |
| `src/GoogleAds.gs` | Google Ads ← قيود QBO |
| `src/MetaAds.gs` | Meta Ads ← قيود QBO |
| `src/Bosta.gs` | تحويلات بوسطة ← قيد QBO + دوال QBO المشتركة (`getQboToken_`, `qboPost_`, `req_`) |
| `src/Kashier.gs` | تحويلات كاشير ← قيد QBO |
| `src/Products.gs` | مزامنة المنتجات شوبيفاي ← QBO |
| `tools/ExportProps.gs` | يتحط مؤقتاً في المشاريع القديمة لتصدير الـ Script Properties |

## التركيب

1. **في المشاريع القديمة الأول:** امسح كل الـ Triggers (عشان ما يحصلش ترحيل مكرر أو تغيير في QBO refresh token).
2. ضيف `tools/ExportProps.gs` في كل مشروع قديم وشغّل `exportAllProps` → هيطبع رابط ملف JSON في Drive.
3. اعمل مشروع Apps Script جديد وانسخ ملفات `src/` (أو استخدم `clasp push` مع `rootDir: src`).
4. Script Property باسم `APP_PASSWORD` = كلمة السر (بتتحول لـ hash عند أول دخول).
5. Deploy ← Web app ← Execute as: **Me** ← Who has access: **Anyone**، وحط رابط `/exec` في `WEBAPP_URL`.
6. من الواجهة: الإعدادات ← استيراد (ملف لكل مشروع قديم)، وبعدها امسح ملفات الـ JSON من Drive.
7. خلي `BOSTA_DRY_RUN` و `KASHIER_PAYOUT_DRY_RUN` = `true`، جرّب كل سكريبت، وبعدين فعّل المواعيد من الرئيسية.
8. حدّث رابط الويب هوك في بوسطة بالرابط اللي ظاهر في كارت بوسطة. ويب هوك المنتجات في شوبيفاي اتلغى (المزامنة بقت يومية أو يدوي)، فامسحه من شوبيفاي.

## ملاحظات

- QBO بيستخدم `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` / `QBO_REFRESH_TOKEN` / `QBO_REALM_ID` لكل الملفات (توكن واحد مشترك). الاستيراد بيحوّل `CLIENT_ID_QBO` القديمة تلقائياً.
- Meta: الموعد اليومي بيرحّل الـ Charges بس؛ الفواتير يدوي عشان ما يتكررش نفس المبلغ.
- حسابات المخزون في PO بقت إعدادات: `QBO_INVENTORY_ASSET_ACCOUNT_ID` (افتراضي 121) و `QBO_INVENTORY_OFFSET_ACCOUNT_ID` (افتراضي 315).
- مفيش أي أسرار في الكود؛ كلها في Script Properties.
- `GO_LIVE_DATE` (إعدادات مشتركة، مثلاً `2027-01-01`): أي حركة قبله مش بتترحّل في أي سكريبت. قبل التاريخ ده، أوامر الشراء بتعلّم التحويلات المستلمة إنها اتعالجت من غير ما تعمل Bill، فخلي موعدها شغال في ديسمبر.
- التطبيق مش بيبعت أي إيميل. أي فشل بيظهر في السجل بس (تاب السجل في الواجهة).
- لو آخر تشغيل لأي سكريبت فشل أو وقف، بيظهر شريط أحمر في أول الصفحة الرئيسية.
- نفس السكريبت مينفعش يشتغل مرتين في نفس الوقت (زرار اتداس مرتين، أو يدوي + موعد): التشغيل التاني بيتخطّى ويتسجل.
- أي زرار بيرحّل في QBO بيطلب تأكيد، إلا لو السكريبت في وضع التجربة.
- وضع التجربة لبوسطة وكاشير: أي قيمة غير `false` (حتى لو فاضية) = تجربة.
- علامات اللي اترحّل قبل كده (`PROCESSED`, `BOSTA_PAYOUT_...`, `KASHIER_PAYOUT_...`) مينفعش تتعدل من الإعدادات.
- Google Ads: مصروف اليوم بيترحّل بعد ما اليوم يخلص بتوقيت القاهرة.
- المنتجات: مزامنة كاملة مرة في اليوم، أو يدوي من زرار "زامن المنتجات الآن".

## النشر التلقائي من GitHub

أي تعديل في `src/` على فرع `main` بيترفع لـ Apps Script وبيحدّث نفس رابط الـ Web app (`.github/workflows/deploy.yml`).
تقدر كمان تشغّله يدوي من Actions ← Deploy to Apps Script ← Run workflow.

إعداد مرة واحدة:
1. فعّل Google Apps Script API من https://script.google.com/home/usersettings
2. على جهازك: `npm i -g @google/clasp@2.4.2` ثم `clasp login` ← هيعمل ملف `~/.clasprc.json`.
3. في الريبو: Settings ← Secrets and variables ← Actions ← New repository secret:
   - `CLASPRC_JSON` = محتوى ملف `~/.clasprc.json` كامل
   - `SCRIPT_ID` = من Apps Script ← Project Settings ← Script ID
   - `DEPLOYMENT_ID` (اختياري) = الجزء اللي بين `/s/` و `/exec` في رابط الـ Web app

⚠️ `clasp push` بيخلي ملفات مشروع Apps Script مطابقة لـ `src/` بالظبط: أي ملف في المحرر مش موجود هنا هيتمسح.

## الواجهة على GitHub Pages

GitHub Pages بيتنشر من جذر `main`. `index.html` في الجذر نسخة من `src/Index.html` وبيتحدّث لوحده (`.github/workflows/pages.yml`)، فعدّل `src/Index.html` بس.
الواجهة بتكلم السكريبت عن طريق `POST /exec?src=ui` (`uiApi_` في `Core.gs`). كلمة السر والجلسات زي ما هي.

إعداد Pages: Settings ← Pages ← Deploy from a branch ← `main` / `(root)`.
لازم آخر نسخة من `Core.gs` تكون متنشرة على Apps Script، وإلا الواجهة هتقول "تعذّر الاتصال بالسكريبت".

## النشر من جهازك (أو من Claude Code)

```bash
git clone https://github.com/osamamaklad-bit/qpo-accounting-app && cd qpo-accounting-app
SCRIPT_ID=<Script ID من Project Settings> ./deploy.sh
```
أول مرة: فعّل Apps Script API من https://script.google.com/home/usersettings، والسكريبت هيطلب `clasp login`.
