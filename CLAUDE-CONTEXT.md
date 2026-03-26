# CivicStreet — Claude Development Context

> Last updated: 2026-03-26
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
- `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — **DELETED** (switched to Resend)

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
- **Important:** Keep "county" in slug to avoid conflicts with cities (e.g. `waller-county-tx` vs `waller-tx`)

### Database
- Master DB at `VOLUME/master/master.db` — stores tenant records
- Per-tenant DB at `VOLUME/tenants/{slug}.db` — stores roads, settings, sessions, audit log
- `saveDb()` uses `fs.writeFileSync` — wrapped in try/catch to handle volume issues gracefully

### Key Routes
- `GET /manage` → super admin login page
- `POST /manage/api/tenants` → create tenant (returns credentials)
- `DELETE /manage/api/tenants/:slug` → delete tenant + DB file
- `POST /manage/api/tenants/:slug/send-login` → email credentials via Resend
- `POST /manage/api/tenants/:slug/reset-password` → reset county admin password
- `GET /logo/:filename` → serve tenant logo from volume
- `POST /api/admin/logo` → upload logo (uses copyFileSync, not renameSync — cross-filesystem safe)
- `POST /api/admin/change-password` → county admin change password

---

## Features Built

### Super Admin (`/manage`)
- ✅ Login with `clradmin` / `CLRmapping2024!`
- ✅ List all organizations with stats
- ✅ Add Organization button (modal with all fields)
- ✅ Auto-slug generation: org name + state → `waller-county-tx`
- ✅ Edit organization (all fields including payment dates)
- ✅ Delete organization (removes from DB and deletes .db file)
- ✅ Suspend / Activate organization
- ✅ Reset Password (shows new credentials in popup)
- ✅ Email Login button (sends credentials via Resend — currently blocked by Resend suspension)
- ✅ Last Payment Date + Next Payment Date fields (overdue dates show in red)
- ✅ Table uses "Organization" terminology (not "County")
- ✅ Organization + State combined into one column (e.g. "Waller County, TX")
- ✅ Table wider with more padding, no button wrapping

### County Admin (`/{slug}.civicstreet.us/admin.html`)
- ✅ Login with auto-generated credentials
- ✅ Records tab — view/add/edit/delete roads
- ✅ Column sorting (click headers — ascending/descending)
- ✅ Columns tab — customize road data fields
- ✅ Branding tab — set badge, title, subtitle, contact email, logo upload
- ✅ Theme tab — customize colors and fonts (bold/italic/size controls)
- ✅ Upload tab — CSV/Excel upload (append or replace)
- ✅ Audit Log tab
- ✅ Change Password tab

### Public Page (`/{slug}.civicstreet.us`)
- ✅ Search by road name
- ✅ Search by subdivision
- ✅ Custom branding (logo, colors, fonts)
- ✅ Powered by CivicStreet footer

---

## Known Issues / Pending Items

### 🔴 HIGH PRIORITY

**1. Logo serving broken (404)**
- Logo uploads successfully but `/logo/logo.png` returns 404
- Fix deployed: dedicated `app.get('/logo/:filename')` route using `res.sendFile()`
- May need to re-upload logo after fix deploys
- Need to verify fix is working

**2. Resend account suspended**
- Account suspended during setup — email credentials feature non-functional
- Sent appeal explaining: transactional only, <10 emails/month, county government employees
- Resend asked about relationship between civicstreet.us and clrmapping.com — explained they're same company
- civicstreet.us now live as real website to satisfy Resend review
- **Action needed:** Wait for Resend to unsuspend, then create new API key and update `RESEND_API_KEY` in Railway Variables

### 🟡 MEDIUM PRIORITY

**3. Files need to be pushed to GitHub**
- Several files have been updated here but may not be in sync with local copies
- Always download fresh from Claude outputs before pushing
- Key files: `server.js`, `public/admin.html`, `public/manage/index.html`

**4. Setup fee zero value bug**
- Setting setup fee to $0 may revert to $500 on edit
- Fix applied in manage/index.html modal — needs to be pushed and tested

---

## Key Decisions Made

1. **SQLite + sql.js** over PostgreSQL — simpler, no separate DB service needed, volume persists data
2. **Resend** over SMTP/nodemailer — more reliable on Railway, no port blocking issues
3. **`copyFileSync` not `renameSync`** for logo/file uploads — Railway uploads dir and volume are different filesystems
4. **Keep "county" in slug** — prevents conflicts when cities sign up (waller-county-tx vs waller-tx)
5. **`civicstreet.clrmapping.com`** for super admin — keeps internal URL separate from customer-facing `*.civicstreet.us`
6. **civicstreet.us root** points to Netlify marketing page (A record `75.2.60.5`), wildcard `*` points to Railway
7. **Railway volume at `/app/data`** — all DB files and logos stored here, persists across redeploys
8. **Removed nodemailer** entirely — `require('nodemailer')` removed, email via https module calling Resend API
9. **Organization terminology** — UI uses "Organization" not "County" to support cities too
10. **Slug format:** `{org-name-lowercase}-{state-abbreviation}` e.g. `waller-county-tx`

---

## Contact / Account Info

- **Owner:** John Murrell — john.murrell@clrmapping.com — (979) 256-5880
- **GitHub account:** johnmurrell-clr
- **Railway account:** linked to John's email
- **Netlify account:** john-murrell team
- **Resend account:** created via Google login — currently suspended
- **Namecheap:** civicstreet.us registered here
- **Corporate Tools:** clrmapping.com DNS managed here

---

## How to Continue Development

1. Always download the latest files from Claude outputs before replacing local files
2. After replacing files locally, run `npm install` if package.json changed
3. Push with `git add . && git commit -m "message" && git push`
4. Railway auto-deploys on every push to main
5. Check Railway deploy logs if something breaks — look for errors in Deploy Logs tab
6. Volume data persists across redeploys — customer data is safe
