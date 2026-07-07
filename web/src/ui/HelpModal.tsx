import { HELP } from './meta';

export function HelpModal({ helpKey, onClose }: { helpKey: string | null; onClose: () => void }) {
  if (!helpKey) return null;
  const help = HELP[helpKey] ?? { title: 'Ayuda', body: '' };
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(4,7,12,.6)', backdropFilter: 'blur(3px)' }} />
      <div style={{ position: 'relative', width: 440, maxWidth: '100%', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow)', animation: 'fadeup .18s ease', overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--accentSoft)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>?</span>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{help.title}</h3>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: '18px 20px', fontSize: 13.5, lineHeight: 1.65, color: 'var(--text2)' }}>{help.body}</div>
      </div>
    </div>
  );
}
