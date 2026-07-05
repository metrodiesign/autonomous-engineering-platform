// Typed adapter errors (Ring 2). Vendor-neutral so the AAL bridge/router can branch on them
// (e.g. treat QuotaLimitError as a breaker signal, D-007 unverified adapters as no_capacity).

/** provider_data_policy violation (§7.6): a configured base URL path is outside the allowlist. */
export class ProviderDataPolicyError extends Error {
  constructor(readonly path: string, readonly allowedPaths: string[]) {
    super(`provider_data_policy: path "${path}" is not in allowedPaths [${allowedPaths.join(', ')}] (§7.6)`);
    this.name = 'ProviderDataPolicyError';
  }
}

/** adapter is a skeleton pending real credentials + conformance P1-P8 (D-007). */
export class UnverifiedAdapterError extends Error {
  constructor(msg = 'unverified: credentials required') {
    super(msg);
    this.name = 'UnverifiedAdapterError';
  }
}

/** requested base URL path against a declared provider_data_policy; throws if disallowed. */
export function enforceProviderDataPolicy(baseUrl: string, endpoint: string, allowedPaths: string[]): string {
  const path = new URL(endpoint.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).pathname;
  if (!allowedPaths.includes(path)) throw new ProviderDataPolicyError(path, allowedPaths);
  return path;
}
