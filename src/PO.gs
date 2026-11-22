/*********************************************************
 * PO.gs — استلام أوامر الشراء من شوبيفاي → Bill في QBO
 * الموعد اليومي بيتدار من الواجهة (cron_po).
 * getQboToken_ موجودة في Bosta.gs (مشتركة لكل الملفات).
 *********************************************************/

// ===== SETTINGS =====
const QBO_BASE = 'https://quickbooks.api.intuit.com';
const SHOPIFY_API_VERSION = '2026-07';
const PO_API_VERSION = '2026-10';
const TIMEZONE = 'Africa/Cairo';

// ===== DAILY JOB =====
function dailyRun() {
  const props = PropertiesService.getScriptProperties();

  // قبل GO_LIVE_DATE: أي تحويل اتستلم بيتعلّم إنه اتعالج من غير Bill، عشان بعد البدء يتعمل Bill للجديد بس
  if (beforeGoLive_(todayCairo_())) {
    markExistingAsProcessed();
    return { ok: true, beforeGoLive: goLive_(), note: 'قبل تاريخ البدء: التحويلات المستلمة اتعلّمت إنها اتعالجت من غير Bill' };
  }

  if (!props.getProperty('PROCESSED')) {
    throw new Error('Run markExistingAsProcessed() once first.');
  }

  try {
    getQboToken_(props);
  } catch (e) {
    Logger.log('QBO keepalive failed: ' + e);
  }

  const processed = JSON.parse(props.getProperty('PROCESSED'));
  const token = getShopifyToken_(props);
  const suppliers = getSuppliersByTransfer_(props, token);

  const received = getReceivedTransfers_(props, token)
    .filter(t => processed.indexOf(t.id) === -1)
    .reverse();

  const done = [], failed = [];

  received.forEach(t => {
    try {
      const supplierName = suppliers[t.id];

      if (!supplierName) {
        throw new Error(
          'No supplier found in Shopify purchase order for ' + t.name
        );
      }

      processTransfer_(
        props, token, t.id, t.name, supplierName
      );

      processed.push(t.id);
      props.setProperty(
        'PROCESSED',
        fitJson_(processed.slice(-300))
      );
      done.push(t.name);

    } catch (err) {
      Logger.log('Failed ' + t.name + ': ' + err);
      failed.push({ transfer: t.name, error: String(err) });
    }
  });

  return { ok: !failed.length, processed: done, failed: failed };
}

// ===== PROCESS TRANSFER =====
function processTransfer_(props, token, id, ref, supplierName) {
  const items = getTransferItems_(props, token, id);
  if (!items.length) return;

  const ss = SpreadsheetApp.openById(
    props.getProperty('SPREAD_SHEET_ID')
  );

  // تاب PO بيتكتب فيه أصناف آخر تحويل اتستلم. لو مش موجود بيتعمل لوحده.
  const sh = ss.getSheetByName('PO') || ss.insertSheet('PO');

  sh.clearContents();

  const rows = [['Product', '', '', 'Qty received', 'SKU']]
    .concat(
      items.map(i => [i.title, '', '', i.qty, i.sku])
    );

  sh.getRange(1, 1, rows.length, 5).setValues(rows);
  SpreadsheetApp.flush();

  createQboBill_(props, items, ref, supplierName);
}

// ===== ONE-TIME SETUP =====
function markExistingAsProcessed() {
  const props = PropertiesService.getScriptProperties();
  const token = getShopifyToken_(props);

  const ids = getReceivedTransfers_(props, token)
    .map(t => t.id);

  // بنضيف على اللي موجود (مش بنستبدل) عشان تحويل اتعالج قبل كده ما يرجعش تاني
  const old = JSON.parse(props.getProperty('PROCESSED') || '[]');
  ids.forEach(function (id) { if (old.indexOf(id) === -1) old.push(id); });
  props.setProperty('PROCESSED', fitJson_(old.slice(-300)));

  Logger.log(
    'Marked ' + ids.length + ' existing transfers as processed.'
  );
}

// ===== SHOPIFY AUTHENTICATION =====
function getShopifyToken_(props) {
  const shop = props.getProperty('SHOP');

  const res = UrlFetchApp.fetch(
    'https://' + shop + '/admin/oauth/access_token',
    {
      method: 'post',
      payload: {
        grant_type: 'client_credentials',
        client_id: props.getProperty('CLIENT_ID'),
        client_secret: props.getProperty('CLIENT_SECRET')
      },
      muteHttpExceptions: true
    }
  );

  const body = res.getContentText();
  let json = {};

  try {
    json = JSON.parse(body);
  } catch (e) {
    throw new Error(
      'Shopify token HTTP ' + res.getResponseCode() +
      ': ' + body.substring(0, 300)
    );
  }

  if (res.getResponseCode() >= 300 || !json.access_token) {
    throw new Error(
      'Shopify token HTTP ' + res.getResponseCode() +
      ': ' + body.substring(0, 300)
    );
  }

  return json.access_token;
}

// ===== SHOPIFY GRAPHQL =====
function shopifyGql_(props, token, query, variables) {
  const res = UrlFetchApp.fetch(
    'https://' + props.getProperty('SHOP') +
      '/admin/api/' + SHOPIFY_API_VERSION + '/graphql.json',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'X-Shopify-Access-Token': token
      },
      payload: JSON.stringify({
        query: query,
        variables: variables || {}
      }),
      muteHttpExceptions: true
    }
  );

  const body = res.getContentText();
  const json = JSON.parse(body);

  if (res.getResponseCode() >= 300 || json.errors || !json.data) {
    throw new Error('Shopify response: ' + body);
  }

  return json.data;
}

// ===== PURCHASE ORDER GRAPHQL =====
function shopifyPoGql_(props, token, query, variables) {
  const res = UrlFetchApp.fetch(
    'https://' + props.getProperty('SHOP') +
      '/admin/api/' + PO_API_VERSION + '/graphql.json',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'X-Shopify-Access-Token': token
      },
      payload: JSON.stringify({ query: query, variables: variables || {} }),
      muteHttpExceptions: true
    }
  );

  const body = res.getContentText();
  const json = JSON.parse(body);

  if (res.getResponseCode() >= 300 || json.errors || !json.data) {
    throw new Error('Shopify purchase orders: ' + body);
  }

  return json.data;
}

// ===== SUPPLIER LOOKUP BY TRANSFER =====
function getSuppliersByTransfer_(props, token) {
  const suppliers = {};
  let after = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = shopifyPoGql_(props, token, `
      query($after: String) {
        inventoryPurchaseOrders(first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            name
            origin {
              supplierName
            }
            transfers(first: 100) {
              nodes {
                id
                name
              }
            }
          }
        }
      }
    `, { after: after });

    const connection = data.inventoryPurchaseOrders;

    connection.nodes.forEach(po => {
      const supplierName =
        po.origin &&
        po.origin.supplierName;

      if (!supplierName) return;

      (po.transfers.nodes || []).forEach(transfer => {
        suppliers[transfer.id] = supplierName;
      });
    });

    hasNextPage = connection.pageInfo.hasNextPage;
    after = connection.pageInfo.endCursor;
  }

  Logger.log(
    'Transfers linked to purchase orders: ' +
    JSON.stringify(suppliers)
  );

  return suppliers;
}

function debugSupplierLookup() {
  const props = PropertiesService.getScriptProperties();
  const token = getShopifyToken_(props);

  const data = shopifyPoGql_(props, token, `
    query {
      inventoryPurchaseOrders(first: 50) {
        nodes {
          name
          status
          origin {
            supplierName
          }
          transfers(first: 50) {
            nodes {
              id
              name
              status
            }
          }
        }
      }
    }
  `);

  const nodes = data.inventoryPurchaseOrders.nodes;

  Logger.log('Purchase orders found: ' + nodes.length);

  nodes.forEach(po => {
    Logger.log(
      'PO: ' + po.name +
      ' | status: ' + po.status +
      ' | supplier: ' + (po.origin && po.origin.supplierName) +
      ' | transfers: ' + (po.transfers.nodes || []).length
    );

    (po.transfers.nodes || []).forEach(t => {
      Logger.log(
        '   linked transfer: ' + t.name +
        ' | id: ' + t.id +
        ' | status: ' + t.status
      );
    });
  });

  const transfers = getReceivedTransfers_(props, token);

  Logger.log('Received transfers: ' + transfers.length);

  transfers.forEach(t => {
    Logger.log(
      'Received transfer: ' + t.name +
      ' | id: ' + t.id
    );
  });
}

// ===== GET RECEIVED TRANSFERS =====
function getReceivedTransfers_(props, token) {
  const data = shopifyGql_(
    props,
    token,
    `{
      inventoryTransfers(first: 50, reverse: true) {
        nodes {
          id
          name
          status
        }
      }
    }`
  );

  return data.inventoryTransfers.nodes.filter(
    t => t.status === 'TRANSFERRED'
  );
}

// ===== GET TRANSFER ITEMS =====
function getTransferItems_(props, token, id) {
  const query = `
    query($id: ID!) {
      inventoryTransfer(id: $id) {
        shipments(first: 20) {
          nodes {
            lineItems(first: 100) {
              nodes {
                acceptedQuantity
                inventoryItem {
                  sku
                  unitCost {
                    amount
                  }
                  variant {
                    title
                    product {
                      title
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = shopifyGql_(props, token, query, { id: id });

  if (!data.inventoryTransfer) {
    throw new Error('Transfer not found: ' + id);
  }

  const map = {};

  data.inventoryTransfer.shipments.nodes.forEach(shipment => {
    shipment.lineItems.nodes.forEach(item => {
      const inventoryItem = item.inventoryItem;
      const variant = inventoryItem.variant;

      const variantTitle =
        variant && variant.title !== 'Default Title'
          ? ' - ' + variant.title
          : '';

      const sku = inventoryItem.sku || '';

      const key = sku ||
        (variant ? variant.product.title + variantTitle : '');

      if (!map[key]) {
        map[key] = {
          title: (variant ? variant.product.title : '') + variantTitle,
          qty: 0,
          sku: sku,
          cost: parseFloat(
            inventoryItem.unitCost
              ? inventoryItem.unitCost.amount
              : 0
          ) || 0
        };
      }

      map[key].qty += item.acceptedQuantity || 0;
    });
  });

  return Object.values(map).filter(item => item.qty > 0);
}

// ===== QUICKBOOKS QUERY =====
function qboQuery_(props, token, query) {
  const url =
    QBO_BASE + '/v3/company/' +
    props.getProperty('QBO_REALM_ID') +
    '/query?minorversion=75&query=' +
    encodeURIComponent(query);

  const res = UrlFetchApp.fetch(url, {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json'
    },
    muteHttpExceptions: true
  });

  const body = res.getContentText();
  const json = JSON.parse(body);

  if (res.getResponseCode() >= 300 || json.Fault) {
    throw new Error('QBO query failed: ' + body);
  }

  return json.QueryResponse;
}

// ===== FIND QBO VENDOR BY NAME =====
function getQboVendorId_(props, token, supplierName) {
  const escaped = String(supplierName).replace(/'/g, "\\'");

  const result = qboQuery_(
    props,
    token,
    "select Id, DisplayName from Vendor where DisplayName = '" +
      escaped + "'"
  );

  if (!result.Vendor || result.Vendor.length !== 1) {
    throw new Error(
      'Expected exactly one QBO vendor named "' +
      supplierName +
      '". Check the supplier name in Shopify and QuickBooks.'
    );
  }

  return result.Vendor[0].Id;
}

// ===== INVENTORY ACCOUNTS (قابلة للتغيير من الإعدادات) =====
const OFFSET_START_DATE = '2026-10-12'; // bills dated before this posted to Inventory Asset directly

function poAssetAcc_() {
  return PropertiesService.getScriptProperties().getProperty('QBO_INVENTORY_ASSET_ACCOUNT_ID') || '121';
}
function poOffsetAcc_() {
  return PropertiesService.getScriptProperties().getProperty('QBO_INVENTORY_OFFSET_ACCOUNT_ID') || '315';
}

// ===== CREATE QUICKBOOKS BILL =====
function createQboBill_(props, items, ref, supplierName) {
  const token = getQboToken_(props);
  const vendorId = getQboVendorId_(props, token, supplierName);
  const docNumber = String(ref).substring(0, 21);

  const existing = qboQuery_(
    props, token,
    "select * from Bill where DocNumber = '" + docNumber + "'"
  );

  // Bill already exists (e.g. a retry after a failed journal): just make sure the reclass exists.
  if (existing.Bill && existing.Bill.length) {
    Logger.log('Bill already exists: ' + docNumber);
    const b = existing.Bill[0];
    ensureReclassJournal_(props, token, docNumber, b.TxnDate, b.TotalAmt);
    return;
  }

  const lines = [];
  const missing = [];

  items.forEach(item => {
    const sku = String(item.sku).replace(/'/g, "\\'");
    const result = qboQuery_(
      props, token, "select Id from Item where Sku = '" + sku + "'"
    );

    if (!result.Item || !result.Item.length) {
      missing.push(item.sku);
      return;
    }

    lines.push({
      DetailType: 'ItemBasedExpenseLineDetail',
      Amount: Math.round(item.qty * item.cost * 100) / 100,   // QBO wants 2 decimals
      ItemBasedExpenseLineDetail: {
        ItemRef: { value: result.Item[0].Id },
        Qty: item.qty,
        UnitPrice: item.cost
      }
    });
  });

  if (missing.length) {
    throw new Error('SKUs not found in QBO: ' + missing.join(', '));
  }
  if (!lines.length) {
    throw new Error('No valid bill lines to create.');
  }

  const res = UrlFetchApp.fetch(
    QBO_BASE + '/v3/company/' + props.getProperty('QBO_REALM_ID') +
      '/bill?minorversion=75',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      payload: JSON.stringify({
        VendorRef: { value: vendorId },
        DocNumber: docNumber,
        Line: lines
      }),
      muteHttpExceptions: true
    }
  );

  if (res.getResponseCode() >= 300) {
    throw new Error('QBO bill creation failed: ' + res.getContentText());
  }

  const bill = JSON.parse(res.getContentText()).Bill;
  Logger.log('Bill created: ' + docNumber + ', supplier: ' + supplierName);

  ensureReclassJournal_(props, token, docNumber, bill.TxnDate, bill.TotalAmt);
}

// ===== RECLASS: Inventory Offset -> Inventory Asset (idempotent) =====
function ensureReclassJournal_(props, token, billDocNumber, txnDate, total) {
  const amount = Math.round(Number(total) * 100) / 100;
  if (!(amount > 0)) return;

  const jeDoc = ('RCL-' + billDocNumber).substring(0, 21);

  const found = qboQuery_(
    props, token,
    "select Id from JournalEntry where DocNumber = '" + jeDoc + "'"
  );
  if (found.JournalEntry && found.JournalEntry.length) {
    Logger.log('Reclass journal already exists: ' + jeDoc);
    return;
  }

  const res = UrlFetchApp.fetch(
    QBO_BASE + '/v3/company/' + props.getProperty('QBO_REALM_ID') +
      '/journalentry?minorversion=75',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      payload: JSON.stringify({
        DocNumber: jeDoc,
        TxnDate: txnDate,
        PrivateNote: 'Reclass Inventory Offset to Inventory Asset for bill ' + billDocNumber,
        Line: [
          {
            DetailType: 'JournalEntryLineDetail',
            Amount: amount,
            Description: 'Bill ' + billDocNumber,
            JournalEntryLineDetail: {
              PostingType: 'Debit',
              AccountRef: { value: poAssetAcc_() }
            }
          },
          {
            DetailType: 'JournalEntryLineDetail',
            Amount: amount,
            Description: 'Bill ' + billDocNumber,
            JournalEntryLineDetail: {
              PostingType: 'Credit',
              AccountRef: { value: poOffsetAcc_() }
            }
          }
        ]
      }),
      muteHttpExceptions: true
    }
  );

  if (res.getResponseCode() >= 300) {
    throw new Error('QBO reclass journal failed: ' + res.getContentText());
  }
  Logger.log('Reclass journal created: ' + jeDoc + ' amount ' + amount);
}

// ===== ONE-TIME: fix bills already posted to Inventory Offset =====
function reclassExistingBills() {
  const props = PropertiesService.getScriptProperties();
  const token = getQboToken_(props);

  const r = qboQuery_(
    props, token,
    "select * from Bill where TxnDate >= '" + OFFSET_START_DATE +
    "' and DocNumber like '#T%' maxresults 1000"
  );

  (r.Bill || []).forEach(b => {
    ensureReclassJournal_(props, token, b.DocNumber, b.TxnDate, b.TotalAmt);
  });
}

// ===== DEBUG SHOPIFY TOKEN =====
function debugShopifyToken() {
  const props = PropertiesService.getScriptProperties();
  const shop = props.getProperty('SHOP') || '';
  const id = props.getProperty('CLIENT_ID') || '';
  const secret = props.getProperty('CLIENT_SECRET') || '';

  Logger.log('SHOP: "' + shop + '"');
  Logger.log(
    'CLIENT_ID length: ' + id.length +
    ', starts: "' + id.substring(0, 4) + '"'
  );
  Logger.log('CLIENT_SECRET length: ' + secret.length);

  const res = UrlFetchApp.fetch(
    'https://' + shop + '/admin/oauth/access_token',
    {
      method: 'post',
      payload: {
        grant_type: 'client_credentials',
        client_id: id,
        client_secret: secret
      },
      muteHttpExceptions: true
    }
  );

  const body = res.getContentText()
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

  Logger.log(
    'HTTP ' + res.getResponseCode() +
    ': ' + body.substring(0, 500)
  );
}

// ===== TEST ONE TRANSFER =====
function testOne() {
  const props = PropertiesService.getScriptProperties();
  const token = getShopifyToken_(props);

  const transfers = getReceivedTransfers_(props, token);

  if (!transfers.length) {
    throw new Error('No received transfers found.');
  }

  const t = transfers[0];
  const suppliers = getSuppliersByTransfer_(props, token);
  const supplierName = suppliers[t.id];

  if (!supplierName) {
    throw new Error(
      'No supplier found for transfer ' + t.name
    );
  }

  Logger.log(
    'Testing transfer: ' + t.name +
    ', supplier: ' + supplierName
  );

  processTransfer_(
    props, token, t.id, t.name, supplierName
  );
}

function debugQboItems() {
  const props = PropertiesService.getScriptProperties();
  const token = getQboToken_(props);

  const r = qboQuery_(props, token,
    "select * from Item where Sku = '36020604'");

  const it = (r.Item || [])[0];
  if (!it) {
    Logger.log('Item not found');
    return;
  }

  Logger.log(JSON.stringify({
    Name: it.Name,
    Sku: it.Sku,
    Type: it.Type,
    TrackQtyOnHand: it.TrackQtyOnHand,
    InvStartDate: it.InvStartDate,
    AssetAccountRef: it.AssetAccountRef,
    ExpenseAccountRef: it.ExpenseAccountRef,
    IncomeAccountRef: it.IncomeAccountRef
  }, null, 2));
}

function debugInventoryOffset() {
  const props = PropertiesService.getScriptProperties();
  const token = getQboToken_(props);

  const acc = qboQuery_(props, token,
    "select * from Account where Name like '%offset%'");
  Logger.log(JSON.stringify(acc.Account, null, 2));

  const bills = qboQuery_(props, token,
    "select * from Bill orderby MetaData.CreateTime desc maxresults 1");
  Logger.log(JSON.stringify(bills.Bill, null, 2));
}
