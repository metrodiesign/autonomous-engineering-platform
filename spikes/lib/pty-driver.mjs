// Minimal PTY driver for spiking the real `claude` binary (§15.2).
import pty from 'node-pty';

const ANSI = /[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
export const stripAnsi = (s) => s.replace(ANSI, '');

export function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE|CLAUDE_|AI_AGENT)/.test(k)) delete env[k];
  }
  env.TERM = 'xterm-256color';
  return env;
}

export class PtyDriver {
  constructor(cmd, args, { cwd, cols = 120, rows = 40 } = {}) {
    this.buf = '';
    this.listening = true;
    this.exited = null;
    this.p = pty.spawn(cmd, args, { name: 'xterm-256color', cols, rows, cwd, env: cleanEnv() });
    this.p.onData((d) => { if (this.listening) this.buf += d; });
    this.p.onExit((e) => { this.exited = e; });
  }

  get text() { return stripAnsi(this.buf); }

  write(s) { this.p.write(s); }

  async waitFor(re, { timeoutMs = 30000, label } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (re.test(this.text)) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`timeout waiting for ${label ?? re} — last 400 chars:\n${this.text.slice(-400)}`);
  }

  async waitExit(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.exited) return this.exited;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('timeout waiting for exit');
  }

  mark() { return this.buf.length; }
  since(mark) { return stripAnsi(this.buf.slice(mark)); }
  detach() { this.listening = false; }
  attach() { this.listening = true; }
  kill() { try { this.p.kill(); } catch {} }
}
