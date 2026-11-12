import { describe, expect, it } from "vitest";
import { deriveSecret, fingerprint, isApiPath, resolveApiEnvironment } from "./config";

const DB = "postgres://owner:pw@db.example.com/answer?sslmode=require";

describe("resolveApiEnvironment", () => {
  it("falls back to the embedded database outside prod when it is enabled", async () => {
    const result = await resolveApiEnvironment({ AE_ENV: "uat", AE_EMBEDDED_DATABASE: "true" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.storage).toBe("embedded");
    expect(result.envVars.AE_EMBEDDED_DATABASE).toBe("true");
    expect(result.envVars.DATABASE_URL).toBeUndefined();
    // The entrypoint generates these per boot; the Worker must not invent them.
    expect(result.envVars.AE_SESSION_SECRET).toBeUndefined();
    expect(result.derived).toEqual([]);
  });

  it("never falls back to the embedded database in prod", async () => {
    const result = await resolveApiEnvironment({ AE_ENV: "prod", AE_EMBEDDED_DATABASE: "true" });
    expect(result).toEqual({ ok: false, missing: ["DATABASE_URL"] });
  });

  it("reports a missing database when the embedded fallback is off", async () => {
    const result = await resolveApiEnvironment({ AE_ENV: "uat" });
    expect(result).toEqual({ ok: false, missing: ["DATABASE_URL"] });
  });

  it("uses the external database and ignores the embedded flag once DATABASE_URL is set", async () => {
    const result = await resolveApiEnvironment({
      AE_ENV: "uat",
      AE_EMBEDDED_DATABASE: "true",
      DATABASE_URL: DB,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.storage).toBe("external");
    expect(result.envVars.DATABASE_URL).toBe(DB);
    expect(result.envVars.AE_EMBEDDED_DATABASE).toBeUndefined();
  });

  it("derives the companion secrets from DATABASE_URL outside prod", async () => {
    const result = await resolveApiEnvironment({ AE_ENV: "uat", DATABASE_URL: DB });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.derived).toEqual([
      "AE_SESSION_SECRET",
      "AE_DB_APP_PASSWORD",
      "AE_DB_IDENTITY_PASSWORD",
    ]);
    expect(result.envVars.AE_SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
    // Stable across calls, distinct per purpose, and not the connection string.
    const again = await resolveApiEnvironment({ AE_ENV: "uat", DATABASE_URL: DB });
    expect(again.ok && again.envVars.AE_SESSION_SECRET).toBe(result.envVars.AE_SESSION_SECRET);
    const values = new Set([
      result.envVars.AE_SESSION_SECRET,
      result.envVars.AE_DB_APP_PASSWORD,
      result.envVars.AE_DB_IDENTITY_PASSWORD,
    ]);
    expect(values.size).toBe(3);
    expect([...values].some((v) => v?.includes("pw"))).toBe(false);
  });

  it("keeps supplied secrets and derives only the missing ones", async () => {
    const supplied = "s".repeat(40);
    const result = await resolveApiEnvironment({
      AE_ENV: "uat",
      DATABASE_URL: DB,
      AE_SESSION_SECRET: supplied,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envVars.AE_SESSION_SECRET).toBe(supplied);
    expect(result.derived).toEqual(["AE_DB_APP_PASSWORD", "AE_DB_IDENTITY_PASSWORD"]);
  });

  it("refuses to derive secrets in prod and names what is missing", async () => {
    const result = await resolveApiEnvironment({
      AE_ENV: "prod",
      DATABASE_URL: DB,
      AE_SESSION_SECRET: "s".repeat(40),
    });
    expect(result).toEqual({
      ok: false,
      missing: ["AE_DB_APP_PASSWORD", "AE_DB_IDENTITY_PASSWORD"],
    });
  });

  it("forwards provider keys and drops empty values", async () => {
    const result = await resolveApiEnvironment({
      AE_ENV: "uat",
      AE_EMBEDDED_DATABASE: "true",
      ANTHROPIC_API_KEY: "sk-test",
      OPENAI_API_KEY: "",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envVars.ANTHROPIC_API_KEY).toBe("sk-test");
    expect("OPENAI_API_KEY" in result.envVars).toBe(false);
    expect(result.envVars.API_PORT).toBe("4000");
  });

  it("changes the fingerprint when any forwarded value changes", async () => {
    const base = await resolveApiEnvironment({ AE_ENV: "uat", AE_EMBEDDED_DATABASE: "true" });
    const withKey = await resolveApiEnvironment({
      AE_ENV: "uat",
      AE_EMBEDDED_DATABASE: "true",
      ANTHROPIC_API_KEY: "sk-test",
    });
    const same = await resolveApiEnvironment({ AE_ENV: "uat", AE_EMBEDDED_DATABASE: "true" });
    expect(base.ok && withKey.ok && same.ok).toBe(true);
    if (!base.ok || !withKey.ok || !same.ok) return;
    expect(base.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(base.fingerprint).toBe(same.fingerprint);
    expect(base.fingerprint).not.toBe(withKey.fingerprint);
  });
});

describe("deriveSecret and fingerprint", () => {
  it("binds a derived secret to both the connection string and the purpose", async () => {
    const a = await deriveSecret(DB, "AE_SESSION_SECRET");
    expect(await deriveSecret(DB, "AE_SESSION_SECRET")).toBe(a);
    expect(await deriveSecret(DB, "AE_DB_APP_PASSWORD")).not.toBe(a);
    expect(await deriveSecret(`${DB}&x=1`, "AE_SESSION_SECRET")).not.toBe(a);
  });

  it("does not depend on key order", async () => {
    expect(await fingerprint({ a: "1", b: "2" })).toBe(await fingerprint({ b: "2", a: "1" }));
  });
});

describe("isApiPath", () => {
  it("routes the API surface to the API container", () => {
    for (const path of ["/v1", "/v1/auth/me", "/v1/workspaces/x/ask", "/health"]) {
      expect(isApiPath(path)).toBe(true);
    }
  });

  it("leaves pages, assets and the metrics endpoint to the web container", () => {
    for (const path of ["/", "/login", "/_next/static/a.js", "/metrics", "/healthy", "/v10/x"]) {
      expect(isApiPath(path)).toBe(false);
    }
  });
});
