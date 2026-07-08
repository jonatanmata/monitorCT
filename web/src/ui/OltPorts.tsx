import { useEffect, useState } from 'react';
import type { ApiNode, OltMeta } from '../types';
import { api } from '../api';

/** Editor de puertos PON de una OLT (nombre + potencia tx dBm). Guarda en node.meta. */
export function OltPorts({ node, onChanged }: { node: ApiNode; onChanged: () => void }) {
  const [ports, setPorts] = useState<{ name: string; txDbm: number }[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const m = (node.meta ?? {}) as OltMeta;
    setPorts(m.ports?.map((p) => ({ ...p })) ?? []);
  }, [node.id, node.meta]);

  const save = async () => {
    await api.updateNode(node.id, { meta: { ports } });
    setSaved(true); setTimeout(() => setSaved(false), 2000);
    onChanged();
  };

  return (
    <div>
      <p className="card-sub" style={{ margin: '0 0 14px' }}>Cada puerto PON de la OLT con su potencia de transmisión (dBm). Las ONU conectadas por fibra a un puerto estiman su potencia recibida a partir de este valor.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 34px', gap: 8, fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.4px', fontWeight: 600 }}>
          <span>Puerto</span><span>Tx (dBm)</span><span />
        </div>
        {ports.map((p, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 110px 34px', gap: 8, alignItems: 'center' }}>
            <input className="inp" value={p.name} placeholder="pon1 / 0/1" onChange={(e) => setPorts(ports.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
            <input className="inp mono" type="number" step="0.1" value={p.txDbm} onChange={(e) => setPorts(ports.map((x, j) => j === i ? { ...x, txDbm: parseFloat(e.target.value) || 0 } : x))} />
            <button className="btn" style={{ padding: '6px 8px', color: 'var(--down)' }} onClick={() => setPorts(ports.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        {ports.length === 0 && <div className="empty-hint" style={{ padding: 0 }}>Sin puertos. Añade el primero abajo.</div>}
      </div>
      <div style={{ display: 'flex', gap: 9 }}>
        <button className="btn" onClick={() => setPorts([...ports, { name: `pon${ports.length + 1}`, txDbm: 3 }])}>+ Añadir puerto</button>
        <button className="btn primary" onClick={save}>Guardar</button>
        {saved && <span className="status-line ok" style={{ marginTop: 0, alignSelf: 'center' }}>✔ Guardado</span>}
      </div>
    </div>
  );
}
