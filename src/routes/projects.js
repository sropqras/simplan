'use strict';

const express = require('express');
const { query } = require('../config/db');
const { ensureApiAuth } = require('../middleware/auth');
const { requireProjectMember, requireProjectOwner } = require('../middleware/projectAccess');

const router = express.Router();

router.use(ensureApiAuth);

// List members of a project — any member can see the roster.
router.get('/:projectId/members', requireProjectMember, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT m.id AS membership_id,
              m.role,
              m.created_at,
              u.id AS user_id,
              u.email,
              u.name,
              u.avatar_url
         FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.project_id = $1
        ORDER BY m.created_at ASC`,
      [req.params.projectId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Add a member — owner-only. Body: { userId, role }.
router.post('/:projectId/members', requireProjectOwner, async (req, res, next) => {
  try {
    const { userId } = req.body;
    const role = req.body.role === 'owner' ? 'owner' : 'member';
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const { rows: userRows } = await query('SELECT id FROM users WHERE id = $1', [userId]);
    if (!userRows.length) return res.status(404).json({ error: 'User not found' });

    const { rows } = await query(
      `INSERT INTO memberships (user_id, project_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, project_id)
         DO UPDATE SET role = EXCLUDED.role
       RETURNING *`,
      [userId, req.params.projectId, role]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
