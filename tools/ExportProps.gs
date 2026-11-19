/**
 * ضيف الملف ده مؤقتاً في كل مشروع قديم وشغّل exportAllProps مرة واحدة.
 * بيعمل ملف JSON في Drive فيه كل الـ Script Properties ويطبع رابطه في اللوج.
 * الصق الرابط في: الإعدادات > استيراد الإعدادات من المشاريع القديمة
 * بعد الاستيراد امسح الملف من Drive لأنه فيه بيانات سرية.
 */
function exportAllProps() {
  const all = PropertiesService.getScriptProperties().getProperties();
  const file = DriveApp.createFile(
    'props-export-' + Utilities.formatDate(new Date(), 'Africa/Cairo', 'yyyyMMdd-HHmm') + '.json',
    JSON.stringify(all, null, 2),
    'application/json'
  );
  console.log(Object.keys(all).length + ' properties exported');
  console.log(file.getUrl());
}
