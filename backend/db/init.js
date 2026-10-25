const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const rackDefinitions = {
  1: [
    { code: 'A', rows: 12, levels: ['A', 'B'], zone: 'QUARANTINE' },
    { code: 'B', rows: 12, levels: ['A', 'B'], zone: 'NORMAL' },
    { code: 'C', rows: 10, levels: ['A', 'B'], zone: 'NORMAL' },
    { code: 'D', rows: 10, levels: ['A', 'B'], zone: 'NORMAL' },
    { code: 'E', rows: 12, levels: ['A', 'B'], zone: 'NORMAL' }
  ],
  2: [
    { code: 'A', rows: 14, levels: ['A', 'B', 'C'], zone: 'NORMAL' },
    { code: 'B', rows: 14, levels: ['A', 'B', 'C', 'D'], zone: 'NORMAL' },
    { code: 'C', rows: 14, levels: ['A', 'B', 'C', 'D'], zone: 'NORMAL' },
    { code: 'D', rows: 14, levels: ['A', 'B', 'C', 'D'], zone: 'NORMAL' },
    { code: 'E', rows: 14, levels: ['A', 'B', 'C', 'D'], zone: 'NORMAL' },
    { code: 'F', rows: 16, levels: ['A', 'B', 'C'], zone: 'NORMAL' }
  ]
};

const defaultVariants = [
  { name: 'PGE. Mint 58 gr', size: '58 gr', packaging: 'Box' },
  { name: 'PGE. MINT 118 gr', size: '118 gr', packaging: 'Box' },
  { name: 'PGE. Regular 58 gr', size: '58 gr', packaging: 'Box' },
  { name: 'PGE. REGULAR 118 gr', size: '118 gr', packaging: 'Box' },
  { name: 'PGE. Anak2x Putih 58 gr', size: '58 gr', packaging: 'Box' },
  { name: 'PGE. Anak2x Merah 58 gr', size: '58 gr', packaging: 'Box' },
  { name: 'PGE. Anak2x Biru 58 gr', size: '58 gr', packaging: 'Box' },
  { name: 'PGE. Anak2x Orange 58 gr', size: '58 gr', packaging: 'Box' },
  { name: 'PGE. 40 plus 50ml', size: '50ml', packaging: 'Box' },
  { name: 'PGE. 40+ 118 gr', size: '118 gr', packaging: 'Box' },
  { name: 'PGE. Mint 35ml', size: '35ml', packaging: 'Box' },
  { name: 'PGE. Anak Merah 35ml', size: '35ml', packaging: 'Box' },
  { name: 'PGE. Anak Orange 35ml', size: '35ml', packaging: 'Box' },
  { name: 'PGE. Orthodontic 50ml', size: '50ml', packaging: 'Box' },
  { name: 'PGE. Ortho 118 gr', size: '118 gr', packaging: 'Box' },
  { name: 'PGE. Ortho 118 gr SIKAT', size: '118 gr SIKAT', packaging: 'Box' },
  { name: 'PGE. 40 plus 118 gr TWIN PACK', size: '118 gr TWIN PACK', packaging: 'Box' },
  { name: 'PGE. 40+ 118 gr PROG IV', size: '118 gr PROG IV', packaging: 'Box' },
  { name: 'PGE. DR. ENZYM 118 gr', size: '118 gr', packaging: 'Box' },
  { name: 'PGE. 40+ 148 gr', size: '148 gr', packaging: 'Box' },
  { name: 'PGE. Mint 148 gr', size: '148 gr', packaging: 'Box' }
];

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

function exec(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, error => error ? reject(error) : resolve());
  });
}

function close(db) {
  return new Promise((resolve, reject) => {
    db.close(error => error ? reject(error) : resolve());
  });
}

function open(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, error => {
      if (error) reject(error);
      else resolve(db);
    });
  });
}

function readLegacyJson(dbPath) {
  if (!fs.existsSync(dbPath)) return null;

  const contents = fs.readFileSync(dbPath);
  if (contents.length === 0 || contents.subarray(0, 16).toString() === 'SQLite format 3\u0000') {
    return null;
  }

  let legacy;
  try {
    legacy = JSON.parse(contents.toString('utf8'));
  } catch (error) {
    throw new Error(`Database file "${dbPath}" is neither SQLite nor valid legacy JSON.`, { cause: error });
  }

  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) {
    throw new Error(`Legacy database file "${dbPath}" must contain a JSON object.`);
  }

  const backupPath = `${dbPath}.legacy-json`;
  if (fs.existsSync(backupPath)) {
    throw new Error(`Legacy database backup already exists at "${backupPath}"; move it before retrying migration.`);
  }
  fs.renameSync(dbPath, backupPath);
  return legacy;
}

async function createSchema(db) {
  await exec(db, `
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS floors (
      id TEXT PRIMARY KEY,
      floor_number INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS racks (
      id TEXT PRIMARY KEY,
      floor_id TEXT NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
      rack_code TEXT NOT NULL,
      row_count INTEGER NOT NULL CHECK (row_count > 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (floor_id, rack_code)
    );
    CREATE TABLE IF NOT EXISTS rack_slots (
      id TEXT PRIMARY KEY,
      rack_id TEXT NOT NULL REFERENCES racks(id) ON DELETE CASCADE,
      row_number INTEGER NOT NULL CHECK (row_number > 0),
      level_code TEXT NOT NULL,
      zone_type TEXT NOT NULL CHECK (zone_type IN ('NORMAL', 'QUARANTINE', 'REJECT')),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (rack_id, row_number, level_code)
    );
    CREATE TABLE IF NOT EXISTS product_variants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      size TEXT NOT NULL DEFAULT '',
      packaging TEXT NOT NULL DEFAULT 'Box',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS stock_batches (
      id TEXT PRIMARY KEY,
      variant_id TEXT NOT NULL REFERENCES product_variants(id),
      batch_number TEXT NOT NULL COLLATE NOCASE,
      quantity_boxes INTEGER NOT NULL CHECK (quantity_boxes > 0),
      notes TEXT NOT NULL DEFAULT '',
      production_date TEXT,
      expiry_date TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS stock_locations (
      id TEXT PRIMARY KEY,
      stock_batch_id TEXT NOT NULL REFERENCES stock_batches(id) ON DELETE CASCADE,
      rack_slot_id TEXT NOT NULL REFERENCES rack_slots(id),
      quantity_boxes INTEGER NOT NULL CHECK (quantity_boxes > 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (stock_batch_id, rack_slot_id)
    );
    CREATE TABLE IF NOT EXISTS loose_cabinets (
      id TEXT PRIMARY KEY,
      floor_number INTEGER NOT NULL DEFAULT 1 CHECK (floor_number = 1),
      cabinet_code TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS loose_cabinet_slots (
      id TEXT PRIMARY KEY,
      cabinet_id TEXT NOT NULL REFERENCES loose_cabinets(id) ON DELETE CASCADE,
      slot_number INTEGER NOT NULL CHECK (slot_number BETWEEN 1 AND 20),
      variant_id TEXT REFERENCES product_variants(id),
      quantity_pieces INTEGER NOT NULL DEFAULT 0 CHECK (quantity_pieces >= 0),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (cabinet_id, slot_number)
    );
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      email TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_id TEXT,
      action TEXT NOT NULL DEFAULT '',
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT,
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_racks_floor_id ON racks(floor_id);
    CREATE INDEX IF NOT EXISTS idx_slots_rack_id ON rack_slots(rack_id);
    CREATE INDEX IF NOT EXISTS idx_batches_variant_id ON stock_batches(variant_id);
    CREATE INDEX IF NOT EXISTS idx_locations_slot_id ON stock_locations(rack_slot_id);
  `);
  const batchColumns = await all(db, 'PRAGMA table_info(stock_batches)');
  if (!batchColumns.some(column => column.name === 'production_date')) {
    await exec(db, 'ALTER TABLE stock_batches ADD COLUMN production_date TEXT');
  }
  if (!batchColumns.some(column => column.name === 'expiry_date')) {
    await exec(db, 'ALTER TABLE stock_batches ADD COLUMN expiry_date TEXT');
  }
  const batchIndexes = await all(db, 'PRAGMA index_list(stock_batches)');
  let hasUniqueBatchNumber = false;
  for (const index of batchIndexes.filter(item => item.unique)) {
    const columns = await all(db, `PRAGMA index_info("${index.name.replace(/"/g, '""')}")`);
    if (columns.length === 1 && columns[0].name === 'batch_number') hasUniqueBatchNumber = true;
  }
  if (hasUniqueBatchNumber) {
    await exec(db, `
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE stock_batches_rebuild (
        id TEXT PRIMARY KEY,
        variant_id TEXT NOT NULL REFERENCES product_variants(id),
        batch_number TEXT NOT NULL COLLATE NOCASE,
        quantity_boxes INTEGER NOT NULL CHECK (quantity_boxes > 0),
        notes TEXT NOT NULL DEFAULT '',
        production_date TEXT,
        expiry_date TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO stock_batches_rebuild
        (id, variant_id, batch_number, quantity_boxes, notes, production_date, expiry_date, created_at, updated_at)
      SELECT id, variant_id, batch_number, quantity_boxes, notes, production_date, expiry_date, created_at, updated_at
      FROM stock_batches;
      DROP TABLE stock_batches;
      ALTER TABLE stock_batches_rebuild RENAME TO stock_batches;
      CREATE INDEX IF NOT EXISTS idx_batches_variant_id ON stock_batches(variant_id);
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }
}

async function normalizePalletLocations(db) {
  await run(db, 'BEGIN IMMEDIATE');
  try {
    const multiLocationBatches = await all(db, `
      SELECT b.id, b.variant_id, b.batch_number, b.notes, b.production_date, b.expiry_date,
        b.created_at, b.updated_at
      FROM stock_batches b
      JOIN stock_locations l ON l.stock_batch_id = b.id
      GROUP BY b.id
      HAVING COUNT(l.id) > 1
    `);
    for (const batch of multiLocationBatches) {
      const locations = await all(db, `
        SELECT id, quantity_boxes FROM stock_locations
        WHERE stock_batch_id = ? ORDER BY created_at, id
      `, [batch.id]);
      await run(db, 'UPDATE stock_batches SET quantity_boxes = ? WHERE id = ?', [locations[0].quantity_boxes, batch.id]);
      for (const location of locations.slice(1)) {
        const newBatchId = crypto.randomUUID();
        await run(db, `
          INSERT INTO stock_batches
            (id, variant_id, batch_number, quantity_boxes, notes, production_date, expiry_date, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [newBatchId, batch.variant_id, batch.batch_number, location.quantity_boxes, batch.notes,
          batch.production_date, batch.expiry_date, batch.created_at, batch.updated_at]);
        await run(db, 'UPDATE stock_locations SET stock_batch_id = ? WHERE id = ?', [newBatchId, location.id]);
      }
    }

    const collisions = await all(db, `
      SELECT s.id AS slot_id, s.rack_id, r.rack_code, f.floor_number, s.row_number, s.level_code
      FROM rack_slots s
      JOIN racks r ON r.id = s.rack_id
      JOIN floors f ON f.id = r.floor_id
      JOIN stock_locations l ON l.rack_slot_id = s.id AND l.quantity_boxes > 0
      JOIN stock_batches b ON b.id = l.stock_batch_id
      GROUP BY s.id
      HAVING COUNT(DISTINCT b.variant_id) > 1
    `);
    for (const collision of collisions) {
      const variants = await all(db, `
        SELECT b.variant_id, v.name, COUNT(DISTINCT b.id) AS pallet_count
        FROM stock_locations l JOIN stock_batches b ON b.id = l.stock_batch_id
        JOIN product_variants v ON v.id = b.variant_id
        WHERE l.rack_slot_id = ? AND l.quantity_boxes > 0
        GROUP BY b.variant_id ORDER BY pallet_count DESC, v.name
      `, [collision.slot_id]);
      for (const variant of variants.slice(1)) {
        const locations = await all(db, `
          SELECT id FROM stock_locations
          WHERE rack_slot_id = ? AND quantity_boxes > 0 AND stock_batch_id IN
            (SELECT id FROM stock_batches WHERE variant_id = ?)
          ORDER BY created_at, id
        `, [collision.slot_id, variant.variant_id]);
        for (const location of locations) {
          const destination = await get(db, `
            SELECT s.id FROM rack_slots s
            WHERE s.rack_id = ? AND s.is_active = 1 AND NOT EXISTS (
              SELECT 1 FROM stock_locations l WHERE l.rack_slot_id = s.id AND l.quantity_boxes > 0
            ) ORDER BY s.row_number, s.level_code LIMIT 1
          `, [collision.rack_id]);
          if (!destination) {
            throw new Error(`Tidak dapat merapikan variant bertumpuk di Lantai ${collision.floor_number} Rak ${collision.rack_code}: tidak ada slot kosong.`);
          }
          await run(db, 'UPDATE stock_locations SET rack_slot_id = ? WHERE id = ?', [destination.id, location.id]);
        }
      }
    }
    await run(db, 'COMMIT');
  } catch (error) {
    await run(db, 'ROLLBACK');
    throw error;
  }
}

function valueOr(row, key, fallback) {
  return row[key] === undefined || row[key] === null ? fallback : row[key];
}

async function importLegacyRows(db, legacy) {
  const collections = [
    'floors', 'racks', 'rack_slots', 'product_variants',
    'stock_batches', 'stock_locations', 'profiles', 'audit_logs'
  ];
  for (const name of collections) {
    if (legacy[name] !== undefined && !Array.isArray(legacy[name])) {
      throw new Error(`Legacy database collection "${name}" must be an array.`);
    }
  }

  await exec(db, 'BEGIN IMMEDIATE');
  try {
    for (const row of legacy.floors || []) {
      await run(db,
        'INSERT INTO floors (id, floor_number, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [row.id, row.floor_number, row.name, valueOr(row, 'created_at', new Date().toISOString()), valueOr(row, 'updated_at', new Date().toISOString())]
      );
    }
    for (const row of legacy.racks || []) {
      await run(db,
        'INSERT INTO racks (id, floor_id, rack_code, row_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [row.id, row.floor_id, row.rack_code, row.row_count, valueOr(row, 'created_at', new Date().toISOString()), valueOr(row, 'updated_at', new Date().toISOString())]
      );
    }
    for (const row of legacy.rack_slots || []) {
      await run(db,
        'INSERT INTO rack_slots (id, rack_id, row_number, level_code, zone_type, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [row.id, row.rack_id, row.row_number, row.level_code, valueOr(row, 'zone_type', 'NORMAL'), valueOr(row, 'is_active', 1), valueOr(row, 'created_at', new Date().toISOString()), valueOr(row, 'updated_at', new Date().toISOString())]
      );
    }
    for (const row of legacy.product_variants || []) {
      await run(db,
        'INSERT INTO product_variants (id, name, size, packaging, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [row.id, valueOr(row, 'name', row.variant_name), valueOr(row, 'size', ''), valueOr(row, 'packaging', 'Box'), valueOr(row, 'created_at', new Date().toISOString()), valueOr(row, 'updated_at', new Date().toISOString())]
      );
    }
    for (const row of legacy.stock_batches || []) {
      await run(db,
        'INSERT INTO stock_batches (id, variant_id, batch_number, quantity_boxes, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [row.id, row.variant_id, row.batch_number, valueOr(row, 'quantity_boxes', row.quantity), valueOr(row, 'notes', ''), valueOr(row, 'created_at', new Date().toISOString()), valueOr(row, 'updated_at', new Date().toISOString())]
      );
    }
    for (const row of legacy.stock_locations || []) {
      await run(db,
        'INSERT INTO stock_locations (id, stock_batch_id, rack_slot_id, quantity_boxes, created_at) VALUES (?, ?, ?, ?, ?)',
        [row.id, row.stock_batch_id, row.rack_slot_id, row.quantity_boxes, valueOr(row, 'created_at', new Date().toISOString())]
      );
    }
    for (const row of legacy.profiles || []) {
      await run(db,
        'INSERT INTO profiles (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [row.id, valueOr(row, 'name', ''), valueOr(row, 'email', null), valueOr(row, 'created_at', new Date().toISOString()), valueOr(row, 'updated_at', new Date().toISOString())]
      );
    }
    for (const row of legacy.audit_logs || []) {
      await run(db,
        'INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [row.id, valueOr(row, 'actor_id', null), valueOr(row, 'action', ''), valueOr(row, 'entity_type', ''), valueOr(row, 'entity_id', null), typeof row.details === 'string' ? row.details : JSON.stringify(valueOr(row, 'details', {})), valueOr(row, 'created_at', new Date().toISOString())]
      );
    }
    await exec(db, 'COMMIT');
  } catch (error) {
    await exec(db, 'ROLLBACK');
    throw error;
  }
}

async function seedRackLayout(db) {
  const floorCount = await get(db, 'SELECT COUNT(*) AS count FROM floors');
  if (floorCount.count === 0) {
    for (const floorNumber of [1, 2]) {
      await run(db, 'INSERT INTO floors (id, floor_number, name) VALUES (?, ?, ?)', [
        crypto.randomUUID(), floorNumber, `Lantai ${floorNumber}`
      ]);
    }
  }

  const floors = await all(db, 'SELECT id, floor_number FROM floors ORDER BY floor_number');
  for (const floor of floors) {
    if (!rackDefinitions[floor.floor_number]) continue;
    const rackCount = await get(db, 'SELECT COUNT(*) AS count FROM racks WHERE floor_id = ?', [floor.id]);
    if (rackCount.count > 0) continue;

    for (const definition of rackDefinitions[floor.floor_number]) {
      const rackId = crypto.randomUUID();
      await run(db, 'INSERT INTO racks (id, floor_id, rack_code, row_count) VALUES (?, ?, ?, ?)', [
        rackId, floor.id, definition.code, definition.rows
      ]);
      for (let row = 1; row <= definition.rows; row++) {
        for (const level of definition.levels) {
          const isReject = floor.floor_number === 2 && definition.code === 'F'
            && row <= 4 && (level === 'A' || level === 'C');
          await run(db,
            'INSERT INTO rack_slots (id, rack_id, row_number, level_code, zone_type) VALUES (?, ?, ?, ?, ?)',
            [crypto.randomUUID(), rackId, row, level, isReject ? 'REJECT' : definition.zone]
          );
        }
      }
    }
  }
}

async function seedProductVariants(db) {
  const result = await get(db, 'SELECT COUNT(*) AS count FROM product_variants');
  if (result.count > 0) return;
  for (const variant of defaultVariants) {
    await run(db,
      'INSERT INTO product_variants (id, name, size, packaging) VALUES (?, ?, ?, ?)',
      [crypto.randomUUID(), variant.name, variant.size, variant.packaging]
    );
  }
}

async function seedLooseCabinets(db) {
  for (const cabinetCode of ['A', 'B', 'C']) {
    let cabinet = await get(db, 'SELECT id FROM loose_cabinets WHERE cabinet_code = ?', [cabinetCode]);
    if (!cabinet) {
      cabinet = { id: crypto.randomUUID() };
      await run(db, 'INSERT INTO loose_cabinets (id, floor_number, cabinet_code) VALUES (?, 1, ?)', [cabinet.id, cabinetCode]);
    }
    for (let slotNumber = 1; slotNumber <= 20; slotNumber += 1) {
      const existing = await get(db, 'SELECT id FROM loose_cabinet_slots WHERE cabinet_id = ? AND slot_number = ?', [cabinet.id, slotNumber]);
      if (!existing) {
        await run(db, 'INSERT INTO loose_cabinet_slots (id, cabinet_id, slot_number) VALUES (?, ?, ?)',
          [crypto.randomUUID(), cabinet.id, slotNumber]);
      }
    }
  }
}

async function initDatabase(dbPath = process.env.DATABASE_URL || './db/rack-management.db') {
  const resolvedPath = path.resolve(__dirname, '..', dbPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const legacy = readLegacyJson(resolvedPath);
  const db = await open(resolvedPath);

  try {
    await createSchema(db);
    if (legacy) await importLegacyRows(db, legacy);
    await seedRackLayout(db);
    await seedProductVariants(db);
    await seedLooseCabinets(db);
    await normalizePalletLocations(db);
    return db;
  } catch (error) {
    await close(db);
    throw error;
  }
}

module.exports = { all, close, defaultVariants, get, initDatabase, run };
