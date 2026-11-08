# TFT AGENCY — Tournament Management Platform

A starter full-stack PUBG Mobile esports website with a gold/black theme.

## Included
- Public tournament listing and leaderboard
- Team registration with captain account creation
- Captain dashboard showing team and registration details
- Admin login and dashboard
- Admin tournament creation
- Registration approval/rejection
- Team score management
- SQLite database persistence and hashed passwords

## Run locally
1. Install Node.js 20 or newer.
2. Extract this folder.
3. Copy `.env.example` to `.env`.
4. Change `SESSION_SECRET` and `ADMIN_PASSWORD` in `.env`.
5. Open a terminal in this folder and run:
   ```bash
   npm install
   npm start
   ```
6. Visit http://localhost:3000

Default admin username/password are read from `.env`. The example values are `admin` and `ChangeThisAdminPassword123!`; change them before running.

## Important before public launch
- Use HTTPS and a strong unique `SESSION_SECRET`.
- Configure a persistent session store (the default Express MemoryStore is for development only).
- Add rate limiting, CSRF protection, backups, and production logging.
- Review local privacy/data-protection requirements and publish a privacy notice.
- Set up hosting with persistent storage for the SQLite database, or migrate to managed PostgreSQL.
- Do not use the example credentials in production.

## Database
The SQLite file `tft-agency.sqlite` is created automatically on first run and remains in this project directory.
