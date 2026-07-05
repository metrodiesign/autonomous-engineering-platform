export * from './anthropic.js';
export * from './openai-compatible.js';
export * from './codex.js';
export * from './_template.js';
export * from './errors.js';

/** vendor/agent memory filenames barred from agent context (§9.4) — lives outside core (INV-7) */
export const AGENT_CONFIG_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'CLAUDE.local.md'];
