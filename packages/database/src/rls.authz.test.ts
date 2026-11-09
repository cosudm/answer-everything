import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseAvailable, openTestDatabase, truncateAll } from "./test-support.js";
import { withTenant, type Database } from "./client.js";

const describeDb = databaseAvailable() ? describe : describe.skip;

/**
 * Row-level security proofs. These run as the real ae_app role against the
 * migrated schema. They are the database-layer half of the release
 * threshold "zero known cross-workspace or cross-identity data exposure".
 */
describeDb("PostgreSQL row-level security", () => {
  let db: Database;
  const A = { userId: "", workspaceId: "", identityId: "" };
  const B = { userId: "", workspaceId: "", identityId: "" };
  let conversationB = "";

  beforeAll(async () => {
    db = openTestDatabase();
    await truncateAll(db);
    // Fixtures are created by the migrator (bypasses RLS) exactly like the identity service would.
    for (const [who, email] of [
      [A, "a@example.com"],
      [B, "b@example.com"],
    ] as const) {
      const u = await db.migrator.query(
        `INSERT INTO users (email, email_normalized, password_hash, display_name) VALUES ($1,$1,'x',$1) RETURNING id`,
        [email],
      );
      who.userId = u.rows[0].id;
      const i = await db.migrator.query(
        `INSERT INTO acting_identities (kind, user_id, display_name) VALUES ('USER',$1,$2) RETURNING id`,
        [who.userId, email],
      );
      who.identityId = i.rows[0].id;
      const w = await db.migrator.query(
        `INSERT INTO workspaces (slug, name, kind, owner_user_id) VALUES ($1,$1,'PERSONAL',$2) RETURNING id`,
        [email, who.userId],
      );
      who.workspaceId = w.rows[0].id;
      await db.migrator.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1,$2,'OWNER')`,
        [who.workspaceId, who.userId],
      );
    }
    const c = await db.migrator.query(
      `INSERT INTO conversations (workspace_id, created_by_user_id, title) VALUES ($1,$2,'B secret') RETURNING id`,
      [B.workspaceId, B.userId],
    );
    conversationB = c.rows[0].id;
    await db.migrator.query(
      `INSERT INTO knowledge_objects (workspace_id, kind, title, text_content, owner_user_id, status) VALUES ($1,'NOTE','B note','b secret text',$2,'READY')`,
      [B.workspaceId, B.userId],
    );
  });
  afterAll(async () => {
    await db.close();
  });

  it("app role sees nothing without a request context", async () => {
    const client = await db.app.connect();
    try {
      for (const table of [
        "conversations",
        "knowledge_objects",
        "workspaces",
        "workspace_memberships",
        "users",
        "model_runs",
        "answer_records",
      ]) {
        const r = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(r.rows[0].n, table).toBe(0);
      }
    } finally {
      client.release();
    }
  });

  it("app role has no access to sessions at all", async () => {
    await expect(db.app.query("SELECT count(*) FROM sessions")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("a member sees only their own workspace's rows", async () => {
    const seenByB = await withTenant(db.app, B, (tx) =>
      tx.query("SELECT title FROM conversations"),
    );
    expect(seenByB.rows.map((r) => r.title)).toEqual(["B secret"]);
    const seenByA = await withTenant(db.app, A, (tx) =>
      tx.query("SELECT title FROM conversations"),
    );
    expect(seenByA.rows).toEqual([]);
    const aLooksAtBDirectly = await withTenant(db.app, A, (tx) =>
      tx.query("SELECT * FROM conversations WHERE id = $1", [conversationB]),
    );
    expect(aLooksAtBDirectly.rows).toEqual([]);
    const aSearchesKnowledge = await withTenant(db.app, A, (tx) =>
      tx.query("SELECT * FROM knowledge_objects WHERE text_content ILIKE '%secret%'"),
    );
    expect(aSearchesKnowledge.rows).toEqual([]);
  });

  it("setting another workspace's id in the context does not grant access without membership", async () => {
    // A pretends to be in B's workspace: user_id is still A, so app_is_member() is false.
    const spoofed = await withTenant(db.app, { ...A, workspaceId: B.workspaceId }, (tx) =>
      tx.query("SELECT * FROM conversations"),
    );
    expect(spoofed.rows).toEqual([]);
    await expect(
      withTenant(db.app, { ...A, workspaceId: B.workspaceId }, (tx) =>
        tx.query(
          `INSERT INTO conversations (workspace_id, created_by_user_id, title) VALUES ($1,$2,'planted')`,
          [B.workspaceId, A.userId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("writes are confined to the context workspace even when the row names another", async () => {
    await expect(
      withTenant(db.app, A, (tx) =>
        tx.query(
          `INSERT INTO conversations (workspace_id, created_by_user_id, title) VALUES ($1,$2,'cross')`,
          [B.workspaceId, A.userId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenant(db.app, A, (tx) =>
        tx.query(
          `INSERT INTO knowledge_objects (workspace_id, kind, title, text_content, owner_user_id) VALUES ($1,'NOTE','x','x',$2)`,
          [B.workspaceId, A.userId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    // Legitimate write in own workspace succeeds.
    const ok = await withTenant(db.app, A, (tx) =>
      tx.query(
        `INSERT INTO conversations (workspace_id, created_by_user_id, title) VALUES ($1,$2,'mine') RETURNING id`,
        [A.workspaceId, A.userId],
      ),
    );
    expect(ok.rowCount).toBe(1);
  });

  it("updates and deletes cannot reach another workspace's rows", async () => {
    const upd = await withTenant(db.app, A, (tx) =>
      tx.query("UPDATE conversations SET title = 'hijacked' WHERE id = $1", [conversationB]),
    );
    expect(upd.rowCount).toBe(0);
    const del = await withTenant(db.app, A, (tx) =>
      tx.query("DELETE FROM conversations WHERE id = $1", [conversationB]),
    );
    expect(del.rowCount).toBe(0);
    const still = await db.migrator.query("SELECT title FROM conversations WHERE id = $1", [
      conversationB,
    ]);
    expect(still.rows[0].title).toBe("B secret");
  });

  it("users can see themselves and co-members only; never password hashes", async () => {
    const self = await withTenant(db.app, A, (tx) => tx.query("SELECT id, email FROM users"));
    expect(self.rows.map((r) => r.email)).toEqual(["a@example.com"]);
    await expect(
      withTenant(db.app, A, (tx) => tx.query("SELECT password_hash FROM users")),
    ).rejects.toThrow(/permission denied/);
    // Add A to B's workspace: now A sees B's display name (and B's rows in that workspace).
    await db.migrator.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1,$2,'VIEWER')`,
      [B.workspaceId, A.userId],
    );
    const both = await withTenant(db.app, A, (tx) =>
      tx.query("SELECT email FROM users ORDER BY email"),
    );
    expect(both.rows.map((r) => r.email)).toEqual(["a@example.com", "b@example.com"]);
    const nowVisible = await withTenant(db.app, { ...A, workspaceId: B.workspaceId }, (tx) =>
      tx.query("SELECT title FROM conversations"),
    );
    expect(nowVisible.rows.map((r) => r.title)).toEqual(["B secret"]);
    await db.migrator.query(
      `DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2`,
      [B.workspaceId, A.userId],
    );
  });

  it("viewers cannot change workspace settings (RLS), owners can", async () => {
    await db.migrator.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1,$2,'VIEWER')`,
      [B.workspaceId, A.userId],
    );
    const asViewer = await withTenant(db.app, { ...A, workspaceId: B.workspaceId }, (tx) =>
      tx.query(`UPDATE workspaces SET name = 'renamed by viewer' WHERE id = $1`, [B.workspaceId]),
    );
    expect(asViewer.rowCount).toBe(0);
    const asOwner = await withTenant(db.app, B, (tx) =>
      tx.query(`UPDATE workspaces SET name = 'renamed by owner' WHERE id = $1`, [B.workspaceId]),
    );
    expect(asOwner.rowCount).toBe(1);
    await db.migrator.query(
      `DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2`,
      [B.workspaceId, A.userId],
    );
  });

  it("audit events, provenance and authorization decisions are append-only for everyone", async () => {
    await withTenant(db.app, A, (tx) =>
      tx.query(
        `INSERT INTO audit_events (workspace_id, actor_user_id, event_type, outcome) VALUES ($1,$2,'auth.login','SUCCESS')`,
        [A.workspaceId, A.userId],
      ),
    );
    await expect(
      withTenant(db.app, A, (tx) => tx.query(`UPDATE audit_events SET outcome = 'FAILURE'`)),
    ).rejects.toThrow(/permission denied/);
    await expect(db.migrator.query(`DELETE FROM audit_events`)).rejects.toThrow(/append-only/);
    await expect(
      db.migrator.query(`UPDATE provenance_records SET event = 'x'`),
    ).resolves.toBeTruthy(); // no rows: trigger is per-row
    await db.migrator.query(
      `INSERT INTO provenance_records (workspace_id, subject_kind, subject_id, event) VALUES ($1,'MESSAGE',$2,'CREATED')`,
      [A.workspaceId, A.userId],
    );
    await expect(db.migrator.query(`DELETE FROM provenance_records`)).rejects.toThrow(
      /append-only/,
    );
  });

  it("knowledge chunks inherit isolation (vector search cannot cross workspaces)", async () => {
    const obj = await db.migrator.query(
      `SELECT id FROM knowledge_objects WHERE workspace_id = $1`,
      [B.workspaceId],
    );
    await db.migrator.query(
      `INSERT INTO knowledge_chunks (knowledge_object_id, workspace_id, ordinal, content, token_count) VALUES ($1,$2,0,'b secret chunk',3)`,
      [obj.rows[0].id, B.workspaceId],
    );
    const a = await withTenant(db.app, A, (tx) =>
      tx.query(
        `SELECT content FROM knowledge_chunks WHERE tsv @@ plainto_tsquery('english','secret')`,
      ),
    );
    expect(a.rows).toEqual([]);
    const b = await withTenant(db.app, B, (tx) =>
      tx.query(
        `SELECT content FROM knowledge_chunks WHERE tsv @@ plainto_tsquery('english','secret')`,
      ),
    );
    expect(b.rows).toHaveLength(1);
  });
});
