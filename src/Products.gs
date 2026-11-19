/**
 * PRODUCTS TO QBO — Shopify → QuickBooks Online product sync (no inventory)
 *
 * Every name starts with "pq" / "PQ" so it can't clash with other code.
 * Match key: SKU (case-insensitive). Shopify is the master.
 *
 *   Shopify                         QBO Item
 *   product title + variant title → Name
 *   variant SKU                   → Sku
 *   variant price                 → UnitPrice
 *   inventory item unit cost      → PurchaseCost
 *   (quantity is NOT synced; new QBO items are created with quantity 0)
 *
 * HOW IT RUNS
 *   1. Shopify webhooks (products/create, products/update) call the web app
 *      (doPost in Core.gs routes ?src=pq here).
 *   2. The web app only queues the product id and answers immediately.
 *   3. cron_pqQueue (every minute, from the dashboard) runs pqProcessQueue().
 *   4. cron_pqDaily (from the dashboard) runs pqSyncAll() as the safety net,
 *      because changing a COST in Shopify does not fire a product webhook.
 *
 * QBO token: uses the shared getQboToken_() in Bosta.gs.
 */

const PQ = {
  SHOPIFY_API_VERSION: '2026-01',
  QBO_MINOR_VERSION: '75',
  QBO_API_BASE: 'https://quickbooks.api.intuit.com/v3/company',
  MAX_RUN_MS: 4 * 60 * 1000,           // stop well before Apps Script's 6-minute limit (run again to continue)
  ISSUES_SHEET: 'QBO Sync Issues',     // full sync (rewritten each run)
  WEBHOOK_SHEET: 'QBO Webhook Issues', // webhook syncs (appended)
  QUEUE_PREFIX: 'PQ_Q_',
  MAX_ATTEMPTS: 3,
  DEFAULT_INV_START_DATE: '2026-10-01'
};


/* ============================================================
   WEBHOOK
   ============================================================ */

function pqHandleWebhook_(e) {
  try {
    const provided = e.parameter && e.parameter.key;

    if (!provided || !pqSafeCompare_(provided, pqProp_('WEBHOOK_KEY', true))) {
      Logger.log('Webhook REJECTED: missing or wrong key');
      return pqJson_({ ok: false, error: 'Invalid webhook key' });
    }

    const body = e.postData && e.postData.contents;
    const payload = body ? JSON.parse(body) : {};
    const productId = pqProductId_(payload);

    if (!productId) {
      Logger.log('Webhook REJECTED: no product id. Body starts: ' +
        String(body || '').substring(0, 200));
      return pqJson_({ ok: false, error: 'No product id in payload' });
    }

    Logger.log('Webhook received for product ' + productId);

    PropertiesService.getScriptProperties().setProperty(
      PQ.QUEUE_PREFIX + productId,
      JSON.stringify({ t: Date.now(), a: 0 })
    );

    return pqJson_({ ok: true, queued: productId });
  } catch (err) {
    Logger.log('Webhook ERROR: ' + String(err));
    return pqJson_({ ok: false, error: String(err) });
  }
}

function pqProductId_(payload) {
  const gid = pqText_(payload.admin_graphql_api_id);
  const match = gid.match(/Product\/(\d+)$/);

  if (match) return match[1];

  const id = pqText_(payload.id);
  return /^\d+$/.test(id) ? id : '';
}

/**
 * Processes every queued product in one pass (one QBO item load for all of them).
 */
function pqProcessQueue() {
  if (!pqQueueKeys_().length) return;

  const lock = LockService.getScriptLock();

  if (!lock.tryLock(10000)) {
    return;                            // another sync is running; next minute retries
  }

  try {
    const keys = pqQueueKeys_();
    Logger.log('Queue size: ' + keys.length);
    if (!keys.length) return;

    const startedAt = Date.now();
    const props = PropertiesService.getScriptProperties();
    const qbo = pqLoadQboItems_();
    const issues = [];

    for (let i = 0; i < keys.length; i++) {
      if (Date.now() - startedAt > PQ.MAX_RUN_MS) break;

      const key = keys[i];
      const productId = key.substring(PQ.QUEUE_PREFIX.length);
      const entry = pqParseEntry_(props.getProperty(key));

      try {
        const results = pqSyncProduct_('gid://shopify/Product/' + productId, qbo);

        results.forEach(function (r) {
          if (!r.ok) issues.push(r);
        });

        Logger.log(
          'Product ' + productId + ': ' + results.length + ' variant(s) - ' +
          results.map(function (r) { return r.action; }).join(', ')
        );

        props.deleteProperty(key);
      } catch (err) {
        Logger.log('Product ' + productId + ' FAILED: ' + String(err));
        entry.a = (entry.a || 0) + 1;

        if (entry.a >= PQ.MAX_ATTEMPTS) {
          issues.push({
            shopifyVariantId: 'Product/' + productId,
            error: 'Gave up after ' + PQ.MAX_ATTEMPTS + ' attempts: ' + String(err)
          });
          props.deleteProperty(key);
        } else {
          props.setProperty(key, JSON.stringify(entry));
        }
      }
    }

    pqAppendIssues_(issues);
  } finally {
    lock.releaseLock();
  }
}

function pqSyncProduct_(productGid, qbo) {
  const product = pqGetShopifyProduct_(productGid);

  if (!product || product.status === 'ARCHIVED') return [];

  const seenSkus = {};

  return product.variants.map(function (variant) {
    variant.product = { id: product.id, title: product.title, status: product.status };
    return pqSyncVariant_(variant, qbo, seenSkus, { dryRun: false });
  });
}

function pqGetShopifyProduct_(productGid) {
  const query = `
    query PqProduct($id: ID!, $cursor: String) {
      product(id: $id) {
        id
        title
        status
        variants(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            sku
            title
            price
            inventoryItem {
              id
              unitCost {
                amount
              }
            }
          }
        }
      }
    }
  `;

  let product = null;
  const variants = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const body = pqShopify_(query, { id: productGid, cursor: cursor });
    const node = body.data.product;

    if (!node) return null;            // product was deleted

    product = node;
    node.variants.nodes.forEach(function (v) { variants.push(v); });

    hasNextPage = node.variants.pageInfo.hasNextPage;
    cursor = node.variants.pageInfo.endCursor;
  }

  return { id: product.id, title: product.title, status: product.status, variants: variants };
}

function pqQueueKeys_() {
  return Object.keys(PropertiesService.getScriptProperties().getProperties())
    .filter(function (k) { return k.indexOf(PQ.QUEUE_PREFIX) === 0; });
}

function pqParseEntry_(text) {
  try {
    return JSON.parse(text) || { a: 0 };
  } catch (err) {
    return { a: 0 };
  }
}


/* ============================================================
   FULL SYNC (daily safety net / first load)
   ============================================================ */

function pqDryRun() {
  return pqRunLocked_({ dryRun: true });
}

function pqSyncAll() {
  return pqRunLocked_({ dryRun: false });
}

function pqRunLocked_(options) {
  // نفس السكريبت مش بيشتغل مرتين مع بعض: القفل في runLogged_ (Core.gs)، فمفيش قفل هنا يعطّل باقي السكريبتات
  {
    const summary = pqRun_(options);

    Logger.log(JSON.stringify({
      dryRun: summary.dryRun,
      totalProcessed: summary.totalProcessed,
      created: summary.created,
      updated: summary.updated,
      noChanges: summary.noChanges,
      failed: summary.failed,
      timedOut: summary.timedOut
    }, null, 2));

    return summary;
  }
}

function pqRun_(options) {
  const startedAt = Date.now();
  const variants = pqGetAllShopifyVariants_();
  const qbo = pqLoadQboItems_();
  const seenSkus = {};
  const issues = [];

  const summary = {
    dryRun: options.dryRun,
    totalProcessed: 0,
    created: 0,
    updated: 0,
    noChanges: 0,
    failed: 0,
    timedOut: false
  };

  for (let i = 0; i < variants.length; i++) {
    if (Date.now() - startedAt > PQ.MAX_RUN_MS) {
      summary.timedOut = true;         // just run again: finished items cost no API calls
      console.warn('WARN: وقفت قبل حد الـ 6 دقايق بعد ' + i + ' من ' + variants.length + ' منتج. دوس الزرار تاني عشان تكمّل.');
      break;
    }

    const result = pqSyncVariant_(variants[i], qbo, seenSkus, options);
    summary.totalProcessed++;

    if (!result.ok) {
      summary.failed++;
      issues.push(result);
    } else if (result.action === 'created') {
      summary.created++;
    } else if (result.action === 'updated') {
      summary.updated++;
    } else {
      summary.noChanges++;
    }
  }

  pqWriteIssues_(issues);

  return summary;
}

function pqGetAllShopifyVariants_() {
  const query = `
    query PqVariants($cursor: String) {
      productVariants(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          sku
          title
          price
          product {
            id
            title
            status
          }
          inventoryItem {
            id
            unitCost {
              amount
            }
          }
        }
      }
    }
  `;

  const all = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const body = pqShopify_(query, { cursor: cursor });
    const connection = body.data.productVariants;

    connection.nodes.forEach(function (variant) {
      if (variant.product && variant.product.status !== 'ARCHIVED') {
        all.push(variant);
      }
    });

    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;

    if (hasNextPage) Utilities.sleep(700);
  }

  return all;
}


/* ============================================================
   SYNC ONE VARIANT (shared by webhook and full sync)
   ============================================================ */

function pqSyncVariant_(variant, qbo, seenSkus, options) {
  let sku = pqText_(variant.sku);
  if (sku === '0') sku = '';           // "0" is a placeholder, not a real SKU

  const base = {
    shopifyVariantId: variant.id,
    productTitle: variant.product.title,
    variantTitle: variant.title,
    sku: sku
  };

  if (!sku) {
    return Object.assign(base, {
      ok: false, action: 'skipped',
      error: 'Shopify variant has no SKU'
    });
  }

  const skuKey = sku.toLowerCase();

  if (seenSkus[skuKey]) {
    return Object.assign(base, {
      ok: false, action: 'skipped',
      error: 'Duplicate SKU in Shopify (first used by: ' + seenSkus[skuKey] + ')'
    });
  }
  seenSkus[skuKey] = variant.product.title;

  const data = {
    sku: sku,
    name: pqBuildName_(variant),
    price: Number(variant.price) || 0,
    cost:
      variant.inventoryItem && variant.inventoryItem.unitCost
        ? Number(variant.inventoryItem.unitCost.amount) || 0
        : 0
  };

  try {
    let item = qbo.bySku[skuKey] || null;

    // No SKU match → maybe an item with the same name and no SKU yet.
    if (!item) {
      const sameName = qbo.byName[data.name.toLowerCase()];

      if (sameName) {
        const existingSku = pqText_(sameName.Sku);

        if (existingSku && existingSku.toLowerCase() !== skuKey) {
          return Object.assign(base, {
            ok: false, action: 'skipped',
            qboName: sameName.Name,
            qboSku: sameName.Sku,
            error: 'QBO item with the same name already exists for a different SKU'
          });
        }

        item = sameName;
      }
    }

    if (!item) {
      return Object.assign(base, pqCreateItem_(data, qbo, options));
    }

    return Object.assign(base, pqUpdateItem_(item, data, qbo, options));
  } catch (err) {
    return Object.assign(base, {
      ok: false, action: 'failed',
      error: String(err)
    });
  }
}

function pqCreateItem_(data, qbo, options) {
  if (options.dryRun) {
    return { ok: true, action: 'created', dryRun: true };
  }

  const payload = {
    Name: data.name,
    Sku: data.sku,
    Type: 'Inventory',
    TrackQtyOnHand: true,
    QtyOnHand: 0,                      // QBO requires a start quantity; stock is not synced
    InvStartDate: pqProp_('QBO_INV_START_DATE') || PQ.DEFAULT_INV_START_DATE,
    IncomeAccountRef: { value: pqProp_('QBO_INCOME_ACCOUNT_ID', true) },
    ExpenseAccountRef: { value: pqProp_('QBO_EXPENSE_ACCOUNT_ID', true) },
    AssetAccountRef: { value: pqProp_('QBO_ASSET_ACCOUNT_ID', true) }
  };

  if (data.price > 0) payload.UnitPrice = data.price;
  if (data.cost > 0) payload.PurchaseCost = data.cost;

  const created = pqQbo_('post', '/item?minorversion=' + PQ.QBO_MINOR_VERSION, payload);
  pqIndexItem_(qbo, created.Item);

  return { ok: true, action: 'created', qboItemId: created.Item.Id };
}

/**
 * Sparse update: only the fields we send change. Quantity is never touched.
 */
function pqUpdateItem_(item, data, qbo, options) {
  const changed = [];

  const payload = {
    Id: item.Id,
    SyncToken: item.SyncToken,
    sparse: true,
    Name: item.Name,
    Type: item.Type
  };

  if (data.name && data.name !== item.Name) {
    payload.Name = data.name;
    changed.push('name');
  }

  if (pqText_(item.Sku).toLowerCase() !== data.sku.toLowerCase()) {
    payload.Sku = data.sku;
    changed.push('sku');
  }

  if (data.price > 0 && data.price !== Number(item.UnitPrice || 0)) {
    payload.UnitPrice = data.price;
    changed.push('price');
  }

  if (data.cost > 0 && data.cost !== Number(item.PurchaseCost || 0)) {
    payload.PurchaseCost = data.cost;
    changed.push('cost');
  }

  if (changed.length === 0) {
    return { ok: true, action: 'no_changes', qboItemId: item.Id };
  }

  if (options.dryRun) {
    return { ok: true, action: 'updated', dryRun: true, changed: changed };
  }

  const updated = pqQbo_('post', '/item?minorversion=' + PQ.QBO_MINOR_VERSION, payload);
  pqIndexItem_(qbo, updated.Item);

  return {
    ok: true,
    action: 'updated',
    qboItemId: updated.Item.Id,
    changed: changed
  };
}

/**
 * QBO names: max 100 chars, no colons, no tabs/newlines.
 */
function pqBuildName_(variant) {
  const product = pqText_(variant.product.title);
  const variantTitle = pqText_(variant.title);

  let name =
    !variantTitle ||
    variantTitle.toLowerCase() === 'default title' ||
    variantTitle === product
      ? product
      : product + ' - ' + variantTitle;

  name = name.replace(/[:\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

  return name.length > 100 ? name.substring(0, 100).trim() : name;
}


/* ============================================================
   SHOPIFY API
   ============================================================ */

function pqShopify_(query, variables) {
  const url =
    'https://' + pqProp_('SHOP', true) +
    '/admin/api/' + PQ.SHOPIFY_API_VERSION + '/graphql.json';

  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = pqFetch_(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Shopify-Access-Token': pqShopifyToken_() },
      payload: JSON.stringify({ query: query, variables: variables || {} })
    });

    if (response.getResponseCode() !== 200) {
      throw new Error(
        'Shopify HTTP ' + response.getResponseCode() + ': ' +
        response.getContentText()
      );
    }

    const body = JSON.parse(response.getContentText());

    if (body.errors) {
      const throttled = JSON.stringify(body.errors).indexOf('THROTTLED') !== -1;

      if (throttled && attempt < 4) {
        Utilities.sleep(attempt * 2000);
        continue;
      }

      throw new Error('Shopify GraphQL error: ' + JSON.stringify(body.errors));
    }

    return body;
  }

  throw new Error('Shopify request failed after retries');
}

function pqShopifyToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('shopify_access_token');
  if (cached) return cached;

  const response = pqFetch_(
    'https://' + pqProp_('SHOP', true) + '/admin/oauth/access_token',
    {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      payload: {
        client_id: pqProp_('CLIENT_ID', true),
        client_secret: pqProp_('CLIENT_SECRET', true),
        grant_type: 'client_credentials'
      }
    }
  );

  const body = JSON.parse(response.getContentText());

  if (response.getResponseCode() !== 200 || !body.access_token) {
    throw new Error(
      'Shopify token request failed HTTP ' + response.getResponseCode() +
      ': ' + response.getContentText()
    );
  }

  cache.put('shopify_access_token', body.access_token, 21600);
  return body.access_token;
}


/* ============================================================
   QBO API
   ============================================================ */

function pqLoadQboItems_() {
  const qbo = { bySku: {}, byName: {} };
  const pageSize = 1000;
  let start = 1;

  while (true) {
    const query =
      'SELECT * FROM Item WHERE Active IN (true, false) ' +
      'STARTPOSITION ' + start + ' MAXRESULTS ' + pageSize;

    const body = pqQbo_(
      'get',
      '/query?query=' + encodeURIComponent(query) +
        '&minorversion=' + PQ.QBO_MINOR_VERSION
    );

    const items = (body.QueryResponse && body.QueryResponse.Item) || [];
    items.forEach(function (item) { pqIndexItem_(qbo, item); });

    if (items.length < pageSize) break;
    start += pageSize;
  }

  return qbo;
}

function pqIndexItem_(qbo, item) {
  if (!item) return;

  const sku = pqText_(item.Sku).toLowerCase();
  const name = pqText_(item.Name).toLowerCase();

  if (sku) qbo.bySku[sku] = item;
  if (name) qbo.byName[name] = item;
}

function pqQbo_(method, path, payload) {
  const options = {
    method: method,
    headers: {
      Authorization: 'Bearer ' + pqQboToken_(),
      Accept: 'application/json'
    }
  };

  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }

  const response = pqFetch_(
    PQ.QBO_API_BASE + '/' + pqProp_('QBO_REALM_ID', true) + path,
    options
  );

  if (response.getResponseCode() !== 200) {
    throw new Error(
      'QBO HTTP ' + response.getResponseCode() + ': ' + response.getContentText()
    );
  }

  return JSON.parse(response.getContentText());
}

// One shared QBO token for the whole project (avoids two refresh-token rotations).
function pqQboToken_() {
  return getQboToken_();
}


/* ============================================================
   ISSUE SHEETS
   ============================================================ */

function pqSpreadsheet_() {
  const id = pqProp_('SHEET_ID') || pqProp_('SPREAD_SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : null;
}

function pqWriteIssues_(issues) {
  const ss = pqSpreadsheet_();
  if (!ss) return;

  const sheet =
    ss.getSheetByName(PQ.ISSUES_SHEET) || ss.insertSheet(PQ.ISSUES_SHEET);

  sheet.clear();

  const rows = [[
    'Product', 'Variant', 'SKU', 'Issue',
    'QBO name', 'QBO SKU', 'Shopify variant ID'
  ]];

  issues.forEach(function (r) { rows.push(pqIssueRow_(r)); });

  const range = sheet.getRange(1, 1, rows.length, rows[0].length);
  range.setNumberFormat('@');          // keep SKUs like 0911171 as text
  range.setValues(rows);
  sheet.setFrozenRows(1);
}

function pqAppendIssues_(issues) {
  if (!issues.length) return;

  const ss = pqSpreadsheet_();
  if (!ss) return;

  const sheet =
    ss.getSheetByName(PQ.WEBHOOK_SHEET) || ss.insertSheet(PQ.WEBHOOK_SHEET);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'Time', 'Product', 'Variant', 'SKU', 'Issue',
      'QBO name', 'QBO SKU', 'Shopify variant ID'
    ]);
    sheet.setFrozenRows(1);
  }

  const now = new Date().toISOString();
  const rows = issues.map(function (r) { return [now].concat(pqIssueRow_(r)); });

  const range = sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length);
  range.setNumberFormat('@');
  range.setValues(rows);
}

function pqIssueRow_(r) {
  return [
    r.productTitle || '', r.variantTitle || '', r.sku || '', r.error || '',
    r.qboName || '', r.qboSku || '', r.shopifyVariantId || ''
  ];
}


/* ============================================================
   SETUP / TEST HELPERS
   ============================================================ */

function pqWebhookUrl() {
  const base = pqProp_('WEBAPP_URL', true);

  if (!/\/exec$/.test(base)) {
    throw new Error('WEBAPP_URL must be the Web app URL ending in /exec');
  }

  const url =
    base +
    '?key=' + encodeURIComponent(pqProp_('WEBHOOK_KEY', true)) +
    '&src=pq';

  Logger.log(url);
  return url;
}

function pqTestOneProduct() {
  const PRODUCT_ID = '8828723462421';

  if (!/^\d+$/.test(PRODUCT_ID)) {
    throw new Error('Edit PRODUCT_ID inside pqTestOneProduct first');
  }

  const results = pqSyncProduct_(
    'gid://shopify/Product/' + PRODUCT_ID,
    pqLoadQboItems_()
  );

  Logger.log(JSON.stringify(results, null, 2));
  return results;
}


/* ============================================================
   HELPERS
   ============================================================ */

function pqProp_(name, required) {
  const value = PropertiesService.getScriptProperties().getProperty(name);

  if (required && !value) {
    throw new Error('Missing Script Property: ' + name);
  }

  return value || '';
}

function pqText_(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function pqJson_(object) {
  return ContentService
    .createTextOutput(JSON.stringify(object))
    .setMimeType(ContentService.MimeType.JSON);
}

function pqSafeCompare_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;

  let diff = 0;

  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return diff === 0;
}

/**
 * UrlFetchApp with retries on 429 / 5xx.
 */
function pqFetch_(url, options) {
  options.muteHttpExceptions = true;

  let response;

  for (let attempt = 1; attempt <= 4; attempt++) {
    response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();

    if (code !== 429 && code < 500) return response;

    Utilities.sleep(attempt * 2000);
  }

  return response;
}
