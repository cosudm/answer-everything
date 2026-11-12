import { describe, expect, it } from "vitest";
import { parseSignupAllowlist, signupAllowed } from "./signup.js";

describe("sign-up allowlist", () => {
  it("is open when nothing is configured", () => {
    expect(parseSignupAllowlist(undefined)).toBeNull();
    expect(parseSignupAllowlist("  ,  ")).toBeNull();
    expect(signupAllowed("anyone@anywhere.test", null)).toBe(true);
  });

  it("admits listed addresses and listed domains, case-insensitively", () => {
    const list = parseSignupAllowlist("Ada@Example.com, @team.test, plain-domain.test");
    expect(signupAllowed("ada@example.com", list)).toBe(true);
    expect(signupAllowed("  ADA@EXAMPLE.COM ", list)).toBe(true);
    expect(signupAllowed("grace@team.test", list)).toBe(true);
    expect(signupAllowed("lin@plain-domain.test", list)).toBe(true);
  });

  it("refuses everyone else, including lookalike domains", () => {
    const list = parseSignupAllowlist("ada@example.com,@team.test");
    expect(signupAllowed("bob@example.com", list)).toBe(false);
    expect(signupAllowed("eve@sub.team.test", list)).toBe(false);
    expect(signupAllowed("eve@team.test.evil.test", list)).toBe(false);
    expect(signupAllowed("eve@notteam.test", list)).toBe(false);
    expect(signupAllowed("team.test", list)).toBe(false);
    expect(signupAllowed("", list)).toBe(false);
  });
});
