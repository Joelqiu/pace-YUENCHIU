PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  join_code TEXT NOT NULL UNIQUE,
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 60),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active')),
  joined_at TEXT NOT NULL,
  UNIQUE (class_id, user_id),
  UNIQUE (class_id, alias)
);

CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  target_minutes INTEGER NOT NULL CHECK (target_minutes BETWEEN 1 AND 180),
  activity_type TEXT NOT NULL CHECK (activity_type IN ('walk', 'run', 'mixed', 'other')),
  activity_plan TEXT NOT NULL DEFAULT '',
  class_goal_minutes INTEGER CHECK (class_goal_minutes IS NULL OR class_goal_minutes BETWEEN 1 AND 1000000),
  created_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  seconds INTEGER NOT NULL CHECK (seconds BETWEEN 1 AND 43200),
  meters REAL NOT NULL CHECK (meters BETWEEN 0 AND 500000),
  effort TEXT NOT NULL DEFAULT '' CHECK (effort IN ('', 'easy', 'moderate', 'hard')),
  reflection TEXT NOT NULL DEFAULT '' CHECK (length(reflection) <= 200),
  point_count INTEGER NOT NULL CHECK (point_count BETWEEN 0 AND 200000),
  created_at TEXT NOT NULL,
  UNIQUE (member_id, lesson_id),
  UNIQUE (user_id, client_id)
);

CREATE TABLE IF NOT EXISTS live_sessions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'finished')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  expires_at INTEGER NOT NULL,
  UNIQUE (owner_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id, status);
CREATE INDEX IF NOT EXISTS idx_activities_lesson ON activities(lesson_id, member_id);
CREATE INDEX IF NOT EXISTS idx_live_class_status ON live_sessions(class_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_live_owner ON live_sessions(owner_id, expires_at);
