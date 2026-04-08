const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const multer     = require('multer');
const { parse }  = require('csv-parse/sync');
const XLSX       = require('xlsx');
const initSqlJs  = require('sql.js');
const app  = express();
const PORT = process.env.PORT || 3000;

// ── Email setup ───────────────────────────────────────────────────────────
const httpsModule = require('https');

function sendCredentialsEmail({ to, countyName, slug, username, password }) {
  return new Promise((resolve, reject) => {
    if (!process.env.RESEND_API_KEY) { resolve({ ok: false, error: 'Email not configured' }); return; }
    const loginUrl  = 'https://' + slug + '.civicstreet.us/admin.html';
    const publicUrl = 'https://' + slug + '.civicstreet.us';
    const html = '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">'
      + '<div style="background:#0a1628;padding:24px 32px;border-bottom:3px solid #e8a020">'
      + '<h1 style="color:#fff;margin:0;font-size:22px">CivicStreet</h1>'
      + '<p style="color:rgba(255,255,255,0.5);margin:4px 0 0;font-size:13px">Road Name Index by CLR Mapping Solutions</p>'
      + '</div><div style="padding:32px">'
      + '<h2 style="font-size:18px;margin-bottom:8px">Welcome, ' + countyName + '!</h2>'
      + '<p style="color:#5a6a7a;font-size:15px;line-height:1.6">Your CivicStreet road name index is ready. Here are your login credentials.</p>'
      + '<div style="background:#f4f6f8;border-radius:8px;padding:24px;margin:24px 0">'
      + '<p style="margin:0 0 8px;font-size:15px"><strong>Staff Login URL:</strong> <a href="' + loginUrl + '" style="color:#2d7dd2">' + loginUrl + '</a></p>'
      + '<p style="margin:0 0 8px;font-size:15px"><strong>Username:</strong> <code>' + username + '</code></p>'
      + '<p style="margin:0;font-size:15px"><strong>Temporary Password:</strong> <code>' + password + '</code></p>'
      + '</div>'
      + '<p style="color:#5a6a7a;font-size:14px">Public search page: <a href="' + publicUrl + '" style="color:#2d7dd2">' + publicUrl + '</a></p>'
      + '<p style="color:#e8a020;font-size:13px;background:#fef9ec;border:1px solid #f0d080;border-radius:6px;padding:12px">Please change your password after first login using the Change Password tab.</p>'
      + '<p style="color:#5a6a7a;font-size:13px;margin-top:24px">Questions? Contact john.murrell@clrmapping.com or (979) 256-5880.</p>'
      + '</div><div style="background:#f4f6f8;padding:16px 32px;text-align:center;font-size:12px;color:#999">'
      + '2026 CLR Mapping Solutions LLC</div></div>';

    const body = JSON.stringify({
      from: 'CivicStreet <noreply@civicstreet.us>',
      to: [to],
      subject: 'Your CivicStreet Account - ' + countyName,
      html: html,
    });

    const reqOptions = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = httpsModule.request(reqOptions, (response) => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve({ ok: true });
        } else {
          try { reject(new Error(JSON.parse(data).message || 'Resend error')); }
          catch(e) { reject(new Error('Resend error ' + response.statusCode + ': ' + data)); }
        }
      });
    });
    req.on('error', (e) => reject(e));
    req.write(body);
    req.end();
  });
}

// ── Directory setup ───────────────────────────────────────────────────────
const VOLUME_DIR   = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const TENANTS_DIR  = path.join(VOLUME_DIR, 'tenants');
const DATA_DIR     = path.join(VOLUME_DIR, 'master');
const UPLOADS_DIR  = path.join(__dirname, 'uploads');
const PUBLIC_DIR   = path.join(__dirname, 'public');

[TENANTS_DIR, DATA_DIR, UPLOADS_DIR].forEach(d => { try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch(e) { console.error('Warning: could not create dir', d, e.message); } });

// ── Super admin credentials ───────────────────────────────────────────────
const SUPER_ADMIN_USER = process.env.SUPER_ADMIN_USER || 'clradmin';
const SUPER_ADMIN_PASS = process.env.SUPER_ADMIN_PASS || 'CLRmapping2024!';

// ── sql.js bootstrap ──────────────────────────────────────────────────────
let SQL;
const dbCache = {};

async function getDb(dbPath) {
  if (dbCache[dbPath]) return dbCache[dbPath];
  SQL = SQL || await initSqlJs();
  const db = fs.existsSync(dbPath)
    ? new SQL.Database(fs.readFileSync(dbPath))
    : new SQL.Database();
  dbCache[dbPath] = db;
  return db;
}

function saveDb(db, dbPath) {
  try {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
  } catch(e) {
    console.error('Warning: saveDb failed for', dbPath, ':', e.message);
  }
}

function dbRun(db, dbPath, sql, params = [])  { db.run(sql, params); saveDb(db, dbPath); }
function dbGet(db, sql, params = []) {
  const s = db.prepare(sql); s.bind(params);
  const r = s.step() ? s.getAsObject() : undefined; s.free(); return r;
}
function dbAll(db, sql, params = []) {
  const s = db.prepare(sql); s.bind(params);
  const rows = []; while (s.step()) rows.push(s.getAsObject()); s.free(); return rows;
}
function dbTx(db, dbPath, fn) {
  db.run('BEGIN'); try { fn(); db.run('COMMIT'); saveDb(db, dbPath); } catch(e) { db.run('ROLLBACK'); throw e; }
}

// ── Master tenant database ────────────────────────────────────────────────
const MASTER_DB_PATH = path.join(DATA_DIR, 'master.db');

async function getMasterDb() {
  const db = await getDb(MASTER_DB_PATH);
  db.run(`CREATE TABLE IF NOT EXISTS tenants (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    slug         TEXT UNIQUE NOT NULL,
    county_name  TEXT NOT NULL,
    state        TEXT,
    contact_name TEXT,
    contact_email TEXT,
    plan         TEXT DEFAULT 'standard',
    status       TEXT DEFAULT 'active',
    setup_fee    REAL DEFAULT 500,
    monthly_fee  REAL DEFAULT 99,
    notes        TEXT,
    last_payment_date TEXT,
    next_payment_date TEXT,
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now'))
  )`);
  // Add columns if they don't exist (for existing databases)
  try { db.run(`ALTER TABLE tenants ADD COLUMN last_payment_date TEXT`); } catch(e) {}
  try { db.run(`ALTER TABLE tenants ADD COLUMN next_payment_date TEXT`); } catch(e) {}  db.run(`CREATE TABLE IF NOT EXISTS super_sessions (
    token TEXT PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  saveDb(db, MASTER_DB_PATH);
  return db;
}

// ── Per-tenant database setup ─────────────────────────────────────────────
const DEFAULT_COLUMNS = [
  { key:'road_name',   label:'Road Name',   dbField:'road_name',   visible:true,  searchable:true,  width:'flex' },
  { key:'road_type',   label:'Type',        dbField:'road_type',   visible:true,  searchable:false, width:'90px' },
  { key:'subdivision', label:'Subdivision', dbField:'subdivision', visible:true,  searchable:true,  width:'flex' },
  { key:'status',      label:'Status',      dbField:'status',      visible:true,  searchable:false, width:'90px' },
  { key:'notes',       label:'Notes',       dbField:'notes',       visible:false, searchable:false, width:'flex' },
];

const DEFAULT_THEME = {
  preset:'Navy & Gold', header_bg:'#0d1b2a', nav_bg:'#1a2e42', accent:'#e8a020',
  sky:'#4a90d9', page_bg:'#f5f9ff', row_bg:'#ffffff', row_alt_bg:'#f5f9ff',
  row_hover_bg:'#e8f1fa', table_head_bg:'#0d1b2a', table_head_text:'#c8dff5',
  border:'#c0d4e8', body_text:'#0d1b2a', muted_text:'#5a7a9a',
  status_active:'#2a9d5c', status_reserved:'#e8a020', status_inactive:'#c0392b',
  font_heading:'Syne', font_mono:'DM Mono',
};

async function getTenantDb(slug) {
  const dbPath = path.join(TENANTS_DIR, `${slug}.db`);
  const db = await getDb(dbPath);

  db.run(`CREATE TABLE IF NOT EXISTS roads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    road_name TEXT NOT NULL, road_type TEXT, subdivision TEXT,
    notes TEXT, status TEXT DEFAULT 'Active',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_rn ON roads(road_name)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sub ON roads(subdivision)`);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT, record_id INTEGER, details TEXT, admin_user TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);

  // ── Migration: rename any bare reserved-word columns to col_ prefix ──────
  const SQL_RESERVED_MIGRATE = new Set(['primary','secondary','select','from','where','table','index','group','order','by','create','drop','alter','insert','update','delete','into','values','set','and','or','not','null','true','false','join','left','right','inner','outer','on','as','in','is','like','between','exists','case','when','then','else','end','distinct','all','union','having','limit','offset','key','column','row','type','check','default','unique','references','foreign','constraint','transaction','begin','commit','rollback','view','trigger','database','schema','name','status','state','full','partial']);
  try {
    const tableInfo = dbAll(db, `PRAGMA table_info(roads)`);
    const needsRename = tableInfo.filter(col => SQL_RESERVED_MIGRATE.has(col.name) && !col.name.startsWith('col_'));
    if (needsRename.length) {
      // SQLite doesn't support RENAME COLUMN in older versions — rebuild table
      const allCols = tableInfo.map(c => c.name);
      const colDefs = tableInfo.map(c => {
        const newName = SQL_RESERVED_MIGRATE.has(c.name) && !c.name.startsWith('col_') ? `col_${c.name}` : c.name;
        return `${newName} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.dflt_value ? ` DEFAULT ${c.dflt_value}` : ''}${c.pk ? ' PRIMARY KEY AUTOINCREMENT' : ''}`;
      }).filter((_,i) => !tableInfo[i].pk); // exclude pk from col defs, handle separately
      
      const selectCols = allCols.join(',');
      const insertCols = allCols.map(n => SQL_RESERVED_MIGRATE.has(n) && !n.startsWith('col_') ? `col_${n}` : n).join(',');
      
      db.run(`ALTER TABLE roads RENAME TO roads_old`);
      db.run(`CREATE TABLE roads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        road_name TEXT NOT NULL, road_type TEXT, subdivision TEXT,
        notes TEXT, status TEXT DEFAULT 'Active',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        ${needsRename.map(c => `col_${c.name} TEXT`).join(',\n        ')},
        ${tableInfo.filter(c => !['id','road_name','road_type','subdivision','notes','status','created_at','updated_at'].includes(c.name) && !SQL_RESERVED_MIGRATE.has(c.name)).map(c => `${c.name} TEXT`).join(',\n        ')}
      )`);
      db.run(`INSERT INTO roads(${insertCols}) SELECT ${selectCols} FROM roads_old`);
      db.run(`DROP TABLE roads_old`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_rn ON roads(road_name)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_sub ON roads(subdivision)`);

      // Also fix the stored column settings
      const getSetting2 = (k) => { const r = dbGet(db, `SELECT value FROM settings WHERE key=?`,[k]); return r ? JSON.parse(r.value) : null; };
      const setSetting2 = (k,v) => { db.run(`INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`,[k,JSON.stringify(v)]); };
      const cols = getSetting2('columns');
      if (cols) {
        const fixed = cols.map(c => SQL_RESERVED_MIGRATE.has(c.key) && !c.key.startsWith('col_') ? { ...c, key: `col_${c.key}` } : c);
        setSetting2('columns', fixed);
      }
    }
  } catch(e) { console.error('Migration warning:', e.message); }

  // Seed defaults
  const getSetting = (k) => { const r = dbGet(db, `SELECT value FROM settings WHERE key=?`,[k]); return r ? JSON.parse(r.value) : null; };
  const setSetting = (k,v) => { db.run(`INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`,[k,JSON.stringify(v)]); };
  if (!getSetting('columns'))  setSetting('columns',  DEFAULT_COLUMNS);
  if (!getSetting('theme'))    setSetting('theme',    DEFAULT_THEME);
  if (!getSetting('branding')) setSetting('branding', {
    badge: 'Powered by CivicStreet', title: 'Road Name Index', subtitle:
    'Search approved and reserved road names. If a name appears in this list, it may not be used for a new street. Updated nightly.',
    instr1_title:'How to check a name', instr1_body:'Type only the road name, not the suffix. Results filter as you type.',
    instr2_title:'Name not found?', instr2_body:'Email {email} to request approval.',
    contact_email:'', logo_file:'',
  });

  try { saveDb(db, path.join(TENANTS_DIR, `${slug}.db`)); } catch(e) { console.error('Warning: could not save tenant db:', e.message); }
  return { db, dbPath: path.join(TENANTS_DIR, `${slug}.db`) };
}

// ── Middleware ────────────────────────────────────────────────────────────
app.use(express.json());

// Tenant resolver — reads subdomain
app.use(async (req, res, next) => {
  const host = req.hostname || '';
  const parts = host.split('.');

  // manage.civicstreet.us → super admin
  if (parts[0] === 'manage' || host === 'manage' || req.path.startsWith('/manage')) {
    req.isManage = true;
    return next();
  }

  // Detect slug: harris.civicstreet.us → harris
  // Also handle localhost:3000/tenant/harris for local dev
  const devMatch = req.path.match(/^\/tenant\/([a-z0-9-]+)(\/.*)?$/);
  if (devMatch) {
    req.tenantSlug = devMatch[1];
    req.url = devMatch[2] || '/';
    return next();
  }

  // Production subdomain
  if (parts.length >= 3) {
    req.tenantSlug = parts[0];
    return next();
  }

  next();
});

// Serve manage portal static files
app.use('/manage', express.static(path.join(PUBLIC_DIR, 'manage')));

// Serve tenant static files
// Dedicated logo serving route
app.get('/logo/:filename', resolveTenant, (req, res) => {
  if (!req.tenantSlug) return res.status(404).send('Not found');
  const logoDir = path.join(TENANTS_DIR, req.tenantSlug + '-logo');
  const filePath = path.join(logoDir, req.params.filename);
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }
  res.status(404).send('Logo not found');
});

app.use((req, res, next) => {
  if (req.tenantSlug) {
    return express.static(PUBLIC_DIR)(req, res, next);
  }
  next();
});

// Default root — redirect to manage or show landing
app.use(express.static(PUBLIC_DIR));

// ── Helpers ───────────────────────────────────────────────────────────────
function token() { return crypto.randomBytes(32).toString('hex'); }
function likeUp(s) { return `%${(s||'').toUpperCase()}%`; }
const PROTECTED = ['id','created_at','updated_at'];

const COLUMN_ALIASES = {
  road_name:['road_name','roadname','name','street_name','streetname','road','street','full_name','full name','road name','street address','address','road_full','fullname'],
  road_type:['road_type','roadtype','type','suffix','street_type','street type','suffix','str type'],
  subdivision:['subdivision','subdiv','sub','plat','development','subd','subdvision'],
  status:['status','state','road_status'],
  notes:['notes','note','comments','comment','remarks'],
};

function detectCols(headers) {
  // Normalize headers — lowercase and trim all whitespace
  const normalized = headers.map(h => (h||'').toLowerCase().trim());
  const map = {};
  for (const [f, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = aliases.findIndex(a => normalized.includes(a.toLowerCase().trim()));
    map[f] = idx >= 0 ? headers[normalized.indexOf(aliases[idx].toLowerCase().trim())] : null;
  }
  return map;
}

function rowsFromRecords(records, tenantColumns, headerKeyMap) {
  if (!records.length) return [];
  const rawHeaders = Object.keys(records[0]);
  const colMap = detectCols(rawHeaders);

  // If no road_name matched by alias, try to match against tenant's saved column labels/keys
  if (!colMap.road_name && tenantColumns && tenantColumns.length) {
    const normalized = rawHeaders.map(h => (h||'').toLowerCase().trim());
    for (const col of tenantColumns) {
      const keyMatch   = normalized.indexOf((col.key||'').toLowerCase().trim());
      const labelMatch = normalized.indexOf((col.label||'').toLowerCase().trim());
      if (keyMatch >= 0)   { colMap.road_name = rawHeaders[keyMatch];   break; }
      if (labelMatch >= 0) { colMap.road_name = rawHeaders[labelMatch]; break; }
    }
  }

  // Last resort: use the first non-empty column
  if (!colMap.road_name) colMap.road_name = rawHeaders[0];

  // Build extra columns map from tenant columns (existing) + headerKeyMap (new from this upload)
  const defaultKeys = ['road_name','road_type','subdivision','status','notes','id','created_at','updated_at'];
  const extraColMap = {}; // safeKey -> original header name

  // From existing tenant columns
  if (tenantColumns) {
    const normalized = rawHeaders.map(h => (h||'').toLowerCase().trim());
    for (const col of tenantColumns) {
      if (defaultKeys.includes(col.key)) continue;
      const keyIdx   = normalized.indexOf((col.key||'').toLowerCase().trim());
      const labelIdx = normalized.indexOf((col.label||'').toLowerCase().trim());
      if (keyIdx >= 0)        extraColMap[col.key] = rawHeaders[keyIdx];
      else if (labelIdx >= 0) extraColMap[col.key] = rawHeaders[labelIdx];
    }
  }

  // From new headers discovered during this upload (headerKeyMap: { 'Pre Dir': 'pre_dir', ... })
  if (headerKeyMap) {
    for (const [header, safeKey] of Object.entries(headerKeyMap)) {
      if (!defaultKeys.includes(safeKey)) extraColMap[safeKey] = header;
    }
  }

  return records.map(r => {
    const row = {
      road_name:   (r[colMap.road_name]  ||'').toString().trim().toUpperCase(),
      road_type:   colMap.road_type   ? (r[colMap.road_type]  ||'').toString().trim() : null,
      subdivision: colMap.subdivision ? (r[colMap.subdivision]||'').toString().trim() : null,
      status:      colMap.status      ? (r[colMap.status]     ||'Active').toString().trim() : 'Active',
      notes:       colMap.notes       ? (r[colMap.notes]      ||'').toString().trim() : null,
    };
    for (const [key, header] of Object.entries(extraColMap)) {
      row[key] = r[header] !== undefined ? (r[header]||'').toString().trim() : null;
    }
    return row;
  }).filter(r => r.road_name);
}

// ── Multer instances ──────────────────────────────────────────────────────
const csvUpload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 20*1024*1024 },
  fileFilter:(req,file,cb) => cb(/\.(csv|xlsx|xls)$/i.test(file.originalname)?null:new Error('CSV/Excel only'), /\.(csv|xlsx|xls)$/i.test(file.originalname))
});
const logoUpload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 5*1024*1024 },
  fileFilter:(req,file,cb) => cb(/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(file.originalname)?null:new Error('Image only'), /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(file.originalname))
});

// ═══════════════════════════════════════════════════════════════════════════
// SUPER ADMIN ROUTES (/manage/api/...)
// ═══════════════════════════════════════════════════════════════════════════

async function superAuth(req, res, next) {
  const t = req.headers['x-super-token'];
  if (!t) return res.status(401).json({ error: 'Unauthorized' });
  const mdb = await getMasterDb();
  if (!dbGet(mdb, `SELECT token FROM super_sessions WHERE token=?`,[t])) return res.status(401).json({ error: 'Invalid session' });
  next();
}

app.post('/manage/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (username === SUPER_ADMIN_USER && password === SUPER_ADMIN_PASS) {
    const mdb = await getMasterDb();
    const t = token();
    dbRun(mdb, MASTER_DB_PATH, `INSERT INTO super_sessions(token) VALUES(?)`, [t]);
    return res.json({ token: t });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/manage/api/logout', superAuth, async (req, res) => {
  const mdb = await getMasterDb();
  dbRun(mdb, MASTER_DB_PATH, `DELETE FROM super_sessions WHERE token=?`, [req.headers['x-super-token']]);
  res.json({ ok: true });
});

// List all tenants
app.get('/manage/api/tenants', superAuth, async (req, res) => {
  const mdb = await getMasterDb();
  const tenants = dbAll(mdb, `SELECT * FROM tenants ORDER BY county_name ASC`);
  // Add road count for each
  for (const t of tenants) {
    try {
      const { db } = await getTenantDb(t.slug);
      const r = dbGet(db, `SELECT COUNT(*) as n FROM roads`);
      t.road_count = r ? r.n : 0;
    } catch { t.road_count = 0; }
  }
  res.json({ tenants });
});

// Get single tenant
app.get('/manage/api/tenants/:slug', superAuth, async (req, res) => {
  const mdb = await getMasterDb();
  const t = dbGet(mdb, `SELECT * FROM tenants WHERE slug=?`, [req.params.slug]);
  if (!t) return res.status(404).json({ error: 'Not found' });
  res.json(t);
});

// Create tenant
app.post('/manage/api/tenants', superAuth, async (req, res) => {
  const { slug, county_name, state, contact_name, contact_email, plan, setup_fee, monthly_fee, notes } = req.body;
  if (!slug || !county_name) return res.status(400).json({ error: 'slug and county_name are required' });

  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g,'');
  if (!safeSlug) return res.status(400).json({ error: 'Invalid slug' });

  const mdb = await getMasterDb();
  const exists = dbGet(mdb, `SELECT id FROM tenants WHERE slug=?`, [safeSlug]);
  if (exists) return res.status(409).json({ error: `Tenant "${safeSlug}" already exists` });

  // Create tenant record
  dbRun(mdb, MASTER_DB_PATH, `INSERT INTO tenants(slug,county_name,state,contact_name,contact_email,plan,setup_fee,monthly_fee,notes)
    VALUES(?,?,?,?,?,?,?,?,?)`,
    [safeSlug, county_name, state||'', contact_name||'', contact_email||'', plan||'standard', setup_fee||500, monthly_fee||99, notes||'']);

  // Initialize tenant DB
  await getTenantDb(safeSlug);

  // Create tenant admin password
  const adminPass = generatePassword();
  const { db, dbPath } = await getTenantDb(safeSlug);
  dbRun(db, dbPath, `INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`,
    ['admin_credentials', JSON.stringify({ username: safeSlug + '_admin', password: adminPass })]);

  // Seed branding with county name
  const getSetting = (k) => { const r = dbGet(db,`SELECT value FROM settings WHERE key=?`,[k]); return r?JSON.parse(r.value):null; };
  const branding = getSetting('branding') || {};
  branding.badge = `${county_name}`;
  branding.title = 'Road Name Index';
  dbRun(db, dbPath, `INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`, ['branding', JSON.stringify(branding)]);

  res.json({ ok: true, slug: safeSlug, admin_username: safeSlug+'_admin', admin_password: adminPass });
});

// Email credentials to county contact
app.post('/manage/api/tenants/:slug/send-login', superAuth, async (req, res) => {
  try {
    const mdb = await getMasterDb();
    const t = dbGet(mdb, `SELECT * FROM tenants WHERE slug=?`, [req.params.slug]);
    if (!t) return res.status(404).json({ error: 'Tenant not found' });
    if (!t.contact_email) return res.status(400).json({ error: 'No contact email on file for this county' });
    const { db } = await getTenantDb(req.params.slug);
    const getSetting = (k) => { try { const r = dbGet(db,`SELECT value FROM settings WHERE key=?`,[k]); return r?JSON.parse(r.value):null; } catch(e) { return null; } };
    const creds = getSetting('admin_credentials');
    if (!creds) return res.status(400).json({ error: 'No credentials found for this county' });
    await sendCredentialsEmail({
      to: t.contact_email,
      countyName: t.county_name,
      slug: req.params.slug,
      username: creds.username,
      password: creds.password,
    });
    res.json({ ok: true });
  } catch(e) {
    console.error('Email credentials error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
app.put('/manage/api/tenants/:slug', superAuth, async (req, res) => {
  const mdb = await getMasterDb();
  const { county_name, state, contact_name, contact_email, plan, status, setup_fee, monthly_fee, notes, last_payment_date, next_payment_date } = req.body;
  dbRun(mdb, MASTER_DB_PATH,
    `UPDATE tenants SET county_name=?,state=?,contact_name=?,contact_email=?,plan=?,status=?,setup_fee=?,monthly_fee=?,notes=?,last_payment_date=?,next_payment_date=?,updated_at=datetime('now') WHERE slug=?`,
    [county_name,state,contact_name,contact_email,plan,status,setup_fee,monthly_fee,notes,last_payment_date||null,next_payment_date||null,req.params.slug]);
  res.json({ ok: true });
});

// Delete tenant
app.delete('/manage/api/tenants/:slug', superAuth, async (req, res) => {
  const mdb = await getMasterDb();
  const t = dbGet(mdb, `SELECT id FROM tenants WHERE slug=?`, [req.params.slug]);
  if (!t) return res.status(404).json({ error: 'Not found' });
  dbRun(mdb, MASTER_DB_PATH, `DELETE FROM tenants WHERE slug=?`, [req.params.slug]);
  // Remove from cache and delete db file
  const dbPath = path.join(TENANTS_DIR, `${req.params.slug}.db`);
  delete dbCache[dbPath];
  try { require('fs').unlinkSync(dbPath); } catch(e) {}
  res.json({ ok: true });
});

// Reset tenant admin password
app.post('/manage/api/tenants/:slug/reset-password', superAuth, async (req, res) => {
  const { db, dbPath } = await getTenantDb(req.params.slug);
  const newPass = generatePassword();
  const getSetting = (k) => { const r = dbGet(db,`SELECT value FROM settings WHERE key=?`,[k]); return r?JSON.parse(r.value):null; };
  const creds = getSetting('admin_credentials') || { username: req.params.slug+'_admin' };
  creds.password = newPass;
  dbRun(db, dbPath, `INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`, ['admin_credentials', JSON.stringify(creds)]);
  res.json({ ok: true, admin_username: creds.username, admin_password: newPass });
});

// Suspend / reactivate
app.post('/manage/api/tenants/:slug/suspend', superAuth, async (req, res) => {
  const mdb = await getMasterDb();
  dbRun(mdb, MASTER_DB_PATH, `UPDATE tenants SET status='suspended' WHERE slug=?`, [req.params.slug]);
  res.json({ ok: true });
});

app.post('/manage/api/tenants/:slug/activate', superAuth, async (req, res) => {
  const mdb = await getMasterDb();
  dbRun(mdb, MASTER_DB_PATH, `UPDATE tenants SET status='active' WHERE slug=?`, [req.params.slug]);
  res.json({ ok: true });
});

// Reset tenant roads schema — drops all road data and custom columns, preserves settings/branding/credentials
app.post('/manage/api/tenants/:slug/reset-schema', superAuth, async (req, res) => {
  try {
    const { db, dbPath } = await getTenantDb(req.params.slug);
    // Drop and recreate roads table cleanly
    db.run(`DROP TABLE IF EXISTS roads`);
    db.run(`CREATE TABLE roads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      road_name TEXT NOT NULL, road_type TEXT, subdivision TEXT,
      notes TEXT, status TEXT DEFAULT 'Active',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_rn ON roads(road_name)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sub ON roads(subdivision)`);
    // Reset column settings back to defaults
    db.run(`INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`, ['columns', JSON.stringify(DEFAULT_COLUMNS)]);
    saveDb(db, dbPath);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Super admin stats
app.get('/manage/api/stats', superAuth, async (req, res) => {
  const mdb = await getMasterDb();
  const total    = dbGet(mdb, `SELECT COUNT(*) as n FROM tenants`);
  const active   = dbGet(mdb, `SELECT COUNT(*) as n FROM tenants WHERE status='active'`);
  const suspended= dbGet(mdb, `SELECT COUNT(*) as n FROM tenants WHERE status='suspended'`);
  const mrr      = dbGet(mdb, `SELECT SUM(monthly_fee) as n FROM tenants WHERE status='active'`);
  res.json({ total: total.n, active: active.n, suspended: suspended.n, mrr: mrr.n || 0 });
});

// ═══════════════════════════════════════════════════════════════════════════
// TENANT ROUTES — all require req.tenantSlug
// ═══════════════════════════════════════════════════════════════════════════

async function resolveTenant(req, res, next) {
  if (!req.tenantSlug) return res.status(404).json({ error: 'No tenant specified' });
  const mdb = await getMasterDb();
  const tenant = dbGet(mdb, `SELECT * FROM tenants WHERE slug=?`, [req.tenantSlug]);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  if (tenant.status === 'suspended') return res.status(403).json({ error: 'Account suspended. Contact CivicStreet support.' });
  req.tenant = tenant;
  const { db, dbPath } = await getTenantDb(req.tenantSlug);
  req.db = db;
  req.dbPath = dbPath;
  req.getSetting = (k) => { const r = dbGet(db,`SELECT value FROM settings WHERE key=?`,[k]); return r?JSON.parse(r.value):null; };
  req.setSetting = (k,v) => { dbRun(db, dbPath, `INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`,[k,JSON.stringify(v)]); };
  next();
}

async function tenantAuth(req, res, next) {
  const t = req.headers['x-admin-token'];
  if (!t) return res.status(401).json({ error: 'Unauthorized' });
  const session = dbGet(req.db, `SELECT token FROM sessions WHERE token=?`,[t]);
  if (!session) return res.status(401).json({ error: 'Invalid session' });
  next();
}

function logAction(req, action, recordId, details) {
  dbRun(req.db, req.dbPath, `INSERT INTO audit_log(action,record_id,details,admin_user) VALUES(?,?,?,?)`,
    [action, recordId||null, details||null, 'admin']);
}

// ── PUBLIC tenant endpoints ───────────────────────────────────────────────
app.get('/api/branding',    resolveTenant, (req, res) => res.json(req.getSetting('branding') || {}));
app.get('/api/theme',       resolveTenant, (req, res) => res.json({ ...DEFAULT_THEME, ...(req.getSetting('theme')||{}) }));
app.get('/api/columns',     resolveTenant, (req, res) => res.json(req.getSetting('columns') || DEFAULT_COLUMNS));

app.get('/api/stats', resolveTenant, (req, res) => {
  const count  = dbGet(req.db,`SELECT COUNT(*) as total FROM roads`);
  const subdiv = dbGet(req.db,`SELECT COUNT(DISTINCT subdivision) as total FROM roads WHERE subdivision IS NOT NULL AND subdivision!=''`);
  const last   = dbGet(req.db,`SELECT MAX(updated_at) as last_updated FROM roads`);
  res.json({ total: count.total, subdivisions: subdiv.total, lastUpdated: last.last_updated });
});

app.get('/api/search', resolveTenant, (req, res) => {
  const q = (req.query.q||'').trim(), limit = Math.min(parseInt(req.query.limit)||200,1000);
  const rows = q
    ? dbAll(req.db,`SELECT * FROM roads WHERE UPPER(road_name) LIKE ? ORDER BY road_name ASC LIMIT ?`,[likeUp(q),limit])
    : dbAll(req.db,`SELECT * FROM roads ORDER BY road_name ASC LIMIT ?`,[limit]);
  res.json({ results: rows, total: rows.length });
});

app.get('/api/search/subdivision', resolveTenant, (req, res) => {
  const q = (req.query.q||'').trim(), limit = Math.min(parseInt(req.query.limit)||200,1000);
  const rows = q
    ? dbAll(req.db,`SELECT * FROM roads WHERE UPPER(subdivision) LIKE ? ORDER BY subdivision ASC, road_name ASC LIMIT ?`,[likeUp(q),limit])
    : dbAll(req.db,`SELECT * FROM roads WHERE subdivision IS NOT NULL AND subdivision!='' ORDER BY subdivision ASC, road_name ASC LIMIT ?`,[limit]);
  res.json({ results: rows, total: rows.length });
});

// ── TENANT ADMIN AUTH ─────────────────────────────────────────────────────
app.post('/api/admin/login', resolveTenant, (req, res) => {
  const { username, password } = req.body;
  const creds = req.getSetting('admin_credentials');
  if (creds && username === creds.username && password === creds.password) {
    const t = token();
    dbRun(req.db, req.dbPath, `INSERT INTO sessions(token) VALUES(?)`, [t]);
    logAction(req, 'LOGIN', null, `Login: ${username}`);
    return res.json({ token: t, county_name: req.tenant.county_name });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/admin/logout', resolveTenant, tenantAuth, (req, res) => {
  dbRun(req.db, req.dbPath, `DELETE FROM sessions WHERE token=?`, [req.headers['x-admin-token']]);
  res.json({ ok: true });
});

app.post('/api/admin/change-password', resolveTenant, tenantAuth, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'All fields are required' });
  if (new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const creds = req.getSetting('admin_credentials');
  if (!creds || creds.password !== current_password) return res.status(401).json({ error: 'Current password is incorrect' });
  creds.password = new_password;
  dbRun(req.db, req.dbPath, `INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`, ['admin_credentials', JSON.stringify(creds)]);
  res.json({ ok: true });
});

// ── TENANT ADMIN CRUD ─────────────────────────────────────────────────────
app.get('/api/admin/roads', resolveTenant, tenantAuth, (req, res) => {
  const q = (req.query.q||'').trim(), page = Math.max(1,parseInt(req.query.page)||1);
  const limit = Math.min(parseInt(req.query.limit)||50,200), offset = (page-1)*limit;
  const cols = req.getSetting('columns') || DEFAULT_COLUMNS;
  const validCols = cols.map(c => c.key);
  const sortCol = validCols.includes(req.query.sort) ? req.query.sort : 'road_name';
  const sortDir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
  const orderBy = `ORDER BY ${sortCol} ${sortDir}`;
  const rows = q
    ? dbAll(req.db,`SELECT * FROM roads WHERE UPPER(road_name) LIKE ? OR UPPER(subdivision) LIKE ? ${orderBy} LIMIT ? OFFSET ?`,[likeUp(q),likeUp(q),limit,offset])
    : dbAll(req.db,`SELECT * FROM roads ${orderBy} LIMIT ? OFFSET ?`,[limit,offset]);
  const totalRow = q
    ? dbGet(req.db,`SELECT COUNT(*) as n FROM roads WHERE UPPER(road_name) LIKE ? OR UPPER(subdivision) LIKE ?`,[likeUp(q),likeUp(q)])
    : dbGet(req.db,`SELECT COUNT(*) as n FROM roads`);
  res.json({ results: rows, total: totalRow.n, page, pages: Math.ceil(totalRow.n/limit) });
});

app.get('/api/admin/roads/:id', resolveTenant, tenantAuth, (req, res) => {
  const row = dbGet(req.db,`SELECT * FROM roads WHERE id=?`,[req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.post('/api/admin/roads', resolveTenant, tenantAuth, (req, res) => {
  const { road_name, road_type, subdivision, notes, status } = req.body;
  if (!road_name?.trim()) return res.status(400).json({ error: 'road_name required' });
  if (dbGet(req.db,`SELECT id FROM roads WHERE UPPER(road_name)=?`,[road_name.trim().toUpperCase()]))
    return res.status(409).json({ error: `"${road_name.toUpperCase()}" already exists` });

  // Get custom columns and build dynamic insert
  const cols = req.getSetting('columns') || DEFAULT_COLUMNS;
  const defaultKeys = ['road_name','road_type','subdivision','notes','status','id','created_at','updated_at'];
  const customCols = cols.filter(c => !defaultKeys.includes(c.key) && req.body[c.key] !== undefined);
  const allKeys = ['road_name','road_type','subdivision','notes','status', ...customCols.map(c => c.key)];
  const allVals = [road_name.trim().toUpperCase(),(road_type||'').trim()||null,(subdivision||'').trim()||null,(notes||'').trim()||null,status||'Active', ...customCols.map(c => (req.body[c.key]||'').trim()||null)];
  const placeholders = allKeys.map(() => '?').join(',');
  try {
    dbRun(req.db, req.dbPath, `INSERT INTO roads(${allKeys.join(',')}) VALUES(${placeholders})`, allVals);
  } catch(e) {
    // Fallback to default columns only
    dbRun(req.db,req.dbPath,`INSERT INTO roads(road_name,road_type,subdivision,notes,status) VALUES(?,?,?,?,?)`,
      [road_name.trim().toUpperCase(),(road_type||'').trim()||null,(subdivision||'').trim()||null,(notes||'').trim()||null,status||'Active']);
  }
  const newRow = dbGet(req.db,`SELECT id FROM roads WHERE UPPER(road_name)=? ORDER BY id DESC LIMIT 1`,[road_name.trim().toUpperCase()]);
  logAction(req,'ADD',newRow?.id,`Added "${road_name.trim().toUpperCase()}"`);
  res.json({ id: newRow?.id, ok: true });
});

app.put('/api/admin/roads/:id', resolveTenant, tenantAuth, (req, res) => {
  const { road_name, road_type, subdivision, notes, status } = req.body;
  if (!road_name?.trim()) return res.status(400).json({ error: 'road_name required' });

  // Get custom columns and build dynamic update
  const cols = req.getSetting('columns') || DEFAULT_COLUMNS;
  const defaultKeys = ['road_name','road_type','subdivision','notes','status','id','created_at','updated_at'];
  const customCols = cols.filter(c => !defaultKeys.includes(c.key) && req.body[c.key] !== undefined);
  const customSets = customCols.map(c => `${c.key}=?`).join(',');
  const customVals = customCols.map(c => (req.body[c.key]||'').trim()||null);
  const extraSets = customSets ? ',' + customSets : '';
  try {
    dbRun(req.db,req.dbPath,
      `UPDATE roads SET road_name=?,road_type=?,subdivision=?,notes=?,status=?,updated_at=datetime('now')${extraSets} WHERE id=?`,
      [road_name.trim().toUpperCase(),(road_type||'').trim()||null,(subdivision||'').trim()||null,(notes||'').trim()||null,status||'Active',...customVals,req.params.id]);
  } catch(e) {
    dbRun(req.db,req.dbPath,`UPDATE roads SET road_name=?,road_type=?,subdivision=?,notes=?,status=?,updated_at=datetime('now') WHERE id=?`,
      [road_name.trim().toUpperCase(),(road_type||'').trim()||null,(subdivision||'').trim()||null,(notes||'').trim()||null,status||'Active',req.params.id]);
  }
  logAction(req,'EDIT',req.params.id,`Updated "${road_name.trim().toUpperCase()}"`);
  res.json({ ok: true });
});

app.delete('/api/admin/roads/:id', resolveTenant, tenantAuth, (req, res) => {
  const row = dbGet(req.db,`SELECT road_name FROM roads WHERE id=?`,[req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  dbRun(req.db,req.dbPath,`DELETE FROM roads WHERE id=?`,[req.params.id]);
  logAction(req,'DELETE',req.params.id,`Deleted "${row.road_name}"`);
  res.json({ ok: true });
});

// ── TENANT ADMIN SETTINGS ─────────────────────────────────────────────────
app.get('/api/admin/columns',    resolveTenant, tenantAuth, (req,res) => res.json(req.getSetting('columns')||DEFAULT_COLUMNS));
app.put('/api/admin/columns',    resolveTenant, tenantAuth, (req,res) => { req.setSetting('columns',req.body); logAction(req,'COLUMNS',null,'Updated columns'); res.json({ok:true}); });
app.post('/api/admin/columns',   resolveTenant, tenantAuth, (req,res) => {
  const { key,label,width } = req.body;
  if (!key||!label) return res.status(400).json({error:'key and label required'});
  const safeKey = key.toLowerCase().replace(/[^a-z0-9_]/g,'_');
  const cols = req.getSetting('columns')||DEFAULT_COLUMNS;
  if (cols.find(c=>c.key===safeKey)) return res.status(409).json({error:'Column already exists'});
  try { req.db.run(`ALTER TABLE roads ADD COLUMN ${safeKey} TEXT`); saveDb(req.db,req.dbPath); } catch{}
  cols.push({key:safeKey,label,dbField:safeKey,visible:true,searchable:false,width:width||'flex'});
  req.setSetting('columns',cols);
  res.json({ok:true,key:safeKey});
});
app.delete('/api/admin/columns/:key', resolveTenant, tenantAuth, (req,res) => {
  if (['road_name','id','created_at','updated_at'].includes(req.params.key)) return res.status(400).json({error:'Cannot delete protected column'});
  const cols = (req.getSetting('columns')||DEFAULT_COLUMNS).filter(c=>c.key!==req.params.key);
  req.setSetting('columns',cols); res.json({ok:true});
});

app.get('/api/admin/theme',  resolveTenant, tenantAuth, (req,res) => res.json({...DEFAULT_THEME,...(req.getSetting('theme')||{})}));
app.put('/api/admin/theme',  resolveTenant, tenantAuth, (req,res) => { req.setSetting('theme',{...DEFAULT_THEME,...req.body}); logAction(req,'THEME',null,`Theme: ${req.body.preset||'Custom'}`); res.json({ok:true}); });
app.get('/api/admin/branding',resolveTenant,tenantAuth,(req,res)=>res.json(req.getSetting('branding')||{}));
app.put('/api/admin/branding',resolveTenant,tenantAuth,(req,res)=>{ const b={...req.getSetting('branding')||{},...req.body}; b.logo_file=(req.getSetting('branding')||{}).logo_file||''; req.setSetting('branding',b); logAction(req,'BRANDING',null,'Updated branding'); res.json({ok:true}); });

// Logo upload
app.post('/api/admin/logo', resolveTenant, tenantAuth, logoUpload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({error:'No file'});
  const ext = path.extname(req.file.originalname).toLowerCase();
  const logoDir = path.join(TENANTS_DIR, req.tenantSlug+'-logo');
  try { if (!fs.existsSync(logoDir)) fs.mkdirSync(logoDir, { recursive: true }); } catch(e) {}
  try { fs.readdirSync(logoDir).forEach(f=>fs.unlinkSync(path.join(logoDir,f))); } catch{}
  const destName = 'logo'+ext;
  const destPath = path.join(logoDir, destName);
  try {
    fs.copyFileSync(req.file.path, destPath);
    fs.unlinkSync(req.file.path);
  } catch(e) {
    return res.status(500).json({ error: 'Failed to save logo: ' + e.message });
  }
  const b = {...(req.getSetting('branding')||{}), logo_file:'/logo/'+destName};
  req.setSetting('branding',b);
  res.json({ok:true,logo_file:'/logo/'+destName});
});

app.delete('/api/admin/logo', resolveTenant, tenantAuth, (req, res) => {
  try { const d=path.join(TENANTS_DIR,req.tenantSlug+'-logo'); fs.readdirSync(d).forEach(f=>fs.unlinkSync(path.join(d,f))); } catch{}
  const b = {...(req.getSetting('branding')||{}), logo_file:''};
  req.setSetting('branding',b); res.json({ok:true});
});

// File upload
app.post('/api/admin/upload', resolveTenant, tenantAuth, csvUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({error:'No file'});
  const mode=req.body.mode||'append', filePath=req.file.path, ext=path.extname(req.file.originalname).toLowerCase();
  try {
    let records=[];
    if (ext==='.csv') records=parse(fs.readFileSync(filePath,'utf8'),{columns:true,skip_empty_lines:true,trim:true});
    else if (ext==='.xlsx'||ext==='.xls') { const wb=XLSX.readFile(filePath); records=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''}); }
    else { fs.unlinkSync(filePath); return res.status(400).json({error:'Unsupported file type'}); }

    const tenantColumns = req.getSetting('columns') || DEFAULT_COLUMNS;
    const defaultKeys = ['road_name','road_type','subdivision','notes','status','id','created_at','updated_at'];
    const existingKeys = tenantColumns.map(c => c.key);
    const csvHeaders = Object.keys(records[0]);

    // SQLite reserved words that cannot be used as unquoted column names
    const SQL_RESERVED = new Set(['primary','secondary','select','from','where','table','index','group','order','by','create','drop','alter','insert','update','delete','into','values','set','and','or','not','null','true','false','join','left','right','inner','outer','on','as','in','is','like','between','exists','case','when','then','else','end','distinct','all','union','having','limit','offset','key','column','row','type','check','default','unique','references','foreign','constraint','transaction','begin','commit','rollback','view','trigger','database','schema','name','status','state','full','partial']);

    // Step 1: ALTER TABLE for new columns OUTSIDE any transaction (DDL must be outside tx in sql.js)
    const headerKeyMap = {}; // original header -> safeKey
    let columnsUpdated = false;
    for (const header of csvHeaders) {
      let safeKey = header.toLowerCase().trim().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
      if (!safeKey) continue;
      // Prefix reserved words to avoid SQL syntax errors
      if (SQL_RESERVED.has(safeKey) || /^\d/.test(safeKey)) safeKey = 'col_' + safeKey;
      if (defaultKeys.includes(safeKey) || existingKeys.includes(safeKey)) continue;
      try { req.db.run(`ALTER TABLE roads ADD COLUMN \`${safeKey}\` TEXT`); } catch(e) {}
      headerKeyMap[header] = safeKey;
      tenantColumns.push({ key: safeKey, label: header.trim(), width: 'flex', visible: true, searchable: false });
      existingKeys.push(safeKey);
      columnsUpdated = true;
    }
    if (columnsUpdated) { req.setSetting('columns', tenantColumns); saveDb(req.db, req.dbPath); }

    // Step 2: Build rows with full column mapping
    const rows = rowsFromRecords(records, tenantColumns, headerKeyMap);
    if (!rows.length) { fs.unlinkSync(filePath); return res.status(400).json({error:'No valid rows found'}); }

    // Step 3: Insert rows in a transaction — quote all column names to handle reserved words
    const customCols = tenantColumns.filter(c => !defaultKeys.includes(c.key));
    const allKeys = ['road_name','road_type','subdivision','notes','status', ...customCols.map(c => c.key)];
    const quotedKeys = allKeys.map(k => `\`${k}\``).join(',');
    const placeholders = allKeys.map(() => '?').join(',');
    const insertSql = `INSERT INTO roads(${quotedKeys}) VALUES(${placeholders})`;

    let inserted=0, skipped=0;
    dbTx(req.db, req.dbPath, () => {
      if (mode==='replace') req.db.run(`DELETE FROM roads`);
      for (const row of rows) {
        if (mode==='append' && dbGet(req.db,`SELECT id FROM roads WHERE UPPER(road_name)=?`,[row.road_name])) { skipped++; continue; }
        const allVals = [
          row.road_name,
          row.road_type   || null,
          row.subdivision || null,
          row.notes       || null,
          row.status      || 'Active',
          ...customCols.map(c => row[c.key] !== undefined ? (row[c.key] || null) : null)
        ];
        req.db.run(insertSql, allVals);
        inserted++;
      }
    });
    fs.unlinkSync(filePath);
    logAction(req,'UPLOAD',null,`${mode}: inserted ${inserted}, skipped ${skipped} from ${req.file.originalname}`);
    res.json({ok:true,inserted,skipped,mode});
  } catch(err) { try{fs.unlinkSync(filePath);}catch{} res.status(500).json({error:err.message}); }
});

app.get('/api/admin/audit', resolveTenant, tenantAuth, (req,res) => {
  res.json({results: dbAll(req.db,`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200`)});
});

// ── Utilities ─────────────────────────────────────────────────────────────
function generatePassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#';
  return Array.from({length:12}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
}

// ── Start ─────────────────────────────────────────────────────────────────
async function start() {
  await getMasterDb();
  app.listen(PORT, () => {
    console.log(`\n✅ CivicStreet running on port ${PORT}`);
    console.log(`\n   Super admin dashboard: http://localhost:${PORT}/manage`);
    console.log(`   Super admin login:     ${SUPER_ADMIN_USER} / ${SUPER_ADMIN_PASS}`);
    console.log(`\n   Dev tenant URL format: http://localhost:${PORT}/tenant/{slug}`);
    console.log(`   Example:               http://localhost:${PORT}/tenant/waller\n`);
  });
}

start().catch(err => { console.error('Failed to start:', err); process.exit(1); });
