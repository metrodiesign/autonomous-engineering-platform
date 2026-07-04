// F-Auth (§5.1 / INV-12): report the active auth method + env-shadowing warnings.
// Values are never included anywhere (redaction, INV-14).
export interface AuthWarning {
  variable: string;
  severity: 'red' | 'yellow';
  message: string;
}

export interface AuthInfo {
  method: string;
  warnings: AuthWarning[];
}

export function detectAuth(env: Record<string, string | undefined>): AuthInfo {
  const warnings: AuthWarning[] = [];
  if (env.ANTHROPIC_API_KEY) {
    warnings.push({
      variable: 'ANTHROPIC_API_KEY',
      severity: 'red',
      message:
        'ANTHROPIC_API_KEY is set and silently wins over your Max subscription — every run bills the API. ' +
        'Unset it yourself (the platform never deletes env vars for you): `unset ANTHROPIC_API_KEY`',
    });
  }
  if (env.ANTHROPIC_AUTH_TOKEN) {
    warnings.push({
      variable: 'ANTHROPIC_AUTH_TOKEN',
      severity: 'red',
      message: 'ANTHROPIC_AUTH_TOKEN overrides subscription login. Unset it if you intend to bill the Max plan.',
    });
  }
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    warnings.push({
      variable: 'CLAUDE_CODE_OAUTH_TOKEN',
      severity: 'yellow',
      message: 'CLAUDE_CODE_OAUTH_TOKEN (setup-token) is active — fine for services, but check it is intended on this machine.',
    });
  }
  const method = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN
    ? 'api-key (shadowing subscription)'
    : env.CLAUDE_CODE_OAUTH_TOKEN
      ? 'oauth-token (setup-token)'
      : 'subscription (credential chain)';
  return { method, warnings };
}
