require('dotenv').config();

const { all, close, initDatabase } = require('./init');

async function seed() {
  const db = await initDatabase();
  try {
    const [floors, racks, slots, zones, variants] = await Promise.all([
      all(db, 'SELECT floor_number, COUNT(*) AS rack_count FROM racks JOIN floors ON floors.id = racks.floor_id GROUP BY floor_number ORDER BY floor_number'),
      all(db, 'SELECT COUNT(*) AS count FROM racks'),
      all(db, 'SELECT COUNT(*) AS count FROM rack_slots'),
      all(db, 'SELECT zone_type, COUNT(*) AS count FROM rack_slots GROUP BY zone_type'),
      all(db, 'SELECT COUNT(*) AS count FROM product_variants')
    ]);
    console.log('Seed database siap.');
    console.log(JSON.stringify({ floors, racks: racks[0].count, slots: slots[0].count, zones, variants: variants[0].count }, null, 2));
  } finally {
    await close(db);
  }
}

seed().catch(error => {
  console.error('Seed gagal:', error);
  process.exitCode = 1;
});
