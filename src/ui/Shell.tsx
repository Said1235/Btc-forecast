import { useState } from "react";
import { useApp } from "../state/AppContext";
import { shortAddress } from "../domain/format";
import { Logo, useOutsideClose, Banner, scrollToSection, useActiveSection } from "./parts";

export function ThemeButton() {
  const { theme, cycleTheme } = useApp();
  return <button className="btn btn--ghost btn--sm" onClick={cycleTheme} aria-label={`Theme: ${theme}. Switch theme`}>{theme === "system" ? "Auto" : theme === "dark" ? "Graphite" : "Light"}</button>;
}

export function WalletMenu() {
  const { wallet, walletApi, mode, wrongNetwork } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(() => setOpen(false));
  if (mode === "demo") return <span className="chip chip--demo" title="Demo mode uses a built-in demo account. No wallet is involved.">DEMO account</span>;
  const connected = wallet.status === "connected" && wallet.account;
  return (
    <div className="menu" ref={ref}>
      <button className="btn btn--sm" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        {connected ? <span className="num">{shortAddress(wallet.account!)}</span> : wallet.status === "connecting" ? "Connecting…" : "Connect wallet"}
      </button>
      {open && (
        <div className="menu__pop" role="dialog" aria-label="Wallet">
          {connected ? (
            <>
              <dl className="dl"><dt>Account</dt><dd className="num">{wallet.account}</dd><dt>Chain ID</dt><dd className="num">{wallet.chainId ?? "unknown"}</dd></dl>
              {wrongNetwork && <button className="btn" onClick={() => void walletApi.switchNetwork()}>Switch network</button>}
              <p style={{ fontSize: 13, color: "var(--muted)" }}>Disconnect only resets this site's session. It does not revoke the permission your wallet granted; do that in the wallet.</p>
              <button className="btn" onClick={() => { walletApi.disconnect(); setOpen(false); }}>Reset session</button>
            </>
          ) : (
            <>
              {wallet.providers.length === 0 && <p style={{ fontSize: 14 }}>No browser wallet detected. Install MetaMask or another EIP-1193 wallet. On mobile, open this page inside your wallet's browser.</p>}
              {wallet.providers.map((p) => (
                <button key={p.id} className="btn" disabled={wallet.status === "connecting"} onClick={() => void walletApi.connect(p.id)}>
                  {p.name}
                </button>
              ))}
              {wallet.providers.length === 0 && <button className="btn" onClick={() => void walletApi.connect()}>Check again</button>}
              {wallet.error && <Banner kind={wallet.error.kind === "rejected" || wallet.error.kind === "pending" ? "warn" : "error"} title={wallet.error.message} detail={wallet.error.detail} />}
              <p style={{ fontSize: 13, color: "var(--muted)" }}>Connecting only shares your public address. It never sends a transaction.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const SECTIONS = [["how", "How it works"], ["market", "Market"], ["technology", "Technology"]] as const;

export function TopBar({ page }: { page: "landing" | "app" }) {
  const active = useActiveSection(page === "landing" ? SECTIONS.map(([id]) => id) : []);
  return (
    <header className="top">
      <div className="wrap top__in">
        <a className="brand" href="#/" aria-label="BTC Forecast home"><Logo />BTC Forecast</a>
        <nav className="nav" aria-label="Main">
          {page === "landing" ? (
            <>
              {SECTIONS.map(([id, label]) => (
                <a key={id} href={`#${id}`} aria-current={active === id ? "location" : undefined} onClick={(e) => { e.preventDefault(); scrollToSection(id); }}>{label}</a>
              ))}
            </>
          ) : (
            <>
              <a href="#/app" aria-current="page">Forecast</a>
              <a href="#/">About</a>
            </>
          )}
        </nav>
        <div className="top__end">
          <ThemeButton />
          {page === "landing" ? <a className="btn btn--primary btn--sm" href="#/app">Open app</a> : <WalletMenu />}
        </div>
      </div>
    </header>
  );
}

export function DemoBar() {
  const { mode, setMode } = useApp();
  if (mode !== "demo") return null;
  return (
    <div className="demo-bar" role="status">
      <div className="wrap">
        <strong>DEMO MODE</strong>
        <span>Fixture data and a built-in demo account. No live market data, no contract reads, no transactions.</span>
        <button onClick={() => setMode("live")}>Switch to live market data</button>
      </div>
    </div>
  );
}

export function Toasts() {
  const { toasts } = useApp();
  return <div className="toasts" aria-live="polite">{toasts.map((t) => <div className="toast" key={t.id}>{t.text}</div>)}</div>;
}
