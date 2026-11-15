'use strict';

const express = require('express');
const { query, pool } = require('../config/db');
const { ensureApiAuth } = require('../middleware/auth');
const { uuidParam } = require('../middleware/validate');

const router = express.Router();

// All event/project routes require a signed-in user.
router.use(ensureApiAuth);
router.param('eventId', uuidParam);

// A user can see an event if they created it OR they are a member of any
// project inside it. Returns the event row, or null if hidden / absent.
async function loadAccessibleEvent(eventId, userId) {
  const { rows } = await query(
    `SELECT e.*
       FROM events e
      WHERE e.id = $1
        AND (
          e.created_by = $2
          OR EXISTS (
            SELECT 1 FROM memberships m
              JOIN projects p ON p.id = m.project_id
             WHERE p.event_id = e.id AND m.user_id = $2
          )
        )`,
    [eventId, userId]
  );
  return rows[0] || null;
}

// ---------- Events ----------

router.post('/', async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    const description = req.body.description ? String(req.body.description) : null;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const { rows } = await query(
      `INSERT INTO events (name, description, created_by)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, description, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT DISTINCT e.*
         FROM events e
         LEFT JOIN projects p ON p.event_id = e.id
         LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1
        WHERE e.created_by = $1 OR m.user_id = $1
        ORDER BY e.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ---------- Projects under an event ----------

router.post('/:eventId/projects', async (req, res, next) => {
  let client;
  try {
    const event = await loadAccessibleEvent(req.params.eventId, req.user.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const name = (req.body.name || '').trim();
    const description = req.body.description ? String(req.body.description) : null;
    if (!name) return res.status(400).json({ error: 'name is required' });

    // Project + auto-owner membership must land together.
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows: projectRows } = await client.query(
      `INSERT INTO projects (event_id, name, description, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [event.id, name, description, req.user.id]
    );
    const project = projectRows[0];
    await client.query(
      `INSERT INTO memberships (user_id, project_id, role)
       VALUES ($1, $2, 'owner')`,
      [req.user.id, project.id]
    );
    await client.query('COMMIT');

    res.status(201).json(project);
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    if (client) client.release();
  }
});

router.get('/:eventId/projects', async (req, res, next) => {
  try {
    const event = await loadAccessibleEvent(req.params.eventId, req.user.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // Show every project in the event that the caller is a member of.
    // Event creators also see projects they created themselves but never joined,
    // so they don't get orphaned out of their own event.
    const { rows } = await query(
      `SELECT p.*,
              m.role AS my_role
         FROM projects p
         LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $2
        WHERE p.event_id = $1
          AND (m.user_id = $2 OR p.created_by = $2)
        ORDER BY p.created_at ASC`,
      [event.id, req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
