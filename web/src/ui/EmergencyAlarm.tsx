import { useEffect, useRef, useState } from 'react';
import { Icon } from './meta';

export interface EmergencyItem { nodeId: number; name: string; message: string }

export interface AlarmCfg { enabled: boolean; intervalSec: number; allDevices: boolean }
export const DEFAULT_ALARM: AlarmCfg = { enabled: true, intervalSec: 10, allDevices: false };

export function loadAlarmCfg(): AlarmCfg {
  try { return { ...DEFAULT_ALARM, ...JSON.parse(localStorage.getItem('mct-alarm') || '{}') }; }
  catch { return DEFAULT_ALARM; }
}
export function saveAlarmCfg(cfg: AlarmCfg): void { localStorage.setItem('mct-alarm', JSON.stringify(cfg)); }

// Un único AudioContext reutilizado (se crea en el primer bip; se reanuda si el navegador lo suspendió).
let audioCtx: AudioContext | null = null;
function beep(): void {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const ctx = audioCtx;
    if (ctx.state === 'suspended') void ctx.resume();
    // Dos tonos cortos tipo sirena.
    [0, 0.22].forEach((offset, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = 'square';
      o.frequency.value = i === 0 ? 880 : 660;
      const t = ctx.currentTime + offset;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.start(t); o.stop(t + 0.2);
    });
  } catch { /* audio no disponible */ }
}

/** Reproduce un bip de prueba (botón «Probar sonido» en Ajustes). */
export function testAlarmSound(): void { beep(); }

export function EmergencyAlarm({ items, intervalSec, onAck }: { items: EmergencyItem[]; intervalSec: number; onAck: () => void }) {
  const [muted, setMuted] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (items.length === 0 || muted) {
      if (timer.current) { clearInterval(timer.current); timer.current = null; }
      return;
    }
    beep(); // inmediato al aparecer
    timer.current = setInterval(beep, Math.max(2, intervalSec) * 1000);
    return () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } };
  }, [items.length, muted, intervalSec]);

  useEffect(() => { setMuted(false); }, [items.length]); // un equipo nuevo vuelve a sonar

  if (items.length === 0) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(60,4,10,.55)', backdropFilter: 'blur(3px)' }} />
      <div style={{ position: 'relative', width: 460, maxWidth: '100%', background: 'var(--panel)', border: '2px solid var(--down)', borderRadius: 16, boxShadow: '0 0 0 6px var(--downSoft), var(--shadow)', overflow: 'hidden', animation: 'fadeup .18s ease' }}>
        <div style={{ padding: '16px 20px', background: 'var(--downSoft)', borderBottom: '1px solid var(--down)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--down)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'blink 1s infinite' }}>
            <Icon path="M12 3l9 16H3zM12 10v4M12 17h.01" size={20} strokeWidth={2} />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--down)' }}>⚠ Emergencia · equipo caído</div>
            <div style={{ fontSize: 11.5, color: 'var(--text2)' }}>{items.length} equipo{items.length > 1 ? 's' : ''} de infraestructura sin respuesta</div>
          </div>
          <button className="icon-btn" title={muted ? 'Sonido silenciado' : 'Silenciar sonido'} onClick={() => setMuted((m) => !m)}>
            {muted ? '🔇' : '🔊'}
          </button>
        </div>
        <div style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 320, overflowY: 'auto' }}>
          {items.map((it) => (
            <div key={it.nodeId} style={{ background: 'var(--panel2)', border: '1px solid var(--border)', borderLeft: '3px solid var(--down)', borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{it.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>{it.message}</div>
            </div>
          ))}
        </div>
        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10 }}>
          <button className="btn danger" style={{ flex: 1, height: 42, fontSize: 14 }} onClick={onAck}>Aceptar y silenciar</button>
        </div>
      </div>
    </div>
  );
}
