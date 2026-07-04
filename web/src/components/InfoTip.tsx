import { useState } from 'react';

/**
 * Icono de ayuda «!»: al pasar el mouse o tocarlo muestra una explicación
 * del módulo o campo junto al que está.
 */
export function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="infotip"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={(e) => {
        e.stopPropagation();
        setOpen((v) => !v);
      }}
    >
      <span className="infotip-icon">!</span>
      {open && <span className="infotip-bubble">{text}</span>}
    </span>
  );
}
