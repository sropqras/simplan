'use strict';

// Gate for HTML routes: redirect to the login page if not signed in.
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.redirect('/');
}

// Gate for API/JSON routes: return 401 instead of redirecting.
function ensureApiAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

module.exports = { ensureAuthenticated, ensureApiAuth };
