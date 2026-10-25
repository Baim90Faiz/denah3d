const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const { all, close, defaultVariants, get, initDatabase, run } = require('./db/init');

const variantSchema = z.object({
  name: z.string().trim().min(1).max(120),
  size: z.string().trim().max(40).default(''),
  packaging: z.string().trim().min(1).max(40).default('Box')
});

const batchSchema = z.object({
  variantId: z.string().uuid(),
  rackSlotId: z.string().uuid(),
  batchNumber: z.string().trim().min(1).max(100),
  quantityBoxes: z.number().int().positive(),
  productionDate: z.string().date().optional(),
  notes: z.string().trim().max(2000).default('')
});

function isValidBatchNumber(batchNumber, variantName) {
  const suffix = /mouth\s*wash|mouthwash/i.test(variantName || '') ? '[A-Za-z0-9]{3}' : '[0-9]{3}';
  return new RegExp(`^(0[1-9]|1[0-2])[0-9]{2}${suffix}$`).test(batchNumber);
}

const opnameSchema = z.object({
  slots: z.array(z.object({
    slotId: z.string().uuid(),
    variantId: z.string().uuid().nullable(),
    quantityPieces: z.number().int().min(0).max(1000000)
  })).length(60)
}).refine(data => data.slots.every(slot => slot.quantityPieces === 0 || slot.variantId), {
  message: 'Pilih variant untuk setiap slot yang memiliki jumlah pcs.',
  path: ['slots']
});

function queryOpnameSlots(db) {
  return all(db, `
    SELECT c.id AS cabinet_id, c.cabinet_code, s.id AS slot_id, s.slot_number,
      s.variant_id, s.quantity_pieces, v.name AS variant_name, v.size
    FROM loose_cabinets c
    JOIN loose_cabinet_slots s ON s.cabinet_id = c.id
    LEFT JOIN product_variants v ON v.id = s.variant_id
    ORDER BY c.cabinet_code, s.slot_number
  `);
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function validationError(res, error) {
  return res.status(400).json({
    error: 'Input tidak valid.',
    details: error.issues.map(issue => ({
      field: issue.path.join('.'),
      message: issue.message
    }))
  });
}

function createApp(db) {
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.options('*', cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '32kb' }));

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/dashboard', asyncRoute(async (req, res) => {
    const [floors, racks, variants, batches, zones, opnameSlots] = await Promise.all([
      all(db, 'SELECT id, floor_number, name FROM floors ORDER BY floor_number'),
      all(db, `
        SELECT r.id, r.floor_id, r.rack_code, r.row_count,
          COUNT(DISTINCT s.id) AS slot_count,
          COUNT(DISTINCT CASE WHEN l.rack_slot_id IS NOT NULL THEN s.id END) AS occupied_slot_count,
          GROUP_CONCAT(DISTINCT s.level_code) AS levels
        FROM racks r
        LEFT JOIN rack_slots s ON s.rack_id = r.id AND s.is_active = 1
        LEFT JOIN stock_locations l ON l.rack_slot_id = s.id AND l.quantity_boxes > 0
        GROUP BY r.id
        ORDER BY r.rack_code
      `),
      all(db, `
        SELECT v.id, v.name, v.size, v.packaging,
          COUNT(b.id) AS batch_count, COALESCE(SUM(b.quantity_boxes), 0) AS total_boxes
        FROM product_variants v
        LEFT JOIN stock_batches b ON b.variant_id = v.id
        GROUP BY v.id
        ORDER BY v.name COLLATE NOCASE
      `),
      all(db, `
          SELECT b.id, b.batch_number, b.quantity_boxes, b.notes, b.production_date, b.expiry_date, b.created_at,
          v.id AS variant_id, v.name AS variant_name, v.size, v.packaging,
          l.rack_slot_id, r.id AS rack_id,
          GROUP_CONCAT(DISTINCT 'L' || f.floor_number || '-' || r.rack_code || s.row_number || s.level_code) AS location_labels
        FROM stock_batches b
        JOIN product_variants v ON v.id = b.variant_id
        LEFT JOIN stock_locations l ON l.stock_batch_id = b.id
        LEFT JOIN rack_slots s ON s.id = l.rack_slot_id
        LEFT JOIN racks r ON r.id = s.rack_id
        LEFT JOIN floors f ON f.id = r.floor_id
        GROUP BY b.id
        ORDER BY b.created_at DESC, b.batch_number
      `),
      all(db, 'SELECT zone_type, COUNT(*) AS slot_count FROM rack_slots WHERE is_active = 1 GROUP BY zone_type'),
      queryOpnameSlots(db)
    ]);

    const cabinetCapacity = opnameSlots.length;
    const occupiedCabinetSlots = opnameSlots.filter(slot => Number(slot.quantity_pieces) > 0).length;

    const racksByFloor = new Map();
    for (const rack of racks) {
      const levels = rack.levels ? rack.levels.split(',').sort() : [];
      const formattedRack = {
        ...rack,
        slot_count: Number(rack.slot_count),
        occupied_slot_count: Number(rack.occupied_slot_count),
        levels
      };
      delete formattedRack.floor_id;
      delete formattedRack.levels;
      formattedRack.level_codes = levels;
      if (!racksByFloor.has(rack.floor_id)) racksByFloor.set(rack.floor_id, []);
      racksByFloor.get(rack.floor_id).push(formattedRack);
    }

    const formattedFloors = floors.map(floor => ({
        ...floor,
        racks: racksByFloor.get(floor.id) || []
      }));
    const floorOccupancy = formattedFloors.map(floor => {
      const isFloorOne = Number(floor.floor_number) === 1;
      const totalSlots = floor.racks.reduce((sum, rack) => sum + rack.slot_count, 0) + (isFloorOne ? cabinetCapacity : 0);
      const occupiedSlots = floor.racks.reduce((sum, rack) => sum + rack.occupied_slot_count, 0) + (isFloorOne ? occupiedCabinetSlots : 0);
      return {
        floor_number: floor.floor_number,
        total_slots: totalSlots,
        occupied_slots: occupiedSlots,
        empty_slots: totalSlots - occupiedSlots,
        occupancy_percent: totalSlots ? Math.round(occupiedSlots / totalSlots * 100) : 0
      };
    });
    const totalSlots = floorOccupancy.reduce((sum, floor) => sum + floor.total_slots, 0);
    const occupiedSlots = floorOccupancy.reduce((sum, floor) => sum + floor.occupied_slots, 0);

    res.json({
      floors: formattedFloors,
      occupancy: {
        total_slots: totalSlots,
        occupied_slots: occupiedSlots,
        empty_slots: totalSlots - occupiedSlots,
        occupancy_percent: totalSlots ? Math.round(occupiedSlots / totalSlots * 100) : 0,
        floors: floorOccupancy
      },
      variants,
      batches,
      opname_slots: opnameSlots,
      zones: Object.fromEntries(zones.map(zone => [zone.zone_type, Number(zone.slot_count)]))
    });
  }));

  app.put('/api/opname', asyncRoute(async (req, res) => {
    const parsed = opnameSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const slots = parsed.data.slots;
    if (new Set(slots.map(slot => slot.slotId)).size !== 60) {
      return res.status(400).json({ error: 'Setiap 60 slot lemari harus dikirim tepat satu kali.' });
    }
    const validSlots = await all(db, 'SELECT id FROM loose_cabinet_slots');
    const validSlotIds = new Set(validSlots.map(slot => slot.id));
    if (validSlots.length !== 60 || slots.some(slot => !validSlotIds.has(slot.slotId))) {
      return res.status(400).json({ error: 'Daftar slot lemari tidak valid.' });
    }
    const requestedVariantIds = [...new Set(slots.map(slot => slot.variantId).filter(Boolean))];
    const validVariants = requestedVariantIds.length
      ? await all(db, `SELECT id FROM product_variants WHERE id IN (${requestedVariantIds.map(() => '?').join(',')})`, requestedVariantIds)
      : [];
    if (validVariants.length !== requestedVariantIds.length) {
      return res.status(400).json({ error: 'Variant opname tidak ditemukan.' });
    }
    let transactionStarted = false;
    try {
      await run(db, 'BEGIN IMMEDIATE');
      transactionStarted = true;
      for (const slot of slots) {
        await run(db, `UPDATE loose_cabinet_slots
          SET variant_id = ?, quantity_pieces = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [slot.quantityPieces === 0 ? null : slot.variantId, slot.quantityPieces, slot.slotId]);
      }
      await run(db, 'COMMIT');
      transactionStarted = false;
      res.json({ success: true, updated_slots: slots.length });
    } catch (error) {
      if (transactionStarted) {
        try { await run(db, 'ROLLBACK'); } catch (rollbackError) { console.error('Gagal membatalkan penyimpanan opname:', rollbackError); }
      }
      throw error;
    }
  }));

  app.get('/api/product-variants', asyncRoute(async (req, res) => {
    const variants = await all(db, `
      SELECT v.id, v.name, v.size, v.packaging,
        COUNT(b.id) AS batch_count, COALESCE(SUM(b.quantity_boxes), 0) AS total_boxes
      FROM product_variants v
      LEFT JOIN stock_batches b ON b.variant_id = v.id
      GROUP BY v.id
      ORDER BY v.name COLLATE NOCASE
    `);
    res.json({ variants });
  }));

  app.post('/api/product-variants', asyncRoute(async (req, res) => {
    const parsed = variantSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);

    const variant = parsed.data;
    const id = crypto.randomUUID();
    try {
      await run(db,
        'INSERT INTO product_variants (id, name, size, packaging) VALUES (?, ?, ?, ?)',
        [id, variant.name, variant.size, variant.packaging]
      );
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT' && /product_variants\.name/i.test(error.message)) {
        return res.status(409).json({ error: 'Variant dengan nama tersebut sudah ada.' });
      }
      throw error;
    }

    res.status(201).json({
      variant: { id, ...variant, batch_count: 0, total_boxes: 0 }
    });
  }));

  app.get('/api/stock-batches', asyncRoute(async (req, res) => {
    const batches = await all(db, `
      SELECT b.id, b.batch_number, b.quantity_boxes, b.notes, b.production_date, b.expiry_date, b.created_at,
        v.id AS variant_id, v.name AS variant_name, v.size, v.packaging,
        GROUP_CONCAT(DISTINCT 'L' || f.floor_number || '-' || r.rack_code || s.row_number || s.level_code) AS location_labels
      FROM stock_batches b
      JOIN product_variants v ON v.id = b.variant_id
      LEFT JOIN stock_locations l ON l.stock_batch_id = b.id
      LEFT JOIN rack_slots s ON s.id = l.rack_slot_id
      LEFT JOIN racks r ON r.id = s.rack_id
      LEFT JOIN floors f ON f.id = r.floor_id
      GROUP BY b.id
      ORDER BY b.created_at DESC, b.batch_number
    `);
    res.json({ batches });
  }));

  app.get('/api/racks/:rackId/slots', asyncRoute(async (req, res) => {
    const rack = await get(db, `
      SELECT r.id, r.rack_code, r.row_count, f.floor_number
      FROM racks r JOIN floors f ON f.id = r.floor_id
      WHERE r.id = ?
    `, [req.params.rackId]);
    if (!rack) return res.status(404).json({ error: 'Rak tidak ditemukan.' });

    const slots = await all(db, `
      SELECT s.id, s.row_number, s.level_code, s.zone_type,
        COALESCE(SUM(l.quantity_boxes), 0) AS occupied_boxes,
        GROUP_CONCAT(DISTINCT v.name) AS occupied_variant_names
      FROM rack_slots s
      LEFT JOIN stock_locations l ON l.rack_slot_id = s.id
      LEFT JOIN stock_batches b ON b.id = l.stock_batch_id
      LEFT JOIN product_variants v ON v.id = b.variant_id
      WHERE s.rack_id = ? AND s.is_active = 1
      GROUP BY s.id
      ORDER BY s.row_number, s.level_code
    `, [rack.id]);
    res.json({ rack, slots: slots.map(slot => ({ ...slot, occupied_boxes: Number(slot.occupied_boxes), occupied_variant_names: slot.occupied_variant_names ? slot.occupied_variant_names.split(',') : [] })) });
  }));

  app.post('/api/demo/reset', asyncRoute(async (req, res) => {
    let transactionStarted = false;
    try {
      await run(db, 'BEGIN IMMEDIATE');
      transactionStarted = true;
      const deleted = await run(db, "DELETE FROM stock_batches WHERE notes LIKE 'DATA DUMMY%'");
      const retiredNames = [
        'Pasta Gigi Enzim Original', 'Kids Strawberry', 'Herbal Mint', 'Charcoal Black',
        'Sensitive Care', 'Pasta Gigi Enzim Anak Strawberry 63', 'Freshmint 124 gr',
        'Karantina Dummy', 'Reject Dummy'
      ];
      for (const name of retiredNames) {
        await run(db, `DELETE FROM product_variants
          WHERE name = ? AND NOT EXISTS (SELECT 1 FROM stock_batches WHERE variant_id = product_variants.id)`, [name]);
      }
      for (const variant of defaultVariants) {
        const existing = await get(db, 'SELECT id FROM product_variants WHERE name = ?', [variant.name]);
        if (existing) {
          await run(db, 'UPDATE product_variants SET size = ?, packaging = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [variant.size, variant.packaging, existing.id]);
        } else {
          await run(db, 'INSERT INTO product_variants (id, name, size, packaging) VALUES (?, ?, ?, ?)',
            [crypto.randomUUID(), variant.name, variant.size, variant.packaging]);
        }
      }
      await run(db, 'COMMIT');
      transactionStarted = false;
      res.json({ deleted_batches: deleted.changes, variants: defaultVariants.length });
    } catch (error) {
      if (transactionStarted) {
        try { await run(db, 'ROLLBACK'); } catch (rollbackError) { console.error('Gagal membatalkan reset data dummy:', rollbackError); }
      }
      throw error;
    }
  }));

  app.post('/api/demo/fill-warehouse', asyncRoute(async (req, res) => {
    let transactionStarted = false;
    try {
      await run(db, 'BEGIN IMMEDIATE');
      transactionStarted = true;
      const slots = await all(db, `
        SELECT s.id, s.zone_type, f.floor_number, r.rack_code, s.row_number, s.level_code,
          CASE WHEN EXISTS (
            SELECT 1 FROM stock_locations l WHERE l.rack_slot_id = s.id AND l.quantity_boxes > 0
          ) THEN 1 ELSE 0 END AS is_occupied
        FROM rack_slots s
        JOIN racks r ON r.id = s.rack_id
        JOIN floors f ON f.id = r.floor_id
        WHERE s.is_active = 1
        ORDER BY f.floor_number, s.zone_type, r.rack_code, s.row_number, s.level_code
      `);
      const freeSlots = slots.filter(slot => !Number(slot.is_occupied));
      const floorTotals = new Map();
      for (const slot of slots) {
        const number = Number(slot.floor_number);
        const floor = floorTotals.get(number) || { total: 0, occupied: 0 };
        floor.total += 1;
        if (Number(slot.is_occupied)) floor.occupied += 1;
        floorTotals.set(number, floor);
      }

      const normalVariants = [];
      for (const item of defaultVariants) {
        let variant = await get(db, 'SELECT id, name, size FROM product_variants WHERE name = ?', [item.name]);
        if (!variant) {
          const id = crypto.randomUUID();
          await run(db, 'INSERT INTO product_variants (id, name, size, packaging) VALUES (?, ?, ?, ?)',
            [id, item.name, item.size, item.packaging]);
          variant = { id, name: item.name, size: item.size };
        }
        normalVariants.push(variant);
      }
      const quarantineVariant = normalVariants[0];
      const rejectVariant = normalVariants[normalVariants.length - 1];

      const now = new Date();
      const month = String(now.getUTCMonth() + 1).padStart(2, '0');
      const year = String(now.getUTCFullYear() % 100).padStart(2, '0');
      const prefix = `${month}${year}`;
      const productionDate = `${now.getUTCFullYear()}-${month}-01`;
      const expiryDate = `${now.getUTCFullYear() + 3}-${month}-01`;
      const usedBatchNumbers = new Set((await all(db, 'SELECT batch_number FROM stock_batches'))
        .map(batch => batch.batch_number.toUpperCase()));
      let nextBatchNumber = 1;
      let normalVariantIndex = 0;
      let createdBatches = 0;
      let createdPallets = 0;
      const slotGroups = new Map();
      for (const slot of freeSlots) {
        const groupKey = `${slot.floor_number}:${slot.zone_type}`;
        if (!slotGroups.has(groupKey)) slotGroups.set(groupKey, []);
        slotGroups.get(groupKey).push(slot);
      }

      for (const [groupKey, groupSlots] of slotGroups) {
        const zoneType = groupKey.split(':')[1];
        for (let start = 0; start < groupSlots.length; start += 3) {
          const palletSlots = groupSlots.slice(start, start + 3);
          const variant = zoneType === 'REJECT'
            ? rejectVariant
            : zoneType === 'QUARANTINE'
              ? quarantineVariant
              : normalVariants[normalVariantIndex++ % normalVariants.length];
          let batchNumber;
          do {
            if (nextBatchNumber > 999) throw new Error('Nomor batch bulan ini sudah mencapai batas 999.');
            batchNumber = `${prefix}${String(nextBatchNumber++).padStart(3, '0')}`;
          } while (usedBatchNumbers.has(batchNumber));
          usedBatchNumbers.add(batchNumber);

          for (let index = 0; index < palletSlots.length; index += 1) {
            const quantity = index < palletSlots.length - 1 ? 100 : 91;
            const batchId = crypto.randomUUID();
            await run(db, `
              INSERT INTO stock_batches (id, variant_id, batch_number, quantity_boxes, notes, production_date, expiry_date)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [batchId, variant.id, batchNumber, quantity, 'DATA DUMMY — pallet dari batch yang sama', productionDate, expiryDate]);
            await run(db, `
              INSERT INTO stock_locations (id, stock_batch_id, rack_slot_id, quantity_boxes)
              VALUES (?, ?, ?, ?)
            `, [crypto.randomUUID(), batchId, palletSlots[index].id, quantity]);
            createdBatches += 1;
          }
          createdPallets += palletSlots.length;
        }
      }
      await run(db, 'COMMIT');
      transactionStarted = false;
      res.json({
        created_batches: createdBatches,
        created_pallets: createdPallets,
        total_slots: slots.length,
        occupied_slots: slots.length,
        floors: [...floorTotals.entries()].map(([floorNumber, floor]) => ({
          floor_number: floorNumber,
          total_slots: floor.total,
          occupied_slots: floor.total,
          occupancy_percent: 100
        }))
      });
    } catch (error) {
      if (transactionStarted) {
        try { await run(db, 'ROLLBACK'); } catch (rollbackError) { console.error('Gagal membatalkan data dummy:', rollbackError); }
      }
      throw error;
    }
  }));

  app.post('/api/stock-batches', asyncRoute(async (req, res) => {
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);

    const batch = parsed.data;
    const batchDate = batch.batchNumber.match(/^(0[1-9]|1[0-2])(\d{2})[A-Z0-9]{3}$/i);
    const productionDate = batchDate
      ? `20${batchDate[2]}-${batchDate[1]}-01`
      : batch.productionDate || new Date().toISOString().slice(0, 10);
    const [productionYear, productionMonth, productionDay] = productionDate.split('-').map(Number);
    const productionExpiry = new Date(Date.UTC(productionYear + 3, productionMonth - 1, productionDay));
    if (productionExpiry.getUTCMonth() !== productionMonth - 1) productionExpiry.setUTCDate(0);
    const expiryDate = productionExpiry.toISOString().slice(0, 10);
    const [variant, slot] = await Promise.all([
      get(db, 'SELECT id, name FROM product_variants WHERE id = ?', [batch.variantId]),
      get(db, 'SELECT id FROM rack_slots WHERE id = ? AND is_active = 1', [batch.rackSlotId])
    ]);
    if (!variant) return res.status(404).json({ error: 'Variant produk tidak ditemukan.' });
    if (!isValidBatchNumber(batch.batchNumber, variant.name)) {
      return res.status(400).json({ error: /mouth\s*wash|mouthwash/i.test(variant.name)
        ? 'Nomor batch Mouthwash harus berformat MMYY diikuti 3 huruf/angka.'
        : 'Nomor batch harus 7 digit dengan format MMYYxxx.' });
    }
    if (!slot) return res.status(404).json({ error: 'Lokasi rak tidak ditemukan atau tidak aktif.' });

    const id = crypto.randomUUID();
    let transactionStarted = false;
    try {
      await run(db, 'BEGIN IMMEDIATE');
      transactionStarted = true;
      const otherVariant = await get(db, `
        SELECT v.name FROM stock_locations l
        JOIN stock_batches b ON b.id = l.stock_batch_id
        JOIN product_variants v ON v.id = b.variant_id
        WHERE l.rack_slot_id = ? AND l.quantity_boxes > 0 AND b.variant_id <> ?
        LIMIT 1
      `, [batch.rackSlotId, batch.variantId]);
      if (otherVariant) {
        await run(db, 'ROLLBACK');
        transactionStarted = false;
        return res.status(409).json({ error: `Slot ini sudah berisi variant ${otherVariant.name}. Pilih slot kosong atau slot dengan variant yang sama.` });
      }
      await run(db, `
        INSERT INTO stock_batches (id, variant_id, batch_number, quantity_boxes, notes, production_date, expiry_date)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [id, batch.variantId, batch.batchNumber, batch.quantityBoxes, batch.notes, productionDate, expiryDate]);
      await run(db, `
        INSERT INTO stock_locations (id, stock_batch_id, rack_slot_id, quantity_boxes)
        VALUES (?, ?, ?, ?)
      `, [crypto.randomUUID(), id, batch.rackSlotId, batch.quantityBoxes]);
      await run(db, 'COMMIT');
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          await run(db, 'ROLLBACK');
        } catch (rollbackError) {
          console.error('Gagal membatalkan penyimpanan batch:', rollbackError);
        }
      }
      throw error;
    }

    const created = await get(db, `
      SELECT b.id, b.batch_number, b.quantity_boxes, b.notes, b.production_date, b.expiry_date, b.created_at,
        v.id AS variant_id, v.name AS variant_name, v.size, v.packaging,
        f.floor_number, r.rack_code, s.row_number, s.level_code, s.zone_type
      FROM stock_batches b
      JOIN product_variants v ON v.id = b.variant_id
      JOIN stock_locations l ON l.stock_batch_id = b.id
      JOIN rack_slots s ON s.id = l.rack_slot_id
      JOIN racks r ON r.id = s.rack_id
      JOIN floors f ON f.id = r.floor_id
      WHERE b.id = ?
    `, [id]);
    res.status(201).json({ batch: created });
  }));

  app.put('/api/stock-batches/:id', asyncRoute(async (req, res) => {
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const batch = parsed.data;
    const existing = await get(db, 'SELECT id FROM stock_batches WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Batch tidak ditemukan.' });
    const [variant, slot] = await Promise.all([
      get(db, 'SELECT id, name FROM product_variants WHERE id = ?', [batch.variantId]),
      get(db, 'SELECT id FROM rack_slots WHERE id = ? AND is_active = 1', [batch.rackSlotId])
    ]);
    if (!variant) return res.status(404).json({ error: 'Variant produk tidak ditemukan.' });
    if (!isValidBatchNumber(batch.batchNumber, variant.name)) {
      return res.status(400).json({ error: /mouth\s*wash|mouthwash/i.test(variant.name)
        ? 'Nomor batch Mouthwash harus berformat MMYY diikuti 3 huruf/angka.'
        : 'Nomor batch harus 7 digit dengan format MMYYxxx.' });
    }
    if (!slot) return res.status(404).json({ error: 'Lokasi rak tidak ditemukan atau tidak aktif.' });

    const batchDate = batch.batchNumber.match(/^(0[1-9]|1[0-2])(\d{2})[A-Z0-9]{3}$/i);
    const productionDate = batchDate
      ? `20${batchDate[2]}-${batchDate[1]}-01`
      : batch.productionDate || new Date().toISOString().slice(0, 10);
    const [year, month, day] = productionDate.split('-').map(Number);
    const expiry = new Date(Date.UTC(year + 3, month - 1, day));
    if (expiry.getUTCMonth() !== month - 1) expiry.setUTCDate(0);
    const expiryDate = expiry.toISOString().slice(0, 10);
    let transactionStarted = false;
    try {
      await run(db, 'BEGIN IMMEDIATE');
      transactionStarted = true;
      const otherVariant = await get(db, `
        SELECT v.name FROM stock_locations l
        JOIN stock_batches b ON b.id = l.stock_batch_id
        JOIN product_variants v ON v.id = b.variant_id
        WHERE l.quantity_boxes > 0 AND b.id <> ? AND b.variant_id <> ?
          AND (l.rack_slot_id = ? OR l.rack_slot_id IN (
            SELECT rack_slot_id FROM stock_locations WHERE stock_batch_id = ?
          ))
        LIMIT 1
      `, [req.params.id, batch.variantId, batch.rackSlotId, req.params.id]);
      if (otherVariant) {
        await run(db, 'ROLLBACK');
        transactionStarted = false;
        return res.status(409).json({ error: `Slot ini sudah berisi variant ${otherVariant.name}. Pilih slot kosong atau slot dengan variant yang sama.` });
      }
      await run(db, `UPDATE stock_batches SET variant_id = ?, batch_number = ?, quantity_boxes = ?, notes = ?,
        production_date = ?, expiry_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [batch.variantId, batch.batchNumber, batch.quantityBoxes, batch.notes, productionDate, expiryDate, req.params.id]);
      await run(db, 'UPDATE stock_locations SET rack_slot_id = ?, quantity_boxes = ? WHERE stock_batch_id = ?',
        [batch.rackSlotId, batch.quantityBoxes, req.params.id]);
      await run(db, 'COMMIT');
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) await run(db, 'ROLLBACK');
      throw error;
    }
    res.json({ success: true });
  }));

  app.delete('/api/stock-batches/:id', asyncRoute(async (req, res) => {
    const result = await run(db, 'DELETE FROM stock_batches WHERE id = ?', [req.params.id]);
    if (!result.changes) return res.status(404).json({ error: 'Batch tidak ditemukan.' });
    res.json({ success: true });
  }));

  app.get('/', (req, res) => {
    res.sendFile(path.resolve(__dirname, '..', 'index.html'));
  });

  app.use('/public', express.static(path.resolve(__dirname, '..', 'public')));

  app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint tidak ditemukan.' });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
      return res.status(400).json({ error: 'Body JSON tidak valid.' });
    }
    console.error('Request gagal:', error);
    res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
  });

  return app;
}

async function start() {
  const db = await initDatabase();
  const app = createApp(db);
  const port = Number(process.env.PORT || 3001);
  const server = app.listen(port);
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (error) {
    await close(db);
    throw error;
  }
  console.log(`Rack Management berjalan di http://localhost:${port}`);

  const shutdown = () => {
    server.close(async error => {
      if (error) {
        console.error('Gagal menghentikan server:', error);
        process.exitCode = 1;
      }
      try {
        await close(db);
      } catch (closeError) {
        console.error('Gagal menutup database:', closeError);
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { app, db, server };
}

if (require.main === module) {
  start().catch(error => {
    console.error('Server gagal dijalankan:', error);
    process.exitCode = 1;
  });
}

module.exports = { createApp, start };
