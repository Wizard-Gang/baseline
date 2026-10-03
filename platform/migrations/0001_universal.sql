-- 0001_universal: the shared `wizardgang` D1 schema used by platform/wg-edge/storage.mjs.
-- Baseline is the only DDL owner for this database; consumers ship no migrations and no app-specific tables.
-- Every row belongs to one app (the Worker's WG_APP). Times are integer milliseconds since the epoch.
-- `body` is JSON text: TEXT affinity keeps it verbatim, and json_valid() rejects anything that is not JSON.
-- STRICT tables reject a time that is not an integer. This file is hash-pinned in pins.json once merged.

CREATE TABLE records (
  app TEXT NOT NULL CHECK (length(app) BETWEEN 1 AND 64),
  collection TEXT NOT NULL CHECK (length(collection) BETWEEN 1 AND 64),
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 256),
  body TEXT NOT NULL CHECK (json_valid(body)),
  owner TEXT CHECK (owner IS NULL OR length(owner) BETWEEN 1 AND 256),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  expires_at INTEGER CHECK (expires_at IS NULL OR expires_at > 0),
  PRIMARY KEY (app, collection, id)
) STRICT;

-- Owner lookups within a collection, in id order (records.list with an owner filter).
CREATE INDEX records_owner ON records (app, collection, owner, id) WHERE owner IS NOT NULL;

-- The TTL sweeper's per-app expiry scan.
CREATE INDEX records_expiry ON records (app, expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE events (
  app TEXT NOT NULL CHECK (length(app) BETWEEN 1 AND 64),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
  at INTEGER NOT NULL CHECK (at >= 0),
  body TEXT NOT NULL CHECK (json_valid(body)),
  expires_at INTEGER CHECK (expires_at IS NULL OR expires_at > 0)
) STRICT;

-- App-time lookups by kind, in time then insertion order (events.list with since).
CREATE INDEX events_app_time ON events (app, kind, at);

-- The TTL sweeper's per-app expiry scan.
CREATE INDEX events_expiry ON events (app, expires_at) WHERE expires_at IS NOT NULL;
