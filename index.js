const fs = require("fs");
const path = require("path");
const jsonServer = require("json-server");

const DB_FILE = path.join(__dirname, "db.json");

console.log("DB file:", DB_FILE);

function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
  }
  return { users: [], auth: { currentUserId: null }, garage: [], winners: [] };
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let db = loadDB();

const server = jsonServer.create();
const router = jsonServer.router(db);
const middlewares = jsonServer.defaults();
const PORT = process.env.PORT || 3000;

server.use((req, res, next) => {
  res.on("finish", () => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      saveDB(router.db.getState());
    }
  });
  next();
});

server.use(middlewares);
server.use(jsonServer.bodyParser);

server.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

function ensureSchema() {
  const state = router.db.getState() || {};
  if (!state.users) state.users = [];
  if (!state.auth) state.auth = { currentUserId: null };
  if (!state.garage) state.garage = [];
  if (!state.winners) state.winners = [];
  if (state.users && Array.isArray(state.users)) {
    state.users = state.users.map((u) => ({
      wins: 0,
      losses: 0,
      ...u,
      wins: typeof u.wins === "number" ? u.wins : 0,
      losses: typeof u.losses === "number" ? u.losses : 0,
    }));
  }
  router.db.setState(state);
  saveDB(state);
}
ensureSchema();

function getCurrentUserId() {
  const s = router.db.getState();
  return s.auth?.currentUserId ?? null;
}
function setCurrentUserId(uid) {
  const s = router.db.getState();
  s.auth = s.auth || {};
  s.auth.currentUserId = uid;
  router.db.setState(s);
  saveDB(s);
}

function bumpUserStats(uid, { winDelta = 0, lossDelta = 0 } = {}) {
  const user = router.db.get("users").find({ id: uid }).value();
  if (!user) return null;
  const wins = (user.wins || 0) + winDelta;
  const losses = (user.losses || 0) + lossDelta;
  router.db.get("users").find({ id: uid }).assign({ wins, losses }).write();
  saveDB(router.db.getState());
  return { wins, losses };
}

function nextIdFor(col) {
  const list = router.db.get(col).value() || [];
  return list.length ? Math.max(...list.map((x) => x.id || 0)) + 1 : 1;
}

server.post("/auth/signup", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).send("username & password required");
  const exists = router.db.get("users").find({ username }).value();
  if (exists) return res.status(409).send("Username already exists");
  const user = {
    id: nextIdFor("users"),
    username,
    password,
    wins: 0,
    losses: 0,
  };
  router.db.get("users").push(user).write();
  setCurrentUserId(user.id);
  res.status(201).json({ id: user.id, username: user.username });
});

server.post("/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).send("username & password required");
  const user = router.db.get("users").find({ username, password }).value();
  if (!user) return res.status(401).send("Invalid credentials");
  const needsPatch =
    typeof user.wins !== "number" || typeof user.losses !== "number";
  if (needsPatch) {
    router.db
      .get("users")
      .find({ id: user.id })
      .assign({ wins: user.wins ?? 0, losses: user.losses ?? 0 })
      .write();
  }
  setCurrentUserId(user.id);
  res.json({ id: user.id, username: user.username });
});

server.get("/auth/current", (_req, res) => {
  const uid = getCurrentUserId();
  if (!uid) return res.json({ user: null });
  const user = router.db.get("users").find({ id: uid }).value();
  res.json({ user: user ? { id: user.id, username: user.username } : null });
});

server.post("/auth/logout", (_req, res) => {
  setCurrentUserId(null);
  res.json({ success: true });
});

server.get("/stats/me", (_req, res) => {
  const uid = getCurrentUserId();
  if (!uid) return res.status(401).send("Not logged in");
  const user = router.db.get("users").find({ id: uid }).value();
  if (!user) return res.status(404).send("User not found");
  res.json({ wins: user.wins || 0, losses: user.losses || 0 });
});

server.post("/stats/result", (req, res) => {
  const uid = getCurrentUserId();
  if (!uid) return res.status(401).send("Not logged in");

  const { chosenCarId, winnerCarId } = req.body || {};
  if (typeof chosenCarId !== "number" || typeof winnerCarId !== "number") {
    return res
      .status(400)
      .send("chosenCarId and winnerCarId (numbers) are required");
  }

  const correct = +chosenCarId === +winnerCarId;
  const stats = bumpUserStats(uid, {
    winDelta: correct ? 1 : 0,
    lossDelta: correct ? 0 : 1,
  });
  res.json({ correct, ...stats });
});

server.use((req, res, next) => {
  const uid = getCurrentUserId();

  if (req.path.startsWith("/auth") || req.path.startsWith("/engine"))
    return next();

  if (req.path.startsWith("/garage") || req.path.startsWith("/winners")) {
    if (!uid) return res.status(401).send("Not logged in");

    if (req.method === "POST") {
      req.body = req.body || {};
      req.body.userId = uid;
    }

    if (
      req.method === "GET" &&
      (req.path === "/garage" || req.path === "/winners")
    ) {
      const col = req.path.slice(1);
      const all = router.db.get(col).value() || [];
      const mine = all.filter((x) => x.userId === uid);
      return res.json(mine);
    }

    const m = req.path.match(/^\/(garage|winners)\/(\d+)$/);
    if (m) {
      const col = m[1];
      const id = +m[2];
      const item = router.db.get(col).find({ id }).value();
      if (!item || item.userId !== uid)
        return res.status(404).send("Not found");
      if (req.method === "PUT" || req.method === "PATCH") {
        req.body = req.body || {};
        req.body.userId = uid;
      }
    }
  }
  next();
});

const state = { velocity: {}, blocked: {} };
const STATUS = { STARTED: "started", STOPPED: "stopped", DRIVE: "drive" };

server.patch("/engine", (req, res) => {
  const { id, status } = req.query;
  const uid = getCurrentUserId();

  if (!id || Number.isNaN(+id) || +id <= 0) {
    return res
      .status(400)
      .send('Required parameter "id" is missing. Should be a positive number');
  }
  if (!status || !/^(started|stopped|drive)$/.test(status)) {
    return res
      .status(400)
      .send(
        'Wrong parameter "status". Expected: "started", "stopped" or "drive".'
      );
  }
  if (!uid) return res.status(401).send("Not logged in");

  const car = router.db.get("garage").find({ id: +id, userId: uid }).value();
  if (!car)
    return res
      .status(404)
      .send("Car with such id was not found for current user.");

  const distance = 500000;

  if (status === STATUS.DRIVE) {
    if (state.blocked[id])
      return res.status(429).send("Drive already in progress for this car.");
    const velocity = state.velocity[id];
    if (!velocity)
      return res.status(404).send('Start engine first with status "started".');

    state.blocked[id] = true;
    const x = Math.round(distance / velocity);
    delete state.velocity[id];

    if (new Date().getMilliseconds() % 3 === 0) {
      setTimeout(() => {
        delete state.blocked[id];
        res
          .header("Content-Type", "application/json")
          .status(500)
          .send("Car has been stopped suddenly. It's engine was broken down.");
      }, (Math.random() * x) ^ 0);
    } else {
      setTimeout(() => {
        delete state.blocked[id];
        res
          .header("Content-Type", "application/json")
          .status(200)
          .send(JSON.stringify({ success: true }));
      }, x);
    }
  } else {
    const x = req.query.speed ? +req.query.speed : (Math.random() * 2000) ^ 0;
    const velocity =
      status === STATUS.STARTED ? Math.max(50, (Math.random() * 200) ^ 0) : 0;

    if (velocity) {
      state.velocity[id] = velocity;
    } else {
      delete state.velocity[id];
      delete state.blocked[id];
    }

    setTimeout(
      () =>
        res
          .header("Content-Type", "application/json")
          .status(200)
          .send(JSON.stringify({ velocity, distance })),
      x
    );
  }
});

server.delete("/auth/me", (_req, res) => {
  const uid = getCurrentUserId();
  if (!uid) return res.status(401).send("Not logged in");

  router.db.get("garage").remove({ userId: uid }).write();
  router.db.get("winners").remove({ userId: uid }).write();

  router.db.get("users").remove({ id: uid }).write();

  setCurrentUserId(null);

  saveDB(router.db.getState());
  res.json({ success: true });
});

server.use(router);
server.listen(PORT, () => console.log("Server on", PORT));
