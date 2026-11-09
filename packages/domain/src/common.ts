import { z } from "zod";

/** UUID v4/v7 identifier. Every entity carries an explicit id; never positional. */
export const Id = z.string().uuid();
export type Id = z.infer<typeof Id>;

/** ISO-8601 timestamp string (UTC). */
export const Timestamp = z.string().datetime({ offset: true });
export type Timestamp = z.infer<typeof Timestamp>;

/**
 * Privacy classification applied to every piece of information the platform
 * holds. Models declare which classes they may receive; authorization filters
 * retrieval *before* context assembly so that a model never sees data above
 * its clearance.
 *
 *  PUBLIC        - publicly available material (web, public docs)
 *  INTERNAL      - workspace material that may be shared with any approved model
 *  CONFIDENTIAL  - workspace material restricted to providers with contractual
 *                  no-training / no-retention guarantees
 *  RESTRICTED    - may only be processed by private / dedicated deployments
 */
export const PrivacyClass = z.enum(["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]);
export type PrivacyClass = z.infer<typeof PrivacyClass>;

export const PRIVACY_RANK: Record<PrivacyClass, number> = {
  PUBLIC: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
};

export function highestPrivacyClass(classes: PrivacyClass[]): PrivacyClass {
  let best: PrivacyClass = "PUBLIC";
  for (const c of classes) if (PRIVACY_RANK[c] > PRIVACY_RANK[best]) best = c;
  return best;
}

export const Metadata = z.record(z.string(), z.unknown());
export type Metadata = z.infer<typeof Metadata>;

export const Page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
