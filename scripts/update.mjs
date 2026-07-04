// Auto-actualización al arrancar: si GitHub tiene una versión nueva, la baja y
// compila antes de iniciar el servidor. TOLERANTE A FALLOS: si algo falla
// (sin internet, cambios locales, error de build), registra el problema y deja
// que la app arranque con la versión que ya tenía. NUNCA sale con código != 0.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';

function sh(cmd, args, timeout) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: isWin, timeout });
}
function gitOut(args) {
  const r = sh('git', args, 15000);
  return r.status === 0 ? (r.stdout || '').trim() : null;
}
function log(msg) { console.log(`[auto-update] ${msg}`); }

try {
  if (!existsSync(path.join(root, '.git'))) {
    log('el proyecto no es un repo git; se omite la auto-actualización.');
    process.exit(0);
  }

  // Respetar el interruptor guardado por la UI (setting auto_update en SQLite)
  try {
    const dbPath = path.join(root, 'data', 'monitorct.sqlite');
    if (existsSync(dbPath)) {
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const row = db.prepare("SELECT value FROM settings WHERE key = 'auto_update'").get();
      db.close();
      if (row && row.value === 'false') {
        log('auto-actualización desactivada en Ajustes; se omite.');
        process.exit(0);
      }
    }
  } catch { /* si no se puede leer el setting, se asume activada */ }

  const branch = gitOut(['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
  const fetch = sh('git', ['fetch', '--quiet', 'origin', branch], 20000);
  if (fetch.status !== 0) {
    log('no se pudo consultar GitHub (¿sin internet?); se arranca con la versión actual.');
    process.exit(0);
  }

  const behind = parseInt(gitOut(['rev-list', '--count', `HEAD..origin/${branch}`]) || '0', 10);
  if (!behind) {
    log('ya estás en la última versión.');
    process.exit(0);
  }

  log(`hay ${behind} actualización(es) nueva(s); descargando…`);
  if (sh('git', ['pull', '--ff-only'], 30000).status !== 0) {
    log('git pull falló (¿cambios locales sin guardar?); se arranca con la versión actual.');
    process.exit(0);
  }
  log('instalando dependencias…');
  if (sh(npm, ['install', '--no-audit', '--no-fund'], 180000).status !== 0) {
    log('npm install falló; se arranca con la versión actual.');
    process.exit(0);
  }
  log('compilando…');
  if (sh(npm, ['run', 'build'], 180000).status !== 0) {
    log('la compilación falló; se arranca con la versión anterior compilada.');
    process.exit(0);
  }
  log('✓ actualizado. Arrancando la versión nueva.');
} catch (err) {
  log(`error inesperado, se arranca igual: ${err}`);
}
process.exit(0);
