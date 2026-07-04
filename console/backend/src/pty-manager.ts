// F-Term backend (§4.1 / INV-17): backend-owned PTYs running the REAL `claude` binary.
// PTY lifetime is decoupled from any browser tab; every spawn is audited; reap on close.
import pty from 'node-pty';
import { randomBytes } from 'node:crypto';

export interface TermSession {
  id: string;
  cwd: string;
  mode: 'claude-only' | 'full-shell';
  createdAt: number;
  alive: boolean;
}

export interface SpawnOptions {
  cwd: string;
  /** resume an existing CLI session id via `claude --resume` */
  resume?: string;
  /** default claude-only (§4.1); full shell is explicit opt-in */
  mode?: 'claude-only' | 'full-shell';
  cols?: number;
  rows?: number;
  extraArgs?: string[];
}

export interface AuditSink {
  (event: { type: string; termId: string; cwd?: string; mode?: string; ts: number }): void;
}

interface Entry {
  meta: TermSession;
  p: pty.IPty;
  ring: string;
  listeners: Map<string, (data: string) => void>;
}

const RING_MAX = 400_000;

export class PtyManager {
  private entries = new Map<string, Entry>();
  private spawnTimes: number[] = [];

  constructor(private audit: AuditSink, private maxSpawnsPer10s = 5) {}

  spawn(opts: SpawnOptions): TermSession {
    const now = Date.now();
    this.spawnTimes = this.spawnTimes.filter((t) => now - t < 10_000);
    if (this.spawnTimes.length >= this.maxSpawnsPer10s) {
      throw new Error('PTY spawn rate limit exceeded (§13.3 F-Term)');
    }
    this.spawnTimes.push(now);

    const id = `term-${randomBytes(5).toString('hex')}`;
    const mode = opts.mode ?? 'claude-only';
    const env = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>;
    // interactive parity = the machine's real config; do NOT strip user env here (unlike the adapter)
    const [cmd, args] =
      mode === 'full-shell'
        ? [process.env.SHELL ?? '/bin/zsh', [] as string[]]
        : ['claude', [...(opts.resume ? ['--resume', opts.resume] : []), ...(opts.extraArgs ?? [])]];

    const p = pty.spawn(cmd, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 36,
      cwd: opts.cwd,
      env,
    });
    const meta: TermSession = { id, cwd: opts.cwd, mode, createdAt: now, alive: true };
    const entry: Entry = { meta, p, ring: '', listeners: new Map() };
    p.onData((data) => {
      entry.ring = (entry.ring + data).slice(-RING_MAX);
      for (const fn of entry.listeners.values()) fn(data);
    });
    p.onExit(() => {
      meta.alive = false;
      this.audit({ type: 'PTY_EXIT', termId: id, ts: Date.now() });
    });
    this.entries.set(id, entry);
    this.audit({ type: 'PTY_SPAWN', termId: id, cwd: opts.cwd, mode, ts: now });
    return meta;
  }

  list(): TermSession[] {
    return [...this.entries.values()].map((e) => e.meta);
  }

  /** attach a consumer; returns replay buffer + detach fn. PTY survives detach (§4.1). */
  attach(id: string, onData: (data: string) => void): { replay: string; detach: () => void } {
    const e = this.mustGet(id);
    const key = randomBytes(4).toString('hex');
    e.listeners.set(key, onData);
    this.audit({ type: 'PTY_ATTACH', termId: id, ts: Date.now() });
    return {
      replay: e.ring,
      detach: () => {
        e.listeners.delete(key);
        this.audit({ type: 'PTY_DETACH', termId: id, ts: Date.now() });
      },
    };
  }

  write(id: string, data: string): void {
    this.mustGet(id).p.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.mustGet(id).p.resize(cols, rows);
  }

  kill(id: string): void {
    const e = this.mustGet(id);
    try { e.p.kill(); } catch { /* already dead */ }
    e.meta.alive = false;
    this.entries.delete(id); // reap — no zombies (§13.3)
    this.audit({ type: 'PTY_KILL', termId: id, ts: Date.now() });
  }

  killAll(): void {
    for (const id of [...this.entries.keys()]) this.kill(id);
  }

  private mustGet(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new Error(`unknown terminal ${id}`);
    return e;
  }
}
