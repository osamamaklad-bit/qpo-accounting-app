# PetFriend • QBO accounting app

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
8. حدّث روابط الويب هوك في بوسطة وشوبيفاي بالروابط اللي ظاهرة في الكروت.

## ملاحظات

- QBO بيستخدم `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` / `QBO_REFRESH_TOKEN` / `QBO_REALM_ID` لكل الملفات (توكن واحد مشترك). الاستيراد بيحوّل `CLIENT_ID_QBO` القديمة تلقائياً.
- Meta: الموعد اليومي بيرحّل الـ Charges بس؛ الفواتير يدوي عشان ما يتكررش نفس المبلغ.
- حسابات المخزون في PO بقت إعدادات: `QBO_INVENTORY_ASSET_ACCOUNT_ID` (افتراضي 121) و `QBO_INVENTORY_OFFSET_ACCOUNT_ID` (افتراضي 315).
- مفيش أي أسرار في الكود؛ كلها في Script Properties.
