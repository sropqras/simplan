'use strict';

const express = require('express');
const path = require('path');
const { ensureAuthenticated, ensureApiAuth } = require('../middleware/auth');
const { query } = require('../config/db');

const router = express.Router();
const VIEWS = path.join(__dirname, '..', '..', 'views');

// Landing / login page. If already signed in, go straight to the dashboard.
router.get('/', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) return res.redirect('/dashboard');
  res.sendFile(path.join(VIEWS, 'login.html'));
});

// Protected dashboard shell (real Kanban + chat arrive in later phases).
router.get('/dashboard', ensureAuthenticated, (req, res) => {
  res.sendFile(path.join(VIEWS, 'dashboard.html'));
});

// Returns the signed-in user — used by the dashboard to render the header.
router.get('/api/me', ensureApiAuth, (req, res) => {
  const { id, email, name, avatar_url } = req.user;
  res.json({ id, email, name, avatar_url });
});

// Minimal user directory for the "add member" picker. Returns only the fields
// the picker needs; supports a ?q= prefix search on name/email.
router.get('/api/users', ensureApiAuth, async (req, res, next) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const params = [];
    let where = '';
    if (q) {
      params.push(`%${q}%`);
      where = 'WHERE name ILIKE $1 OR email ILIKE $1';
    }
    const { rows } = await query(
      `SELECT id, email, name, avatar_url FROM users ${where} ORDER BY name NULLS LAST, email LIMIT 50`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
