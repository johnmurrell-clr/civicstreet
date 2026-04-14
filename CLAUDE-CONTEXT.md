# CivicStreet — Claude Development Context

> Last updated: 2026-04-08
> Use this file at the start of a new conversation to get up to speed instantly.

---

## Project Overview

**CivicStreet** is a multi-tenant SaaS road name index platform for county 911 addressing offices and Road & Bridge departments. Built and owned by **CLR Mapping Solutions LLC** (John Murrell).

- **GitHub:** https://github.com/johnmurrell-clr/civicstreet
- **Railway project:** `rare-elegance` (ID: `115241b3-2d0c-4e91-931c-7208e2f4aa80`)
- **Railway service ID:** `0f08a687-9e68-4270-87bc-67f6404ba796`
- **Super admin login:** `clradmin` / `CLRmapping2024!`

---

## Tech Stack

- **Backend:** Node.js + Express
- **Database:** sql.js (SQLite in-memory, persisted to Railway volume)
- **File uploads:** multer
- **Spreadsheet parsing:** xlsx, csv-parse
- **Email:** Resend API (no nodemailer)
- **Hosting:** Railway (app) + Netlify (marketing pages)
- **Repo structure:** flat root — `server.js`, `package.json`, `public/` all in repo root

---

## Live URLs

| URL | What |
|-----|------|
| `clrmapping.com` | CLR Mapping Solutions company site (Netlify, fancy-moxie-8df122) |
| `clrmapping.com/civicstreet` | Redirects to civicstreet.us |
| `civicstreet.us` | CivicStreet marketing page (Netlify, project: civicstreet) |
| `www.civicstreet.us` | Same marketing page |
| `civicstreet.clrmapping.com/manage` | **Super admin portal** |
| `civicstreet.clrmapping.com` | Public road index (no tenant = default page) |
| `{slug}.civicstreet.us` | Each county's public road name search page |
| `{slug}.civicstreet.us/admin.html` | County staff admin portal |

---

## Infrastructure

### Railway
- **Volume:** attached at `/app/data` (env var `RAILWAY_VOLUME_MOUNT_PATH=/app/data`)
- **Volume stores:** `/app/data/master/master.db` (tenant list) and `/app/data/tenants/{slug}.db` (per-tenant data)
- **Port:** 8080
- **Domain:** `civicstreet.clrmapping.com` (CNAME → `z3vb7cn4.up.railway.app`)
- **Wildcard:** `*.civicstreet.us` (CNAME → `z3vb7cn4.up.railway.app`)

### Environment Variables (Railway)
- `RESEND_API_KEY` — Resend API key for email (currently suspended, see pending)
- `RAILWAY_VOLUME_MOUNT_PATH` — auto-set to `/app/data`

### Netlify
- `fancy-moxie-8df122` — clrmapping.com company site
- `civicstreet` — civicstreet.us marketing page

### DNS (Namecheap — civicstreet.us)
| Type | Host | Value |
|------|------|-------|
| A | `@` | `75.2.60.5` (Netlify) |
| CNAME | `www` | `civicstreet.netlify.app` |
| CNAME | `*` | `z3vb7cn4.up.railway.app` |
| CNAME | `_acme` | `g1ji4z39.authorize.railwaydns.net` |
| TXT | `_railway` | railway verify token |
| TXT | `send` | SPF record for Resend |
| MX | `send` | `feedback-smtp.us-east-1.amazonses.com` (priority 10) |
| TXT | DKIM | Resend DKIM record |

### DNS (Corporate Tools — clrmapping.com)
| Type | Host | Value |
|------|------|-------|
| A | `@` | `75.2.60.5` (Netlify) |
| CNAME | `civicstreet` | `z3vb7cn4.up.railway.app` |

---

## App Architecture

### Tenant Model
- Each tenant (county/city) has a **slug** like `waller-county-tx`
- URL format: `waller-county-tx.civicstreet.us`
- Slugs auto-generate as `{org-name}-{state}` — e.g. "Waller County" + TX = `waller-county-tx`
- **Important:** Keep "county" in slug to avoid conflicts with cities

### Database
- Master DB at `VOLUME/master/master.db` — stores tenant records
- Per-tenant DB at `VOLUME/tenants/{slug}.db` — stores roads, settings, sessions, audit log, users
- `saveDb()` uses `fs.writeFileSync` — wrapped in try/catch

### Key Tables (per-tenant DB)
- `roads` — road records with dynamic columns
- `sessions` — login tokens with username and role columns
- `users` — additional staff users with role (admin/editor)
- `audit_log` — action history
- `settings` — key/value store for columns, theme, branding, admin_credentials

---

## Features Built

### Super Admin (`/manage`)
- ✅ Login with `clradmin` / `CLRmapping2024!`
- ✅ List all organizations with stats
- ✅ Add/Edit/Delete organization
- ✅ Suspend / Activate organization
- ✅ Reset Password
- ✅ Email Login button (Resend — currently suspended)
- ✅ Last Payment / Next Payment Date fields (overdue = red)
- ✅ **Reset Schema button** (purple) — drops roads table and resets columns to default, preserves branding/credentials
- ✅ Pricing defaults: $1,500 setup fee, $150/mo monthly fee
- ✅ Negotiated pricing saves correctly (no fallback to defaults on edit)

### County Admin (`/{slug}.civicstreet.us/admin.html`)
- ✅ Login with auto-generated credentials
- ✅ Records tab — view/add/edit/delete roads with column sorting (asc/desc)
- ✅ Columns tab — customize road data fields (admin only)
- ✅ Branding tab — set badge, title, subtitle, contact email, logo upload (admin only)
- ✅ Theme tab — customize colors and fonts (admin only)
- ✅ Upload tab — CSV/Excel upload (append or replace)
- ✅ Audit Log tab
- ✅ Change Password tab
- ✅ **Users tab** (admin only) — add/remove staff users with Admin or Editor roles
- ✅ Admin role: full access to all tabs
- ✅ Editor role: Records, Upload File, Audit Log, Change Password only

### Public Page (`/{slug}.civicstreet.us`)
- ✅ Search by Road Name (searches all columns marked searchable, excludes subdivision)
- ✅ Search by Subdivision (separate tab, searches subdivision only)
- ✅ Highlights matches in searchable columns
- ✅ Custom branding (logo at 100px height, colors, fonts)
- ✅ Table width 1600px, column gap, text wrapping
- ✅ Subtitle stretches full header width
- ✅ Powered by CivicStreet footer

---

## CSV Upload Behavior
- Auto-detects column headers with flexible matching and alias lookup
- SQLite reserved words (primary, secondary, etc.) get prefixed with `col_`
  e.g. `Primary` → `col_primary`, `Secondary` → `col_secondary`
- New columns are created automatically via `ALTER TABLE` (outside transaction)
- Default columns (`road_type`, `subdivision`, `notes`) are hidden after upload if not in CSV
- `road_name` and `status` always remain visible
- Use **Reset Schema** in super admin to wipe and start fresh before re-uploading
- After Reset Schema, do a **Replace All** upload

---

## Pricing

| Item | Price |
|------|-------|
| Setup Fee (assisted) | $1,500 one-time (waived for self-setup) |
| Monthly Subscription | $150/month |
| Annual Subscription | $1,500/year (saves $300 vs monthly) |
| Year One Total (assisted + annual) | $3,000 |
| Renewal | $1,500/year |

Multi-year discounts available on request.

---

## Known Issues / Pending Items

### 🔴 HIGH PRIORITY

**1. Resend account suspended**
- Email credentials feature non-functional
- Sent appeal — civicstreet.us now live as real website
- **Action needed:** Wait for Resend to unsuspend, create new API key, update `RESEND_API_KEY` in Railway

### 🟡 MEDIUM PRIORITY

**2. Files need to be kept in sync**
- Always download fresh from Claude outputs before pushing
- Key files: `server.js`, `public/admin.html`, `public/index.html`, `public/manage/index.html`

---

## Key Decisions Made

1. **SQLite + sql.js** over PostgreSQL — simpler, no separate DB service
2. **Resend** over SMTP/nodemailer — more reliable on Railway
3. **`copyFileSync` not `renameSync`** — Railway uploads dir and volume are different filesystems
4. **Keep "county" in slug** — prevents conflicts with cities
5. **`civicstreet.clrmapping.com`** for super admin — keeps internal URL separate
6. **Railway volume at `/app/data`** — all DB files and logos stored here
7. **Removed nodemailer** — email via https module calling Resend API
8. **Organization terminology** — UI uses "Organization" not "County"
9. **Slug format:** `{org-name-lowercase}-{state-abbreviation}`
10. **Reserved word columns** prefixed with `col_` (e.g. `col_primary`)
11. **ALTER TABLE outside transactions** — sql.js doesn't allow DDL inside BEGIN/COMMIT
12. **Multi-user roles** — Admin (full access) vs Editor (records/upload/audit/password only)
13. **Search tabs independent** — road name search excludes subdivision; subdivision search is its own tab
14. **Public site width** — 1600px max-width to accommodate many columns

---

## Git Commands (Git Bash)

```bash
cd C:/Dev/civicstreet
git add server.js
git add public/admin.html
git add public/index.html
git add public/manage/index.html
git commit -m "message"
git push
```

---

## Contact / Account Info

- **Owner:** John Murrell — john.murrell@clrmapping.com — (979) 256-5880
- **GitHub account:** johnmurrell-clr
- **Railway account:** linked to John's email
- **Netlify account:** john-murrell team
- **Resend account:** created via Google login — currently suspended
- **Namecheap:** civicstreet.us registered here

---

## How to Continue Development

1. Always download the latest files from Claude outputs before replacing local files
2. After replacing files locally, run `npm install` if package.json changed
3. Push with git commands above
4. Railway auto-deploys on every push to main
5. Check Railway deploy logs if something breaks
6. Volume data persists across redeploys — customer data is safe
7. Use **Reset Schema** in super admin if roads table schema gets corrupted
