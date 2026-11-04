/**
 * The `evidence/` barrel: source registry, external documents, catalog and the
 * multi-generation view. Types remain declared in `contracts/`; this barrel
 * only re-exports them.
 */

export { buildCatalog, MAX_CATALOG_LINES } from "./catalog.js";
export type { EvidenceCatalogEntry } from "./catalog.js";

export {
  createExternalDocService,
  MAX_EXTERNAL_BYTES,
  MAX_REDIRECT_HOPS,
} from "./external.js";
export type {
  ExternalDocService,
  ExternalDocServiceDeps,
  ExternalFetchRequest,
  ExternalFetchResult,
} from "./external.js";

export { createSourceReader } from "./registry.js";
export type { SourceReaderDeps } from "./registry.js";

export { allowedCommitShas, multiView } from "./multi-view.js";
export type { GenerationSourceView } from "./multi-view.js";

export {
  createSourceRegistry,
  repoSourceId,
  sourceRowFromRef,
} from "./registry.js";
export type {
  RegisterRepoSourceInput,
  SourceRegistry,
  SourceRegistryDeps,
  SourceRegistryInternals,
} from "./registry.js";

export {
  ALLOWED_EXTERNAL_HOSTS,
  assertPublicUrl,
  isBlockedAddress,
} from "./ssrf.js";
