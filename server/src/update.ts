import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting, setSetting } from './db/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../..');

interface RunResult { code: number; out: string }

/** Ejecuta un comando sin bloquear el event loop y captura stdout+stderr. */
function run(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd, args, { cwd: REPO_ROOT, shell: process.platform === 'win32' });
    const timer = opts.timeoutMs
      ? setTimeout(() => { child.kill(); out += '\n[timeout]'; }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', (err) => { if (timer) clearTimeout(timer); resolve({ code: -1, out: out + String(err) }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? -1, out }); });
  });
}

async function git(args: string[], timeoutMs = 15000): Promise<RunResult> {
  return run('git', args, { timeoutMs });
}

function readVersion(): string {
  try {
    return JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version || '?';
  } catch {
    return '?';
  }
}

export function isAutoUpdateEnabled(): boolean {
  return getSetting('auto_update', 'true') === 'true';
}

export function setAutoUpdate(enabled: boolean): void {
  setSetting('auto_update', enabled ? 'true' : 'false');
}

export interface UpdateStatus {
  hasGit: boolean;
  version: string;
  currentCommit: string | null;
  currentDate: string | null;
  branch: string | null;
  updateAvailable: boolean;
  behindBy: number;
  latestMessage: string | null;
  autoUpdate: boolean;
  note?: string;
}

/** Consulta a GitHub si hay una versión más nueva (hace git fetch). */
export async function getUpdateStatus(): Promise<UpdateStatus> {
  const base: UpdateStatus = {
    hasGit: false, version: readVersion(), currentCommit: null, currentDate: null,
    branch: null, updateAvailable: false, behindBy: 0, latestMessage: null,
    autoUpdate: isAutoUpdateEnabled(),
  };

  const inside = await git(['rev-parse', '--is-inside-work-tree'], 5000);
  if (inside.code !== 0 || inside.out.trim() !== 'true') {
    return { ...base, note: 'El proyecto no es un repositorio git (se instaló como copia/zip). La auto-actualización requiere haberlo clonado con git.' };
  }
  base.hasGit = true;

  const [commit, date, branchRes] = await Promise.all([
    git(['rev-parse', '--short', 'HEAD']),
    git(['log', '-1', '--format=%cd', '--date=format:%Y-%m-%d %H:%M']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
  ]);
  base.currentCommit = commit.code === 0 ? commit.out.trim() : null;
  base.currentDate = date.code === 0 ? date.out.trim() : null;
  const branch = branchRes.code === 0 ? branchRes.out.trim() : 'main';
  base.branch = branch;

  const fetched = await git(['fetch', '--quiet', 'origin', branch], 20000);
  if (fetched.code !== 0) {
    return { ...base, note: 'No se pudo consultar GitHub (¿sin internet?). Se conserva la versión actual.' };
  }

  const behind = await git(['rev-list', '--count', `HEAD..origin/${branch}`]);
  const n = parseInt(behind.out.trim(), 10) || 0;
  base.behindBy = n;
  base.updateAvailable = n > 0;
  if (n > 0) {
    const msg = await git(['log', '-1', '--format=%s', `origin/${branch}`]);
    base.latestMessage = msg.code === 0 ? msg.out.trim() : null;
  }
  return base;
}

export interface ApplyResult { ok: boolean; log: string; restartRequired: boolean }

/**
 * Aplica la actualización: git pull --ff-only + npm install + npm run build.
 * No reinicia el proceso (el código nuevo se carga al reiniciar la app).
 */
export async function applyUpdate(): Promise<ApplyResult> {
  const status = await getUpdateStatus();
  if (!status.hasGit) return { ok: false, log: status.note ?? 'Sin git', restartRequired: false };

  let log = '';
  const step = async (title: string, cmd: string, args: string[], timeoutMs: number): Promise<boolean> => {
    log += `\n$ ${title}\n`;
    const r = await run(cmd, args, { timeoutMs });
    log += r.out.trim() + '\n';
    return r.code === 0;
  };

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  if (!(await step('git pull --ff-only', 'git', ['pull', '--ff-only'], 30000)))
    return { ok: false, log: log + '\n✗ Falló git pull (¿cambios locales?). No se aplicó nada.', restartRequired: false };
  if (!(await step('npm install', npm, ['install', '--no-audit', '--no-fund'], 180000)))
    return { ok: false, log: log + '\n✗ Falló npm install.', restartRequired: false };
  if (!(await step('npm run build', npm, ['run', 'build'], 180000)))
    return { ok: false, log: log + '\n✗ Falló la compilación.', restartRequired: false };

  return { ok: true, log: log + '\n✓ Actualización descargada y compilada. Reinicia la app para aplicarla.', restartRequired: true };
}
