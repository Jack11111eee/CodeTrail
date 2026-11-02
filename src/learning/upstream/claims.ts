/**
 * The upstream claims port (build side, architecture §6.3).
 *
 * A staged wiki ref has no sealed row, so this port never calls
 * `assertPublished`; it reads the page tree and the `.claims` sidecars below the
 * knowledge root. `repo://path#Lx-Ly` resources stay verbatim: the lesson
 * layer turns them into `RepoSourceRef`s, and evidence versions are opaque
 * strings that are stored, never interpreted.
 */

import { ClaimsStore } from "../../claims/brains/code/store.js";
import type {
  ClaimView,
  UpstreamClaimsPort,
  WikiRef,
} from "../contracts/index.js";
import { mapUpstreamError } from "./generation.js";

// Declared in contracts/upstream.ts (§3.15); re-export only.
export type { ClaimView, WikiRef };

/** Implements `UpstreamClaimsPort` (§3.15, §6.3). */
export function createUpstreamClaimsPort(): UpstreamClaimsPort {
  return {
    async pages(ref: WikiRef): Promise<string[]> {
      try {
        return await new ClaimsStore(ref.knowledgeDir).discoverPages();
      } catch (error) {
        mapUpstreamError(error);
      }
    },

    async claimsFor(ref: WikiRef, page: string): Promise<ClaimView[]> {
      try {
        const persisted = await new ClaimsStore(ref.knowledgeDir).loadPage(
          page,
        );
        if (persisted === null) return [];
        return persisted.claims.map((claim) => ({
          id: claim.id,
          statement: claim.statement,
          evidence: claim.evidence.map((entry) => ({
            resource: entry.resource,
            version: entry.version,
          })),
        }));
      } catch (error) {
        mapUpstreamError(error);
      }
    },

    async markdown(ref: WikiRef, page: string): Promise<string> {
      try {
        return await new ClaimsStore(ref.knowledgeDir).readMarkdown(page);
      } catch (error) {
        mapUpstreamError(error);
      }
    },
  };
}
