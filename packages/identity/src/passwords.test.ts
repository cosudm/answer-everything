import { describe, expect, it } from "vitest";
import { hashPassword, passwordPolicyViolation, verifyPassword } from "./passwords.js";

describe("passwords", () => {
  it("hashes and verifies", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", h)).toBe(true);
    expect(await verifyPassword("wrong horse", h)).toBe(false);
  });
  it("rejects malformed stored hashes without throwing", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
  });
  it("enforces the policy", () => {
    expect(passwordPolicyViolation("short")).toMatch(/12 characters/);
    expect(passwordPolicyViolation("passwordpassword")).toMatch(/common/);
    expect(passwordPolicyViolation("alice-rocks-2026-x", "alice@example.com")).toMatch(/email/);
    expect(passwordPolicyViolation("a perfectly fine passphrase")).toBeNull();
  });
});
