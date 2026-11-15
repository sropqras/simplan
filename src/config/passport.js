'use strict';

const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { query } = require('./db');

// Store only the user id in the session cookie; hydrate from DB on each request.
passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
    done(null, rows[0] || false);
  } catch (err) {
    done(err);
  }
});

// Google mode is optional (an Azure DevOps-only deployment has no Google creds).
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${process.env.BASE_URL}/auth/google/callback`,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const googleId = profile.id;
        const email = profile.emails && profile.emails[0] && profile.emails[0].value;
        const name = profile.displayName;
        const avatar = profile.photos && profile.photos[0] && profile.photos[0].value;

        if (!email) {
          return done(new Error('Google account did not return an email address.'));
        }

        // Upsert by google_id; keep email/name/avatar fresh on each login.
        const { rows } = await query(
          `INSERT INTO users (google_id, email, name, avatar_url, last_seen)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (google_id)
           DO UPDATE SET email = EXCLUDED.email,
                         name = EXCLUDED.name,
                         avatar_url = EXCLUDED.avatar_url,
                         last_seen = now()
           RETURNING *`,
          [googleId, email, name, avatar]
        );

        return done(null, rows[0]);
      } catch (err) {
        return done(err);
      }
    }
  )
);
}

module.exports = passport;
