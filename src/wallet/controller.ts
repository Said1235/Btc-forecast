export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...a: never[]) => void): void;
  removeListener?(event: string, handler: (...a: never[]) => void): void;
  isMetaMask?: boolean;
}

export interface DiscoveredProvider {
  id: string; // rdns when announced via EIP-6963, else a synthetic id
  name: string;
  provider: Eip1193Provider;
  isMetaMask: boolean;
}

export type WalletErrorKind =
  | "no-provider" | "rejected" | "pending" | "locked" | "unavailable" | "wrong-network" | "disconnected" | "switch-failed";

export interface WalletError {
  kind: WalletErrorKind;
  message: string;
  detail?: string;
}

export interface WalletState {
  status: "no-provider" | "idle" | "connecting" | "connected";
  providers: DiscoveredProvider[];
  selectedId: string | null;
  account: string | null;
  chainId: number | null;
  error: WalletError | null;
}

export interface WalletOptions {
  /** Network the app needs. Null until the contract deployment is configured. */
  expectedChainId: number | null;
  addChainParams?: object | null;
  storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
  win?: Pick<Window, "addEventListener" | "removeEventListener" | "dispatchEvent"> & { ethereum?: unknown };
}

const SESSION_KEY = "btc-forecast:wallet-session:v1";

const toChain = (v: unknown): number | null => {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = v.startsWith("0x") ? parseInt(v, 16) : Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

export function mapWalletError(e: unknown): WalletError {
  const code = (e as { code?: number })?.code;
  const msg = (e as { message?: string })?.message ?? String(e);
  if (code === 4001) return { kind: "rejected", message: "You rejected the connection request. Nothing was connected.", detail: msg };
  if (code === -32002) return { kind: "pending", message: "A wallet request is already open. Open your wallet and answer it.", detail: msg };
  if (code === 4100) return { kind: "locked", message: "The wallet did not authorize this site. Unlock it and try again.", detail: msg };
  return { kind: "unavailable", message: "The wallet could not be reached.", detail: msg };
}

export class WalletController {
  private s: WalletState;
  private listeners = new Set<() => void>();
  private detach: (() => void) | null = null;
  private stopDiscovery: (() => void) | null = null;
  private opts: WalletOptions;
  private win: NonNullable<WalletOptions["win"]>;

  constructor(opts: WalletOptions) {
    this.opts = opts;
    this.win = opts.win ?? (typeof window !== "undefined" ? window : ({} as never));
    this.s = { status: "no-provider", providers: [], selectedId: null, account: null, chainId: null, error: null };
  }

  getState = () => this.s;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  private set(patch: Partial<WalletState>) {
    this.s = { ...this.s, ...patch };
    this.listeners.forEach((l) => l());
  }

  /** Find injected providers. Never prompts the wallet. */
  discover() {
    const found = new Map<string, DiscoveredProvider>();
    const add = (p: DiscoveredProvider) => {
      found.set(p.id, p);
      this.set({ providers: [...found.values()], status: this.s.status === "no-provider" ? "idle" : this.s.status });
    };
    const onAnnounce = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { info?: { rdns?: string; name?: string }; provider?: Eip1193Provider } | undefined;
      if (!d?.provider || !d.info?.rdns) return;
      add({ id: d.info.rdns, name: d.info.name ?? d.info.rdns, provider: d.provider, isMetaMask: d.info.rdns === "io.metamask" || !!d.provider.isMetaMask });
    };
    this.win.addEventListener("eip6963:announceProvider", onAnnounce);
    this.win.dispatchEvent(new Event("eip6963:requestProvider"));
    // Legacy fallback: window.ethereum, including the old `providers` array
    const eth = this.win.ethereum as (Eip1193Provider & { providers?: Eip1193Provider[] }) | undefined;
    if (eth && found.size === 0) {
      const list = Array.isArray(eth.providers) && eth.providers.length ? eth.providers : [eth];
      list.forEach((p, i) => add({ id: `injected-${i}`, name: p.isMetaMask ? "MetaMask" : `Injected wallet ${list.length > 1 ? i + 1 : ""}`.trim(), provider: p, isMetaMask: !!p.isMetaMask }));
    }
    this.stopDiscovery?.();
    this.stopDiscovery = () => this.win.removeEventListener("eip6963:announceProvider", onAnnounce);
  }

  /** On reload: restore silently with eth_accounts. Only if the user connected before. Never prompts. */
  async restore() {
    let saved: string | null = null;
    try { saved = this.opts.storage?.getItem(SESSION_KEY) ?? null; } catch { /* ignore */ }
    const p = this.s.providers.find((x) => x.id === saved);
    if (!p) return;
    try {
      const accounts = (await p.provider.request({ method: "eth_accounts" })) as string[];
      if (!accounts?.length) return;
      const chainId = toChain(await p.provider.request({ method: "eth_chainId" }));
      this.attach(p, accounts[0], chainId);
    } catch { /* stay disconnected */ }
  }

  async connect(id?: string) {
    if (this.s.status === "connecting") return;
    const p = this.s.providers.find((x) => x.id === (id ?? this.s.selectedId)) ?? (this.s.providers.length === 1 ? this.s.providers[0] : undefined);
    if (!p) {
      this.set({ error: this.s.providers.length ? { kind: "unavailable", message: "Choose a wallet to connect." } : { kind: "no-provider", message: "No browser wallet was found. Install MetaMask or another EIP-1193 wallet, then reload." } });
      return;
    }
    this.set({ status: "connecting", error: null, selectedId: p.id });
    try {
      const accounts = (await p.provider.request({ method: "eth_requestAccounts" })) as string[];
      if (!accounts?.length) {
        this.set({ status: "idle", error: { kind: "locked", message: "The wallet returned no account. Unlock it and pick an account, then try again." } });
        return;
      }
      const chainId = toChain(await p.provider.request({ method: "eth_chainId" }));
      this.attach(p, accounts[0], chainId);
      try { this.opts.storage?.setItem(SESSION_KEY, p.id); } catch { /* ignore */ }
    } catch (e) {
      this.set({ status: "idle", error: mapWalletError(e) });
    }
  }

  private attach(p: DiscoveredProvider, account: string, chainId: number | null) {
    this.detach?.();
    const onAccounts = (accs: string[]) => {
      if (!accs?.length) {
        this.detach?.();
        this.detach = null;
        this.set({ status: "idle", account: null, chainId: null, error: { kind: "disconnected", message: "The wallet no longer shares an account with this site." } });
      } else this.set({ account: accs[0], error: null });
    };
    const onChain = (c: string) => this.set({ chainId: toChain(c) });
    const onDisconnect = () => {
      this.detach?.();
      this.detach = null;
      this.set({ status: "idle", account: null, chainId: null, error: { kind: "disconnected", message: "The wallet provider disconnected." } });
    };
    p.provider.on?.("accountsChanged", onAccounts as never);
    p.provider.on?.("chainChanged", onChain as never);
    p.provider.on?.("disconnect", onDisconnect as never);
    this.detach = () => {
      p.provider.removeListener?.("accountsChanged", onAccounts as never);
      p.provider.removeListener?.("chainChanged", onChain as never);
      p.provider.removeListener?.("disconnect", onDisconnect as never);
    };
    this.set({ status: "connected", selectedId: p.id, account, chainId, error: null });
  }

  /** Local session reset. It does not revoke the permission the wallet granted to this site. */
  disconnect() {
    this.detach?.();
    this.detach = null;
    try { this.opts.storage?.removeItem(SESSION_KEY); } catch { /* ignore */ }
    this.set({ status: this.s.providers.length ? "idle" : "no-provider", account: null, chainId: null, error: null });
  }

  /** Only called from a user action. Never switches silently. */
  async switchNetwork() {
    const p = this.s.providers.find((x) => x.id === this.s.selectedId);
    const want = this.opts.expectedChainId;
    if (!p || want === null) return;
    const hex = "0x" + want.toString(16);
    try {
      await p.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      if ((e as { code?: number }).code === 4902 && this.opts.addChainParams) {
        try {
          await p.provider.request({ method: "wallet_addEthereumChain", params: [this.opts.addChainParams] });
          return;
        } catch (e2) {
          this.set({ error: { kind: "switch-failed", message: "The network could not be added.", detail: (e2 as Error).message } });
          return;
        }
      }
      const rejected = (e as { code?: number }).code === 4001;
      this.set({ error: { kind: "switch-failed", message: rejected ? "You rejected the network switch." : "The network could not be switched.", detail: (e as Error).message } });
    }
  }

  /** The EIP-1193 provider the user connected with (not just window.ethereum). */
  currentProvider(): Eip1193Provider | null {
    return this.s.providers.find((x) => x.id === this.s.selectedId)?.provider ?? null;
  }

  isWrongNetwork(): boolean {
    return this.s.status === "connected" && this.opts.expectedChainId !== null && this.s.chainId !== this.opts.expectedChainId;
  }

  clearError() {
    this.set({ error: null });
  }

  destroy() {
    this.detach?.();
    this.stopDiscovery?.();
    this.detach = null;
    this.stopDiscovery = null;
    this.listeners.clear();
  }
}
