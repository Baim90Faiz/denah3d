const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { close, get, initDatabase } = require('../db/init');
const { createApp } = require('../server');

let tempDirectory;
let database;
let server;
let baseUrl;

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'denah3d-test-'));
  database = await initDatabase(path.join(tempDirectory, 'rack-management.db'));
  server = createApp(database).listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (database) await close(database);
  if (tempDirectory) fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('serves the dashboard, validates writes, and persists variants and batches', async () => {
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /RACK MANAGEMENT GUDANG ENZIM/);

  const dashboardResponse = await fetch(`${baseUrl}/api/dashboard`);
  assert.equal(dashboardResponse.status, 200);
  const dashboard = await dashboardResponse.json();
  assert.equal(dashboard.floors.length, 2);
  assert.equal(dashboard.floors.find(floor => floor.floor_number === 1).racks.reduce((sum, rack) => sum + rack.slot_count, 0), 112);
  assert.equal(dashboard.floors.find(floor => floor.floor_number === 2).racks.reduce((sum, rack) => sum + rack.slot_count, 0), 314);
  assert.equal(dashboard.floors.reduce((sum, floor) => sum + floor.racks.reduce((floorSum, rack) => floorSum + rack.slot_count, 0), 0), 426);
  assert.equal(dashboard.zones.QUARANTINE, 24);
  assert.equal(dashboard.zones.REJECT, 8);
  const selectedRack = dashboard.floors.find(floor => floor.floor_number === 1).racks[0];
  const slotsResponse = await fetch(`${baseUrl}/api/racks/${selectedRack.id}/slots`);
  assert.equal(slotsResponse.status, 200);
  const { slots } = await slotsResponse.json();
  assert.equal(slots.length, 24);
  assert.equal(slots[0].zone_type, 'QUARANTINE');

  const variantResponse = await fetch(`${baseUrl}/api/product-variants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test Variant', size: '80g', packaging: 'Box' })
  });
  assert.equal(variantResponse.status, 201);
  const { variant } = await variantResponse.json();

  const invalidBatchResponse = await fetch(`${baseUrl}/api/stock-batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variantId: variant.id, batchNumber: '', quantityBoxes: 0 })
  });
  assert.equal(invalidBatchResponse.status, 400);

  const batchData = {
    variantId: variant.id,
    rackSlotId: slots[0].id,
    batchNumber: 'TEST-2026-01',
    quantityBoxes: 125,
    notes: 'Uji simpan'
  };
  const batchResponse = await fetch(`${baseUrl}/api/stock-batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batchData)
  });
  assert.equal(batchResponse.status, 201);

  const duplicateBatchResponse = await fetch(`${baseUrl}/api/stock-batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batchData)
  });
  assert.equal(duplicateBatchResponse.status, 409);

  const storedBatch = await get(database, 'SELECT quantity_boxes, notes FROM stock_batches WHERE batch_number = ?', [batchData.batchNumber]);
  assert.deepEqual(storedBatch, { quantity_boxes: 125, notes: 'Uji simpan' });
  const storedLocation = await get(database, `
    SELECT l.quantity_boxes, s.row_number, s.level_code, s.zone_type
    FROM stock_locations l JOIN rack_slots s ON s.id = l.rack_slot_id
    WHERE l.stock_batch_id = (SELECT id FROM stock_batches WHERE batch_number = ?)
  `, [batchData.batchNumber]);
  assert.deepEqual(storedLocation, {
    quantity_boxes: 125,
    row_number: 1,
    level_code: 'A',
    zone_type: 'QUARANTINE'
  });

  const updatedDashboard = await (await fetch(`${baseUrl}/api/dashboard`)).json();
  const updatedVariant = updatedDashboard.variants.find(item => item.id === variant.id);
  assert.equal(updatedVariant.batch_count, 1);
  assert.equal(updatedVariant.total_boxes, 125);
  assert.equal(updatedDashboard.batches[0].batch_number, batchData.batchNumber);
  assert.equal(updatedDashboard.batches[0].rack_code, 'A');
  assert.equal(updatedDashboard.batches[0].floor_number, 1);
});

test('migrates the previous JSON database and keeps a source backup', async () => {
  const legacyPath = path.join(tempDirectory, 'legacy', 'rack-management.db');
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  const legacyFloor = {
    id: 'legacy-floor-1',
    floor_number: 1,
    name: 'Gudang lama',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z'
  };
  fs.writeFileSync(legacyPath, JSON.stringify({
    floors: [legacyFloor],
    racks: [],
    rack_slots: [],
    product_variants: [],
    stock_batches: [],
    stock_locations: [],
    profiles: [],
    audit_logs: []
  }));

  const legacyDb = await initDatabase(legacyPath);
  try {
    const floor = await get(legacyDb, 'SELECT name FROM floors WHERE id = ?', [legacyFloor.id]);
    assert.deepEqual(floor, { name: 'Gudang lama' });
    assert.ok(fs.existsSync(`${legacyPath}.legacy-json`));
    const sqliteHeader = fs.readFileSync(legacyPath).subarray(0, 16).toString();
    assert.equal(sqliteHeader, 'SQLite format 3\u0000');
  } finally {
    await close(legacyDb);
  }
});
