/**
 * Sign-up restriction for environments that are reachable from the internet
 * but not meant for everyone yet. Configured with AE_SIGNUP_ALLOWLIST: a
 * comma-separated list of addresses (ada@example.com) and domains
 * (@example.com). Empty or unset means anyone may create an account.
 */
export interface SignupAllowlist {
  addresses: Set<string>;
  domains: Set<string>;
}

export function parseSignupAllowlist(value: string | undefined): SignupAllowlist | null {
  const entries = (value ?? "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) return null;
  const allowlist: SignupAllowlist = { addresses: new Set(), domains: new Set() };
  for (const entry of entries) {
    if (entry.startsWith("@")) allowlist.domains.add(entry.slice(1));
    else if (entry.includes("@")) allowlist.addresses.add(entry);
    else allowlist.domains.add(entry); // a bare domain is accepted too
  }
  return allowlist;
}

export function signupAllowed(email: string, allowlist: SignupAllowlist | null): boolean {
  if (!allowlist) return true;
  const address = email.trim().toLowerCase();
  if (allowlist.addresses.has(address)) return true;
  const at = address.lastIndexOf("@");
  // Exact domain only: "@example.com" does not admit "sub.example.com".
  return at > 0 && allowlist.domains.has(address.slice(at + 1));
}
