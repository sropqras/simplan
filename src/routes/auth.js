'use strict';

const express = require('express');
const passport = require('../config/passport');

const router = express.Router();

// Google mode may be disabled (Azure DevOps-only deployment).
router.use('/google', (req, res, next) => {
  if (passport._strategy('google')) return next();
  return res.status(503).type('text').send('Google sign-in is not configured on this server.');
});

// Kick off Google OAuth.
router.get(
  '/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

// Google redirects back here after consent.
router.get(
  '/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth' }),
  (req, res) => res.redirect('/dashboard')
);

// Log out and destroy the session.
router.post('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.redirect('/');
    });
  });
});

module.exports = router;
