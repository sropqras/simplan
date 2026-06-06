'use strict';

const { Pool } = require('pg');

// A single shared pool for the whole app.
// Configured entirely via DATABASE_URL (see .env.example).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Enable SSL if your Postgres requires it (often the case on managed/remote DBs).
  // For a self-hosted VPS Postgres on the same machine you can usually leave this off.
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected Postgres pool error:', err);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
