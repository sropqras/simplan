'use strict';

const { query } = require('../config/db');

// Looks up the caller's membership on req.params.projectId. On success, attaches
// req.membership = { projectId, role }. Use this to gate any project-scoped read.
async function requireProjectMember(req, res, next) {
  try {
    const { projectId } = req.params;
    if (!projectId) return res.status(400).json({ error: 'Missing projectId' });

    const { rows } = await query(
      `SELECT m.role
         FROM memberships m
         JOIN projects p ON p.id = m.project_id
        WHERE m.project_id = $1 AND m.user_id = $2`,
      [projectId, req.user.id]
    );

    if (!rows.length) return res.status(403).json({ error: 'Not a project member' });

    req.membership = { projectId, role: rows[0].role };
    return next();
  } catch (err) {
    return next(err);
  }
}

// Same as requireProjectMember but the membership role must be 'owner'.
async function requireProjectOwner(req, res, next) {
  try {
    const { projectId } = req.params;
    if (!projectId) return res.status(400).json({ error: 'Missing projectId' });

    const { rows } = await query(
      'SELECT role FROM memberships WHERE project_id = $1 AND user_id = $2',
      [projectId, req.user.id]
    );

    if (!rows.length || rows[0].role !== 'owner') {
      return res.status(403).json({ error: 'Owner role required' });
    }

    req.membership = { projectId, role: 'owner' };
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireProjectMember, requireProjectOwner };
