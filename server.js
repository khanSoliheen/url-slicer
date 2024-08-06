const express = require('express');
const session = require('express-session');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const nodemailer = require('nodemailer');
const shortid = require('shortid');
const expressLayouts = require('express-ejs-layouts');
const dotenv = require('dotenv');
const crypto = require('crypto');
const axios = require('axios');
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Database setup
const db = new sqlite3.Database('./database.sqlite', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);

// Enable foreign key support
db.run('PRAGMA foreign_keys = ON');

// Create users table if not exists
db.run(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  password TEXT,
  verified BOOLEAN,
  verification_token TEXT
)`);

// Create urls table if not exists
db.run(`CREATE TABLE IF NOT EXISTS urls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  original_url TEXT,
  short_code TEXT UNIQUE,
  custom_alias TEXT UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  max_uses INTEGER,
  auto_delete_at DATETIME,
  whitelist_mode BOOLEAN,
  allowed_countries TEXT,
  blocked_countries TEXT,
  FOREIGN KEY (user_id) REFERENCES users (id)
)`);

// Create clicks table if not exists
db.run(`CREATE TABLE IF NOT EXISTS clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url_id INTEGER,
  clicked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  country TEXT,
  FOREIGN KEY (url_id) REFERENCES urls (id)
)`);

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// Logging function
function log(message, data = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), message, ...data }));
}

// Passport configuration
passport.use(new LocalStrategy(
  { usernameField: 'email' },
  (email, password, done) => {
    db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
      if (err) return done(err);
      if (!user) return done(null, false, { message: 'Incorrect email.' });
      if (!user.verified) return done(null, false, { message: 'Email not verified.' });
      
      bcrypt.compare(password, user.password, (err, result) => {
        if (err) return done(err);
        if (!result) return done(null, false, { message: 'Incorrect password.' });
        return done(null, user);
      });
    });
  }
));

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser((id, done) => {
  db.get('SELECT * FROM users WHERE id = ?', [id], (err, user) => {
    done(err, user);
  });
});

// Nodemailer configuration
const transporter = nodemailer.createTransport({
  host: 'smtp.office365.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Routes
app.get('/', (req, res) => {
  res.render('index', { user: req.user });
});

app.get('/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/');
  });
});

app.get('/login', (req, res) => {
  res.render('login');
});

app.post('/login', passport.authenticate('local', {
  successRedirect: '/dashboard',
  failureRedirect: '/login'
}));

app.get('/register', (req, res) => {
  res.render('register');
});

app.post('/register', async (req, res) => {
  const { email, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  const verificationToken = crypto.randomBytes(32).toString('hex');
  
  db.run('INSERT INTO users (email, password, verified, verification_token) VALUES (?, ?, ?, ?)', 
    [email, hashedPassword, false, verificationToken], 
    (err) => {
      if (err) {
        return res.render('register', { error: 'Email already exists' });
      }
      
      // Send verification email
      const verificationLink = `http://localhost:${port}/verify/${verificationToken}`;
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'Verify your email for URL Slicer',
        text: `Please click on this link to verify your email: ${verificationLink}`
      };
      
      transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
          console.log(error);
          res.render('register', { error: 'Error sending email' });
        } else {
          console.log('Email sent: ' + info.response);
          res.redirect('/register-confirmation');
        }
      });
    }
  );
});

app.get('/register-confirmation', (req, res) => {
  res.render('register-confirmation');
});

app.get('/verify/:token', (req, res) => {
  const { token } = req.params;
  db.run('UPDATE users SET verified = ? WHERE verification_token = ?', [true, token], (err) => {
    if (err) {
      return res.send('Error verifying email');
    }
    res.render('verification-success');
  });
});

app.get('/dashboard', (req, res) => {
  if (!req.user) {
    return res.redirect('/login');
  }
  db.all('SELECT * FROM urls WHERE user_id = ?', [req.user.id], (err, urls) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Error fetching URLs');
    }
    res.render('dashboard', { user: req.user, urls: urls });
  });
});

app.post('/shorten', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { originalUrl, maxUses, autoDeleteAt, whitelistMode, allowedCountries, blockedCountries, customAlias } = req.body;
  const shortCode = customAlias || shortid.generate();

  // Check if the custom alias is valid (3-50 symbols)
  if (customAlias && (customAlias.length < 3 || customAlias.length > 50)) {
    return res.status(400).json({ error: 'Custom alias must be between 3 and 50 symbols' });
  }

  // Check if the custom alias or short code is already taken
  db.get('SELECT * FROM urls WHERE short_code = ? OR custom_alias = ?', [shortCode, customAlias], (err, existingUrl) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Error checking for existing URL' });
    }

    if (existingUrl) {
      return res.status(400).json({ error: 'The custom alias or generated short code is already taken' });
    }

    // If the alias is not taken, proceed with creating the URL
    db.run(
      'INSERT INTO urls (user_id, original_url, short_code, custom_alias, max_uses, auto_delete_at, whitelist_mode, allowed_countries, blocked_countries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, originalUrl, shortCode, customAlias, maxUses, autoDeleteAt, whitelistMode, allowedCountries, blockedCountries],
      function(err) {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Error creating shortened URL' });
        }
        res.json({ shortCode: shortCode, customAlias: customAlias });
      }
    );
  });
});

app.get('/:code', async (req, res) => {
  // make sure we're using the latest data
  db.get('PRAGMA read_uncommitted = true');
  const { code } = req.params;
  log('Accessing URL', { code });

  try {
    const url = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM urls WHERE short_code = ? OR custom_alias = ?', [code, code], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!url) {
      log('URL not found', { code });
      return res.status(404).render('url-not-found');
    }

    log('URL found', { url });

    const ip = req.ip;
    log('Client IP', { ip });

    const response = await axios.get(`http://ip-api.com/json/${ip}`);
    const country = response.data.countryCode;
    log('Country detected', { country });

    if (url.whitelist_mode) {
      const allowedCountries = url.allowed_countries ? url.allowed_countries.split(',') : [];
      log('Whitelist mode', { allowedCountries });
      if (!allowedCountries.includes(country)) {
        log('Access denied: country not in whitelist', { country });
        return res.status(403).render('access-denied');
      }
    } else {
      const blockedCountries = url.blocked_countries ? url.blocked_countries.split(',') : [];
      log('Blacklist mode', { blockedCountries });
      if (blockedCountries.includes(country)) {
        log('Access denied: country in blocklist', { country });
        return res.status(403).render('access-denied');
      }
    }

    const clickCount = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM clicks WHERE url_id = ?', [url.id], (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    log('Current click count', { clickCount, maxUses: url.max_uses });

    if (url.max_uses !== null && url.max_uses > 0 && clickCount >= url.max_uses) {
      log('Max uses reached', { clickCount, maxUses: url.max_uses });
      return res.status(410).render('max-uses-reached');
    }

    await new Promise((resolve, reject) => {
      db.run('INSERT INTO clicks (url_id, country) VALUES (?, ?)', [url.id, country], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    log('Click recorded', { urlId: url.id, country });
    log('Redirecting', { originalUrl: url.original_url });
    res.redirect(url.original_url);

  } catch (error) {
    log('Error processing request', { error: error.message, stack: error.stack });
    res.status(500).send('An error occurred while processing your request');
  }
});

app.get('/stats/:code', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { code } = req.params;
  db.get('SELECT * FROM urls WHERE (short_code = ? OR custom_alias = ?) AND user_id = ?', [code, code, req.user.id], (err, url) => {
    if (err || !url) {
      return res.status(404).json({ error: 'URL not found' });
    }

    db.all('SELECT * FROM clicks WHERE url_id = ?', [url.id], (err, clicks) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Error fetching click statistics' });
      }
      res.json({ url, clicks });
    });
  });
});

app.get('/url/:code', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { code } = req.params;
  db.get('SELECT * FROM urls WHERE (short_code = ? OR custom_alias = ?) AND user_id = ?', [code, code, req.user.id], (err, url) => {
    if (err || !url) {
      return res.status(404).json({ error: 'URL not found' });
    }
    res.json(url);
  });
});

app.put('/url/:code', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { code } = req.params;
  const { maxUses, autoDeleteAt, whitelistMode, allowedCountries, blockedCountries } = req.body;

  db.run(
    'UPDATE urls SET max_uses = ?, auto_delete_at = ?, whitelist_mode = ?, allowed_countries = ?, blocked_countries = ? WHERE (short_code = ? OR custom_alias = ?) AND user_id = ?',
    [maxUses, autoDeleteAt, whitelistMode, allowedCountries, blockedCountries, code, code, req.user.id],
    function(err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Error updating URL' });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'URL not found' });
      }
      res.json({ message: 'URL updated successfully' });
    }
  );
});

app.delete('/url/:code', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { code } = req.params;

  db.run('DELETE FROM urls WHERE (short_code = ? OR custom_alias = ?) AND user_id = ?', [code, code, req.user.id], function(err) {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Error deleting URL' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'URL not found' });
    }
    res.json({ message: 'URL deleted successfully' });
  });
});

app.get('/find/:code', (req, res) => {
  const { code } = req.params;
  db.get('SELECT * FROM urls WHERE short_code = ? OR custom_alias = ?', [code, code], (err, url) => {
    if (err || !url) {
      return res.status(404).json({ error: 'URL not found' });
    }
    // construct the full URL
    const fullUrl = `${req.protocol}://${req.get('host')}/${url.short_code}`;
    res.json({ fullUrl });
  });
});

// Debug route
app.get('/debug/:code', (req, res) => {
  const { code } = req.params;
  db.get('SELECT * FROM urls WHERE short_code = ? OR custom_alias = ?', [code, code], (err, url) => {
    if (err || !url) {
      return res.status(404).json({ error: 'URL not found' });
    }
    db.get('SELECT COUNT(*) as click_count FROM clicks WHERE url_id = ?', [url.id], (err, result) => {
      if (err) {
        return res.status(500).json({ error: 'Error fetching click count' });
      }
      res.json({ url, click_count: result.click_count });
    });
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Closing database connection...');
  db.close((err) => {
    if (err) {
      console.error(err.message);
    }
    console.log('Database connection closed.');
    process.exit(0);
  });
});