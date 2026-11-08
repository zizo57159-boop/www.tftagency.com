
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const { createClient } = require("@libsql/client");
const path = require("path");

const app = express();

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  throw new Error("Missing Turso database environment variables.");
}

if (!process.env.SESSION_SECRET) {
  throw new Error("Missing SESSION_SECRET environment variable.");
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

const execute = (sql, args = []) => db.execute({ sql, args });

const get = async (sql, args = []) => {
  const result = await execute(sql, args);
  return result.rows[0] || null;
};

const all = async (sql, args = []) => {
  const result = await execute(sql, args);
  return result.rows;
};

const run = async (sql, args = []) => execute(sql, args);

const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

async function initializeDatabase() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','captain')),
      team_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      captain_name TEXT NOT NULL,
      contact TEXT NOT NULL,
      players TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS tournaments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      prize TEXT NOT NULL,
      event_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Registration Open',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL,
      tournament_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(team_id,tournament_id),
      FOREIGN KEY(team_id) REFERENCES teams(id),
      FOREIGN KEY(tournament_id) REFERENCES tournaments(id)
    )`,
    `CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL UNIQUE,
      wwcd INTEGER NOT NULL DEFAULT 0,
      kills INTEGER NOT NULL DEFAULT 0,
      points INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(team_id) REFERENCES teams(id)
    )`
  ], "write");

  const count = await get("SELECT COUNT(*) AS n FROM tournaments");

  if (Number(count.n) === 0) {
    await db.batch([
      {
        sql: "INSERT INTO tournaments(name,prize,event_date,status) VALUES(?,?,?,?)",
        args: ["TFT OPEN SERIES", "$100", "2026-12-05", "Registration Open"]
      },
      {
        sql: "INSERT INTO tournaments(name,prize,event_date,status) VALUES(?,?,?,?)",
        args: ["TFT CHAMPIONSHIP", "$250", "2026-12-12", "Coming Soon"]
      },
      {
        sql: "INSERT INTO tournaments(name,prize,event_date,status) VALUES(?,?,?,?)",
        args: ["TFT WEEKLY SCRIMS", "Practice", "2026-12-19", "Registration Open"]
      }
    ], "write");
  }

  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD;

  if (!password) {
    throw new Error("Set ADMIN_PASSWORD in Render.");
  }

  const found = await get(
    "SELECT id FROM users WHERE username=?",
    [username]
  );

  if (!found) {
    const hash = await bcrypt.hash(password, 12);
    await run(
      "INSERT INTO users(username,password_hash,role) VALUES(?,?,?)",
      [username, hash, "admin"]
    );
    console.log("Admin account created:", username);
  }

  console.log("Turso database initialized successfully.");
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "30kb" }));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, "public")));

const requireAuth = (req, res, next) =>
  req.session.user
    ? next()
    : res.status(401).json({ error: "Please sign in." });

const requireAdmin = (req, res, next) =>
  req.session.user?.role === "admin"
    ? next()
    : res.status(403).json({ error: "Admin access required." });

// Public APIs

app.get("/api/tournaments", asyncHandler(async (req, res) => {
  res.json(await all(
    "SELECT id,name,prize,event_date AS date,status FROM tournaments ORDER BY event_date"
  ));
}));

app.get("/api/leaderboard", asyncHandler(async (req, res) => {
  res.json(await all(`
    SELECT t.name AS team,s.wwcd,s.kills,s.points
    FROM scores s JOIN teams t ON t.id=s.team_id
    ORDER BY s.points DESC,s.kills DESC
  `));
}));

app.get("/api/session", (req, res) => {
  res.json({ user: req.session.user || null });
}));

app.post("/api/login", asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({
      error: "Username and password are required."
    });
  }

  const user = await get(
    "SELECT * FROM users WHERE username=?",
    [String(username).trim()]
  );

  if (!user || !(await bcrypt.compare(String(password), user.password_hash))) {
    return res.status(401).json({
      error: "Invalid username or password."
    });
  }

  req.session.user = {
    id: Number(user.id),
    username: user.username,
    role: user.role,
    teamId: user.team_id
  };

  res.json({ user: req.session.user });
}));

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Team registration

app.post("/api/register", asyncHandler(async (req, res) => {
  const {
    team, captain, contact, players,
    tournamentId, username, password
  } = req.body || {};

  if (![team, captain, contact, players, username, password]
    .every(v => String(v || "").trim())) {
    return res.status(400).json({
      error: "Complete all required fields."
    });
  }

  if (String(password).length < 10) {
    return res.status(400).json({
      error: "Captain password must be at least 10 characters."
    });
  }

  const event = await get(
    "SELECT id,status FROM tournaments WHERE id=?",
    [Number(tournamentId)]
  );

  if (!event || event.status !== "Registration Open") {
    return res.status(400).json({
      error: "Registration is not open for this tournament."
    });
  }

  const existing = await get(
    "SELECT id FROM users WHERE username=?",
    [String(username).trim()]
  );

  if (existing) {
    return res.status(409).json({
      error: "That captain username is already taken."
    });
  }

  const hash = await bcrypt.hash(String(password), 12);
  const tx = await db.transaction("write");

  try {
    const teamResult = await tx.execute({
      sql: "INSERT INTO teams(name,captain_name,contact,players) VALUES(?,?,?,?)",
      args: [
        String(team).trim(),
        String(captain).trim(),
        String(contact).trim(),
        String(players).trim()
      ]
    });

    const teamId = Number(teamResult.lastInsertRowid);

    await tx.execute({
      sql: "INSERT INTO registrations(team_id,tournament_id) VALUES(?,?)",
      args: [teamId, Number(event.id)]
    });

    await tx.execute({
      sql: "INSERT INTO scores(team_id) VALUES(?)",
      args: [teamId]
    });

    const userResult = await tx.execute({
      sql: "INSERT INTO users(username,password_hash,role,team_id) VALUES(?,?,?,?)",
      args: [String(username).trim(), hash, "captain", teamId]
    });

    const userId = Number(userResult.lastInsertRowid);

    await tx.commit();

    req.session.user = {
      id: userId,
      username: String(username).trim(),
      role: "captain",
      teamId
    };

    res.status(201).json({
      ok: true,
      user: req.session.user
    });

  } catch (e) {
    await tx.rollback();
    res.status(400).json({
      error: "Could not complete registration. Check that this team is not already registered."
    });
  }
}));

// Captain dashboard

app.get("/api/captain", requireAuth, asyncHandler(async (req, res) => {
  if (req.session.user.role !== "captain") {
    return res.status(403).json({
      error: "Captain account required."
    });
  }

  const team = await get(`
    SELECT t.id,t.name,t.captain_name AS captain,t.contact,t.players,
    r.status AS registration_status,ev.name AS tournament,
    ev.event_date AS date,s.wwcd,s.kills,s.points
    FROM teams t
    JOIN registrations r ON r.team_id=t.id
    JOIN tournaments ev ON ev.id=r.tournament_id
    LEFT JOIN scores s ON s.team_id=t.id
    WHERE t.id=?
    ORDER BY r.id DESC LIMIT 1
  `, [req.session.user.teamId]);

  res.json(team);
}));

// Admin tournament management

app.post("/api/admin/tournaments", requireAuth, requireAdmin,
  asyncHandler(async (req, res) => {
    const { name, prize, date, status } = req.body || {};

    if (!name || !prize || !date || !status) {
      return res.status(400).json({
        error: "All tournament fields are required."
      });
    }

    const result = await run(
      "INSERT INTO tournaments(name,prize,event_date,status) VALUES(?,?,?,?)",
      [name, prize, date, status]
    );

    res.status(201).json({
      id: Number(result.lastInsertRowid)
    });
  })
);

app.patch("/api/admin/tournaments/:id", requireAuth, requireAdmin,
  asyncHandler(async (req, res) => {
    const { status } = req.body || {};

    if (!["Registration Open", "Coming Soon", "Live", "Completed"].includes(status)) {
      return res.status(400).json({ error: "Invalid status." });
    }

    const result = await run(
      "UPDATE tournaments SET status=? WHERE id=?",
      [status, Number(req.params.id)]
    );

    res.json({ ok: Number(result.rowsAffected) > 0 });
  })
);

app.delete("/api/admin/tournaments/:id", requireAuth, requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const tx = await db.transaction("write");

    try {
      await tx.execute({
        sql: "DELETE FROM registrations WHERE tournament_id=?",
        args: [id]
      });

      const result = await tx.execute({
        sql: "DELETE FROM tournaments WHERE id=?",
        args: [id]
      });

      await tx.commit();
      res.json({ ok: Number(result.rowsAffected) > 0 });
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  })
);

// Admin registrations

app.get("/api/admin/registrations", requireAuth, requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await all(`
      SELECT r.id,r.status,t.name AS team,t.captain_name AS captain,
      t.contact,t.players,ev.name AS tournament
      FROM registrations r
      JOIN teams t ON t.id=r.team_id
      JOIN tournaments ev ON ev.id=r.tournament_id
      ORDER BY r.created_at DESC
    `));
  })
);

app.patch("/api/admin/registrations/:id", requireAuth, requireAdmin,
  asyncHandler(async (req, res) => {
    const { status } = req.body || {};

    if (!["Pending", "Approved", "Rejected"].includes(status)) {
      return res.status(400).json({ error: "Invalid registration status." });
    }

    const result = await run(
      "UPDATE registrations SET status=? WHERE id=?",
      [status, Number(req.params.id)]
    );

    res.json({ ok: Number(result.rowsAffected) > 0 });
  })
);

// Admin scores

app.put("/api/admin/scores/:teamId", requireAuth, requireAdmin,
  asyncHandler(async (req, res) => {
    const { wwcd, kills, points } = req.body || {};

    if (![wwcd, kills, points].every(
      v => Number.isInteger(Number(v)) && Number(v) >= 0
    )) {
      return res.status(400).json({
        error: "Scores must be non-negative whole numbers."
      });
    }

    await run(`
      INSERT INTO scores(team_id,wwcd,kills,points)
      VALUES(?,?,?,?)
      ON CONFLICT(team_id) DO UPDATE SET
      wwcd=excluded.wwcd,
      kills=excluded.kills,
      points=excluded.points
    `, [
      Number(req.params.teamId),
      Number(wwcd),
      Number(kills),
      Number(points)
    ]);

    res.json({ ok: true });
  })
);

app.get("/api/admin/teams", requireAuth, requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await all(`
      SELECT t.id,t.name,t.captain_name AS captain,
      s.wwcd,s.kills,s.points
      FROM teams t
      LEFT JOIN scores s ON s.team_id=t.id
      ORDER BY s.points DESC
    `));
  })
);

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((err, req, res, next) => {
  console.error("Server error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal server error." });
});

const port = Number(process.env.PORT || 3000);

initializeDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`TFT AGENCY running on port ${port}`);
    });
  })
  .catch(err => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });
