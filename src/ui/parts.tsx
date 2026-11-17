import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Outcome } from "../domain/candle";

export function Glyph({ o }: { o: Outcome }) {
  const c = `g g--${o}`;
  if (o === "UP") return <svg className={c} viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2 14.5 13h-13z" fill="currentColor" /></svg>;
  if (o === "DOWN") return <svg className={c} viewBox="0 0 16 16" aria-hidden="true"><path d="M8 14 1.5 3h13z" fill="currentColor" /></svg>;
  return <svg className={c} viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h12" stroke="currentColor" strokeWidth="2.6" /></svg>;
}

/** Direction is always glyph + word, never color alone. */
export function OutcomeTag({ o, prefix }: { o: Outcome; prefix?: string }) {
  return <span className={`t--${o}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 500 }}><Glyph o={o} />{prefix}{o}</span>;
}

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <line x1="16" y1="3" x2="16" y2="29" stroke="currentColor" strokeWidth="2.5" />
      <rect x="9" y="9" width="14" height="13" fill="currentColor" />
      <line x1="2" y1="16" x2="30" y2="16" stroke="var(--bg)" strokeWidth="1.5" strokeDasharray="3 3" />
    </svg>
  );
}

const ICON: Record<string, string> = {
  error: "M12 3 2 21h20zM12 10v5m0 3v.01",
  warn: "M12 3 2 21h20zM12 10v5m0 3v.01",
  info: "M12 8v.01M12 11v6M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0",
  ok: "M5 12.5 10 17.5 19 7M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0",
};

export function Banner({ kind, title, children, actions, detail }: { kind: "error" | "warn" | "info" | "ok"; title: string; children?: ReactNode; actions?: ReactNode; detail?: string }) {
  return (
    <div className={`banner banner--${kind}`} role={kind === "error" ? "alert" : "status"}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d={ICON[kind]} /></svg>
      <div>
        <b>{title}</b>
        {children}
        {detail && <details><summary>Technical details</summary>{detail}</details>}
      </div>
      {actions && <div className="acts">{actions}</div>}
    </div>
  );
}

export function useOutsideClose(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, [onClose]);
  return ref;
}

export function useHashRoute(): "landing" | "app" {
  const get = (): "landing" | "app" => (location.hash.startsWith("#/app") ? "app" : "landing");
  const [r, setR] = useState(get);
  useEffect(() => {
    const h = () => { setR(get()); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  return r;
}

/** Modal with focus trap, Escape to close and focus restore. */
export function Dialog({ title, onClose, children, labelId }: { title: string; onClose: () => void; children: ReactNode; labelId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const node = ref.current!;
    const focusables = () => Array.from(node.querySelectorAll<HTMLElement>("button, [href], input, select, [tabindex]:not([tabindex='-1'])")).filter((e) => !e.hasAttribute("disabled"));
    focusables()[0]?.focus();
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const f = focusables();
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("keydown", k); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby={labelId} ref={ref}>
        <h2 id={labelId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
