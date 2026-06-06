'use strict';

// Applies db/schema.sql to the database in DATABASE_URL.
// Run with:  npm run db:init
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { pool } = require('../src/config/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  console.log('Applying schema...');
  await pool.query(sql);
  console.log('Schema applied successfully.');
  await pool.end();
}

main().catch((err) => {
  console.error('Failed to apply schema:', err.message);
  process.exit(1);
});
