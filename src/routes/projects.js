'use strict';

const express = require('express');
const { query, pool } = require('../config/db');
const { ensureApiAuth } = require('../middleware/auth');
const { requireProjectMember, requireProjectOwner } = require('../middleware/projectAccess');
const { isUuid, uuidParam } = require('../middleware/validate');

const router = express.Router();

router.use(ensureApiAuth);
router.param('projectId', uuidParam);

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
// Upserts on (user_id, project_id), so it doubles as a role change. Demoting
// the project's last owner is refused (409) so a project can't be orphaned.
router.post('/:projectId/members', requireProjectOwner, async (req, res, next) => {
  let client;
  try {
    const { userId } = req.body;
    const role = req.body.role === 'owner' ? 'owner' : 'member';
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!isUuid(userId)) return res.status(400).json({ error: 'Invalid userId' });

    const { rows: userRows } = await query('SELECT id FROM users WHERE id = $1', [userId]);
    if (!userRows.length) return res.status(404).json({ error: 'User not found' });

    client = await pool.connect();
    await client.query('BEGIN');

    if (role === 'member') {
      // Lock the owner rows so two concurrent demotions can't both pass the check.
      const { rows: owners } = await client.query(
        `SELECT user_id FROM memberships
          WHERE project_id = $1 AND role = 'owner'
          FOR UPDATE`,
        [req.params.projectId]
      );
      const targetIsOwner = owners.some((o) => o.user_id === userId);
      if (targetIsOwner && owners.length <= 1) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'A project must keep at least one owner' });
      }
    }

    const { rows } = await client.query(
      `INSERT INTO memberships (user_id, project_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, project_id)
         DO UPDATE SET role = EXCLUDED.role
       RETURNING *`,
      [userId, req.params.projectId, role]
    );
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
