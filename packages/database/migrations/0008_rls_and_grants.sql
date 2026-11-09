-- 0008: row-level security and role grants
--
-- Roles (created by the migration runner, idempotently):
--   ae_identity  NOBYPASSRLS? No: BYPASSRLS. Used ONLY by the identity package for
--                registration, login, session resolution and revocation, where no
--                workspace context exists yet. It is granted only identity tables.
--   ae_app       NOBYPASSRLS. Used for everything else. Every query runs inside a
--                transaction that has set app.user_id / app.workspace_id /
--                app.identity_id. Missing context => policies evaluate to NULL => no rows.
--
-- Deny-by-default: RLS is ENABLED and FORCED on every tenant table, and ae_app
-- gets no table privileges beyond those listed here.

-- ---------------------------------------------------------------- identity
GRANT USAGE ON SCHEMA public TO ae_identity, ae_app;

GRANT SELECT, INSERT, UPDATE ON users TO ae_identity;
GRANT SELECT, INSERT, UPDATE ON acting_identities TO ae_identity;
GRANT SELECT, INSERT, UPDATE ON sessions TO ae_identity;
GRANT SELECT, INSERT ON login_attempts TO ae_identity;
GRANT USAGE, SELECT ON SEQUENCE login_attempts_id_seq TO ae_identity;
GRANT SELECT, INSERT ON audit_events TO ae_identity;
GRANT SELECT, INSERT ON workspaces TO ae_identity;            -- personal workspace at registration
GRANT SELECT, INSERT ON workspace_memberships TO ae_identity;

-- ae_app may see itself and co-members (display names) but never credentials.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
GRANT SELECT (id, email, display_name, status, platform_role, mfa_enabled, created_at, updated_at, deleted_at)
  ON users TO ae_app;
GRANT UPDATE (display_name, status) ON users TO ae_app;
CREATE POLICY users_self_or_comember ON users FOR SELECT TO ae_app
  USING (
    id = app_current_user_id()
    OR EXISTS (
      SELECT 1 FROM workspace_memberships m1
      JOIN workspace_memberships m2 ON m1.workspace_id = m2.workspace_id
      WHERE m1.user_id = app_current_user_id() AND m2.user_id = users.id
    )
  );
CREATE POLICY users_self_update ON users FOR UPDATE TO ae_app
  USING (id = app_current_user_id()) WITH CHECK (id = app_current_user_id());

ALTER TABLE acting_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE acting_identities FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON acting_identities TO ae_app;
CREATE POLICY identities_visible ON acting_identities FOR SELECT TO ae_app
  USING (
    kind = 'SERVICE'
    OR user_id = app_current_user_id()
    OR delegated_by_user_id = app_current_user_id()
    OR id = app_current_identity_id()
  );
CREATE POLICY identities_delegate ON acting_identities FOR INSERT TO ae_app
  WITH CHECK (kind = 'AGENT' AND delegated_by_user_id = app_current_user_id());
CREATE POLICY identities_revoke_own ON acting_identities FOR UPDATE TO ae_app
  USING (delegated_by_user_id = app_current_user_id());

-- sessions: ae_app has no privileges at all.

-- ---------------------------------------------------------------- workspaces
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON workspaces TO ae_app;
CREATE POLICY workspaces_member_select ON workspaces FOR SELECT TO ae_app
  USING (deleted_at IS NULL AND app_is_member(id));
CREATE POLICY workspaces_owner_insert ON workspaces FOR INSERT TO ae_app
  WITH CHECK (owner_user_id = app_current_user_id());
CREATE POLICY workspaces_admin_update ON workspaces FOR UPDATE TO ae_app
  USING (app_member_role(id) IN ('OWNER','ADMIN'))
  WITH CHECK (app_member_role(id) IN ('OWNER','ADMIN'));

ALTER TABLE workspace_memberships ENABLE ROW LEVEL SECURITY;
-- Deliberately NOT forced: app_is_member()/app_member_role() are SECURITY DEFINER
-- functions owned by the migrator and must read memberships without recursing
-- into these policies. The migrator role is never used by the application.
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_memberships TO ae_app;
CREATE POLICY memberships_visible ON workspace_memberships FOR SELECT TO ae_app
  USING (user_id = app_current_user_id() OR app_is_member(workspace_id));
CREATE POLICY memberships_manage ON workspace_memberships FOR INSERT TO ae_app
  WITH CHECK (
    -- the creator of a new workspace adds themselves as OWNER
    (user_id = app_current_user_id() AND role = 'OWNER'
      AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = workspace_id AND w.owner_user_id = app_current_user_id()))
    OR app_member_role(workspace_id) IN ('OWNER','ADMIN')
  );
CREATE POLICY memberships_update ON workspace_memberships FOR UPDATE TO ae_app
  USING (app_member_role(workspace_id) IN ('OWNER','ADMIN'));
CREATE POLICY memberships_delete ON workspace_memberships FOR DELETE TO ae_app
  USING (app_member_role(workspace_id) IN ('OWNER','ADMIN') OR user_id = app_current_user_id());

-- ------------------------------------------------- workspace-scoped content
-- Standard tenant policy: the row's workspace must equal the request context
-- AND the current user must be a member. Both are required so a code path
-- that forgets to set context, or sets the wrong one, sees nothing.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'projects','conversations','messages','context_manifests','model_runs','usage_ledger',
    'knowledge_objects','knowledge_chunks','answer_records','citations','answer_claims',
    'provenance_records','research_tasks'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO ae_app', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I TO ae_app USING (workspace_id = app_current_workspace_id() AND app_is_member(workspace_id)) WITH CHECK (workspace_id = app_current_workspace_id() AND app_is_member(workspace_id))',
      t || '_tenant', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE usage_ledger_id_seq TO ae_app;

-- authorization_decisions: workspace may be NULL for account-level actions.
ALTER TABLE authorization_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE authorization_decisions FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON authorization_decisions TO ae_app;
CREATE POLICY authz_decisions_tenant ON authorization_decisions TO ae_app
  USING (
    (workspace_id IS NOT NULL AND workspace_id = app_current_workspace_id() AND app_is_member(workspace_id))
    OR (workspace_id IS NULL AND acting_identity_id = app_current_identity_id())
  )
  WITH CHECK (
    (workspace_id IS NULL) OR (workspace_id = app_current_workspace_id())
  );

-- audit_events: insert from any context; read limited to workspace admins or the actor.
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON audit_events TO ae_app;
CREATE POLICY audit_insert ON audit_events FOR INSERT TO ae_app WITH CHECK (true);
CREATE POLICY audit_read ON audit_events FOR SELECT TO ae_app
  USING (
    actor_user_id = app_current_user_id()
    OR (workspace_id IS NOT NULL AND app_member_role(workspace_id) IN ('OWNER','ADMIN'))
  );

-- ---------------------------------------------------- platform-global tables
-- Readable by the app; mutated only through code paths that require
-- PLATFORM_ADMIN (enforced by centralized authorization, tested).
GRANT SELECT, INSERT, UPDATE ON providers TO ae_app;
GRANT SELECT, INSERT, UPDATE ON model_versions TO ae_app;
GRANT SELECT, INSERT ON model_status_changes TO ae_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs TO ae_app;
GRANT SELECT, INSERT, UPDATE ON evaluation_suites, evaluation_cases, evaluation_runs, evaluation_results TO ae_app;
