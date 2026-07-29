const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { SCHEMA_SQL } = require("./schema");

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch (_) {
    return fallback;
  }
}

class SqliteStore {
  constructor(databasePath) {
    this.databasePath = path.resolve(databasePath);
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA_SQL);
  }

  close() {
    this.db.close();
  }

  createJob({ type, state, payload = {}, id = randomUUID() }) {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO jobs (id, type, state, payload_json, result_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, '{}', ?, ?)
    `).run(id, type, state, JSON.stringify(payload), timestamp, timestamp);
    return this.getJob(id);
  }

  getJob(id) {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? this.mapJob(row) : null;
  }

  updateJob(id, patch) {
    const current = this.getJob(id);
    if (!current) {
      throw new Error("Job not found: " + id);
    }

    const next = {
      state: patch.state || current.state,
      payload: patch.payload === undefined ? current.payload : patch.payload,
      result: patch.result === undefined ? current.result : patch.result,
      error: patch.error === undefined ? current.error : String(patch.error || ""),
      attempts: patch.attempts === undefined ? current.attempts : Number(patch.attempts || 0),
      notBeforeMs: patch.notBeforeMs === undefined ? current.notBeforeMs : Number(patch.notBeforeMs || 0),
      lockedUntilMs: patch.lockedUntilMs === undefined ? current.lockedUntilMs : Number(patch.lockedUntilMs || 0)
    };

    this.db.prepare(`
      UPDATE jobs
      SET state = ?, payload_json = ?, result_json = ?, error = ?, attempts = ?,
          not_before_ms = ?, locked_until_ms = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.state,
      JSON.stringify(next.payload),
      JSON.stringify(next.result),
      next.error,
      next.attempts,
      next.notBeforeMs,
      next.lockedUntilMs,
      nowIso(),
      id
    );

    return this.getJob(id);
  }

  claimNextJob({ type, states, leaseMs = 60000, nowMs = Date.now() }) {
    const candidateStates = Array.isArray(states) && states.length ? states : ["pending"];
    const placeholders = candidateStates.map(() => "?").join(", ");
    const row = this.db.prepare(`
      SELECT * FROM jobs
      WHERE type = ?
        AND state IN (${placeholders})
        AND not_before_ms <= ?
        AND locked_until_ms <= ?
      ORDER BY created_at ASC
      LIMIT 1
    `).get(type, ...candidateStates, nowMs, nowMs);

    if (!row) {
      return null;
    }

    this.db.prepare(`
      UPDATE jobs
      SET locked_until_ms = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND locked_until_ms <= ?
    `).run(nowMs + leaseMs, nowIso(), row.id, nowMs);

    return this.getJob(row.id);
  }

  listJobs({ type, limit = 50 } = {}) {
    const boundedLimit = Math.max(1, Math.min(Number(limit || 50), 500));
    const rows = type
      ? this.db.prepare("SELECT * FROM jobs WHERE type = ? ORDER BY created_at DESC LIMIT ?").all(type, boundedLimit)
      : this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(boundedLimit);
    return rows.map((row) => this.mapJob(row));
  }

  upsertCaptureSession(session) {
    const timestamp = nowIso();
    const existing = this.getCaptureSession(session.id);
    if (existing) {
      this.db.prepare(`
        UPDATE capture_sessions
        SET state = ?, requested_name = ?, discord_thread_id = ?, discord_thread_name = ?,
            apps_script_session_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        session.state,
        session.requestedName || "",
        session.discordThreadId || "",
        session.discordThreadName || "",
        JSON.stringify(session.appsScriptSession || {}),
        timestamp,
        session.id
      );
    } else {
      this.db.prepare(`
        INSERT INTO capture_sessions (
          id, state, requested_name, discord_thread_id, discord_thread_name,
          apps_script_session_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.id,
        session.state,
        session.requestedName || "",
        session.discordThreadId || "",
        session.discordThreadName || "",
        JSON.stringify(session.appsScriptSession || {}),
        timestamp,
        timestamp
      );
    }
    return this.getCaptureSession(session.id);
  }

  getCaptureSession(id) {
    const row = this.db.prepare("SELECT * FROM capture_sessions WHERE id = ?").get(id);
    return row ? this.mapCaptureSession(row) : null;
  }

  findCaptureSessionByDiscordThreadId(threadId, states) {
    const normalizedThreadId = String(threadId || "").trim();
    if (!normalizedThreadId) {
      return null;
    }
    if (Array.isArray(states) && states.length) {
      const placeholders = states.map(() => "?").join(", ");
      const row = this.db.prepare(`
        SELECT * FROM capture_sessions
        WHERE discord_thread_id = ? AND state IN (${placeholders})
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(normalizedThreadId, ...states);
      return row ? this.mapCaptureSession(row) : null;
    }

    const row = this.db.prepare(`
      SELECT * FROM capture_sessions
      WHERE discord_thread_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(normalizedThreadId);
    return row ? this.mapCaptureSession(row) : null;
  }

  listCaptureSessions({ states, limit = 25 } = {}) {
    const boundedLimit = Math.max(1, Math.min(Number(limit || 25), 250));
    if (Array.isArray(states) && states.length) {
      const placeholders = states.map(() => "?").join(", ");
      return this.db.prepare(`
        SELECT * FROM capture_sessions
        WHERE state IN (${placeholders})
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(...states, boundedLimit).map((row) => this.mapCaptureSession(row));
    }

    return this.db.prepare(`
      SELECT * FROM capture_sessions
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(boundedLimit).map((row) => this.mapCaptureSession(row));
  }

  findLatestCaptureSessionByStates(states) {
    return this.listCaptureSessions({ states, limit: 1 })[0] || null;
  }

  mapJob(row) {
    return {
      id: row.id,
      type: row.type,
      state: row.state,
      payload: parseJson(row.payload_json, {}),
      result: parseJson(row.result_json, {}),
      error: row.error || "",
      attempts: Number(row.attempts || 0),
      notBeforeMs: Number(row.not_before_ms || 0),
      lockedUntilMs: Number(row.locked_until_ms || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  mapCaptureSession(row) {
    return {
      id: row.id,
      state: row.state,
      requestedName: row.requested_name || "",
      discordThreadId: row.discord_thread_id || "",
      discordThreadName: row.discord_thread_name || "",
      appsScriptSession: parseJson(row.apps_script_session_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

module.exports = {
  SqliteStore
};
