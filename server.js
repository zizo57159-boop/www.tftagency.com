require("dotenv").config();
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
const db = new Database(path.join(__dirname, "tft-agency.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 username TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('admin','captain')),
 team_id INTEGER,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS teams (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 captain_name TEXT NOT NULL,
 contact TEXT NOT NULL,
 players TEXT NOT NULL,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tournaments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 prize TEXT NOT NULL,
 event_date TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'Registration Open',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS registrations (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 team_id INTEGER NOT NULL,
 tournament_id INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'Pending',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(team_id,tournament_id),
 FOREIGN KEY(team_id) REFERENCES teams(id),
 FOREIGN KEY(tournament_id) REFERENCES tournaments(id)
);
CREATE TABLE IF NOT EXISTS scores (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 team_id INTEGER NOT NULL UNIQUE,
 wwcd INTEGER NOT NULL DEFAULT 0,
 kills INTEGER NOT NULL DEFAULT 0,
 points INTEGER NOT NULL DEFAULT 0,
 FOREIGN KEY(team_id) REFERENCES teams(id)
);
`);
const count = db.prepare("SELECT COUNT(*) AS n FROM tournaments").get().n;
if (!count) {
 const add = db.prepare("INSERT INTO tournaments(name,prize,event_date,status) VALUES(?,?,?,?)");
 add.run("TFT OPEN SERIES", "$100", "2026-12-05", "Registration Open");
 add.run("TFT CHAMPIONSHIP", "$250", "2026-12-12", "Coming Soon");
 add.run("TFT WEEKLY SCRIMS", "Practice", "2026-12-19", "Registration Open");
}
async function seedAdmin() {
 const username = process.env.ADMIN_USERNAME || "admin";
 const password = process.env.ADMIN_PASSWORD || "ChangeThisAdminPassword123!";
 const found = db.prepare("SELECT id FROM users WHERE username=?").get(username);
 if (!found) {
   const hash = await bcrypt.hash(password, 12);
   db.prepare("INSERT INTO users(username,password_hash,role) VALUES(?,?,?)").run(username, hash, "admin");
   console.log(`Created admin account: ${username}`);
 }
}
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "30kb" }));
app.use(session({
 secret: process.env.SESSION_SECRET || "development-only-change-me",
 resave: false, saveUninitialized: false,
 cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 8*60*60*1000 }
}));
app.use(express.static(path.join(__dirname, "public")));
const requireAuth = (req,res,next) => req.session.user ? next() : res.status(401).json({error:"Please sign in."});
const requireAdmin = (req,res,next) => req.session.user?.role === "admin" ? next() : res.status(403).json({error:"Admin access required."});

app.get("/api/tournaments", (req,res) => {
 res.json(db.prepare("SELECT id,name,prize,event_date AS date,status FROM tournaments ORDER BY event_date").all());
});
app.get("/api/leaderboard", (req,res) => {
 res.json(db.prepare(`SELECT t.name AS team,s.wwcd,s.kills,s.points FROM scores s JOIN teams t ON t.id=s.team_id ORDER BY s.points DESC,s.kills DESC`).all());
});
app.get("/api/session", (req,res) => res.json({user:req.session.user || null}));
app.post("/api/login", async (req,res) => {
 const {username,password} = req.body || {};
 if (!username || !password) return res.status(400).json({error:"Username and password are required."});
 const user = db.prepare("SELECT * FROM users WHERE username=?").get(String(username).trim());
 if (!user || !(await bcrypt.compare(String(password),user.password_hash))) return res.status(401).json({error:"Invalid username or password."});
 req.session.user = {id:user.id,username:user.username,role:user.role,teamId:user.team_id};
 res.json({user:req.session.user});
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.post("/api/register", async (req,res) => {
 const {team,captain,contact,players,tournamentId,username,password} = req.body || {};
 if (![team,captain,contact,players,username,password].every(v=>String(v||"").trim())) return res.status(400).json({error:"Complete all required fields."});
 if (String(password).length < 10) return res.status(400).json({error:"Captain password must be at least 10 characters."});
 const event = db.prepare("SELECT id,status FROM tournaments WHERE id=?").get(Number(tournamentId));
 if (!event || event.status !== "Registration Open") return res.status(400).json({error:"Registration is not open for this tournament."});
 if (db.prepare("SELECT id FROM users WHERE username=?").get(String(username).trim())) return res.status(409).json({error:"That captain username is already taken."});
 const create = db.transaction(() => {
  const teamId = db.prepare("INSERT INTO teams(name,captain_name,contact,players) VALUES(?,?,?,?)").run(String(team).trim(),String(captain).trim(),String(contact).trim(),String(players).trim()).lastInsertRowid;
  db.prepare("INSERT INTO registrations(team_id,tournament_id) VALUES(?,?)").run(teamId,event.id);
  db.prepare("INSERT INTO scores(team_id) VALUES(?)").run(teamId);
  return teamId;
 });
 try {
  const teamId = create();
  const hash = await bcrypt.hash(String(password),12);
  const userId = db.prepare("INSERT INTO users(username,password_hash,role,team_id) VALUES(?,?,?,?)").run(String(username).trim(),hash,"captain",teamId).lastInsertRowid;
  req.session.user = {id:userId,username:String(username).trim(),role:"captain",teamId};
  res.status(201).json({ok:true,user:req.session.user});
 } catch(e) { res.status(400).json({error:"Could not complete registration. Check that this team is not already registered."}); }
});
app.get("/api/captain",requireAuth,(req,res)=>{
 if(req.session.user.role!=="captain") return res.status(403).json({error:"Captain account required."});
 const team=db.prepare(`SELECT t.id,t.name,t.captain_name AS captain,t.contact,t.players,r.status AS registration_status,ev.name AS tournament,ev.event_date AS date,s.wwcd,s.kills,s.points
 FROM teams t JOIN registrations r ON r.team_id=t.id JOIN tournaments ev ON ev.id=r.tournament_id LEFT JOIN scores s ON s.team_id=t.id WHERE t.id=? ORDER BY r.id DESC LIMIT 1`).get(req.session.user.teamId);
 res.json(team||null);
});
app.post("/api/admin/tournaments",requireAuth,requireAdmin,(req,res)=>{
 const {name,prize,date,status}=req.body||{};
 if(!name||!prize||!date||!status) return res.status(400).json({error:"All tournament fields are required."});
 const id=db.prepare("INSERT INTO tournaments(name,prize,event_date,status) VALUES(?,?,?,?)").run(name,prize,date,status).lastInsertRowid;
 res.status(201).json({id});
});
app.patch("/api/admin/tournaments/:id",requireAuth,requireAdmin,(req,res)=>{
 const {status}=req.body||{};
 if(!["Registration Open","Coming Soon","Live","Completed"].includes(status)) return res.status(400).json({error:"Invalid status."});
 const result=db.prepare("UPDATE tournaments SET status=? WHERE id=?").run(status,Number(req.params.id));
 res.json({ok:result.changes>0});
});
app.delete("/api/admin/tournaments/:id",requireAuth,requireAdmin,(req,res)=>{
 const id=Number(req.params.id);
 db.prepare("DELETE FROM registrations WHERE tournament_id=?").run(id);
 const result=db.prepare("DELETE FROM tournaments WHERE id=?").run(id);
 res.json({ok:result.changes>0});
});
app.get("/api/admin/registrations",requireAuth,requireAdmin,(req,res)=>{
 res.json(db.prepare(`SELECT r.id,r.status,t.name AS team,t.captain_name AS captain,t.contact,t.players,ev.name AS tournament
 FROM registrations r JOIN teams t ON t.id=r.team_id JOIN tournaments ev ON ev.id=r.tournament_id ORDER BY r.created_at DESC`).all());
});
app.patch("/api/admin/registrations/:id",requireAuth,requireAdmin,(req,res)=>{
 const {status}=req.body||{};
 if(!["Pending","Approved","Rejected"].includes(status)) return res.status(400).json({error:"Invalid registration status."});
 const result=db.prepare("UPDATE registrations SET status=? WHERE id=?").run(status,Number(req.params.id));
 res.json({ok:result.changes>0});
});
app.put("/api/admin/scores/:teamId",requireAuth,requireAdmin,(req,res)=>{
 const {wwcd,kills,points}=req.body||{};
 if (![wwcd,kills,points].every(v=>Number.isInteger(Number(v))&&Number(v)>=0)) return res.status(400).json({error:"Scores must be non-negative whole numbers."});
 const teamId=Number(req.params.teamId);
 db.prepare(`INSERT INTO scores(team_id,wwcd,kills,points) VALUES(?,?,?,?)
 ON CONFLICT(team_id) DO UPDATE SET wwcd=excluded.wwcd,kills=excluded.kills,points=excluded.points`).run(teamId,Number(wwcd),Number(kills),Number(points));
 res.json({ok:true});
});
app.get("/api/admin/teams",requireAuth,requireAdmin,(req,res)=>{
 res.json(db.prepare(`SELECT t.id,t.name,t.captain_name AS captain,s.wwcd,s.kills,s.points FROM teams t LEFT JOIN scores s ON s.team_id=t.id ORDER BY s.points DESC`).all());
});
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
const port=Number(process.env.PORT||3000);
seedAdmin().then(()=>app.listen(port,()=>console.log(`TFT AGENCY running at http://localhost:${port}`)));
