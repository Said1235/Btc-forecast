import { describe, it, expect, vi } from "vitest";
import { WalletController, type Eip1193Provider } from "./controller";

function fakeProvider(opts: { accounts?: string[]; chain?: string; reqError?: unknown; isMetaMask?: boolean } = {}) {
  const handlers = new Map<string, Set<(...a: never[]) => void>>();
  const p: Eip1193Provider & { emit: (e: string, v?: unknown) => void; count: () => number } = {
    isMetaMask: opts.isMetaMask,
    request: vi.fn(async ({ method }) => {
      if (opts.reqError && method === "eth_requestAccounts") throw opts.reqError;
      if (method === "eth_requestAccounts" || method === "eth_accounts") return opts.accounts ?? ["0xabc"];
      if (method === "eth_chainId") return opts.chain ?? "0xf22f";
      return null;
    }),
    on: (e, h) => { (handlers.get(e) ?? handlers.set(e, new Set()).get(e)!).add(h); },
    removeListener: (e, h) => { handlers.get(e)?.delete(h); },
    emit: (e, v) => handlers.get(e)?.forEach((h) => (h as (x: unknown) => void)(v)),
    count: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  };
  return p;
}
function makeWin(providers: { rdns: string; name: string; p: Eip1193Provider }[], legacy?: unknown) {
  const target = new EventTarget();
  target.addEventListener("eip6963:requestProvider", () => {
    providers.forEach(({ rdns, name, p }) => target.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { rdns, name }, provider: p } })));
  });
  return Object.assign(target, { ethereum: legacy }) as unknown as Parameters<typeof Object>[0] & NonNullable<ConstructorParameters<typeof WalletController>[0]["win"]>;
}
const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };

describe("wallet controller", () => {
  it("reports no provider", async () => {
    const w = new WalletController({ expectedChainId: null, win: makeWin([]) });
    w.discover();
    await w.connect();
    expect(w.getState().error?.kind).toBe("no-provider");
  });
  it("does not prompt on discovery", () => {
    const p = fakeProvider();
    const w = new WalletController({ expectedChainId: null, win: makeWin([{ rdns: "io.metamask", name: "MetaMask", p }]) });
    w.discover();
    expect(p.request).not.toHaveBeenCalled();
  });
  it("connects", async () => {
    const p = fakeProvider({ isMetaMask: true });
    const w = new WalletController({ expectedChainId: null, win: makeWin([{ rdns: "io.metamask", name: "MetaMask", p }]) });
    w.discover();
    await w.connect();
    expect(w.getState()).toMatchObject({ status: "connected", account: "0xabc", chainId: 0xf22f });
  });
  it("maps user rejection", async () => {
    const p = fakeProvider({ reqError: { code: 4001, message: "no" } });
    const w = new WalletController({ expectedChainId: null, win: makeWin([{ rdns: "a", name: "A", p }]) });
    w.discover();
    await w.connect();
    expect(w.getState().error?.kind).toBe("rejected");
    expect(w.getState().status).toBe("idle");
  });
  it("ignores a second connect while one is pending and maps -32002", async () => {
    let release!: () => void;
    const p = fakeProvider();
    (p.request as ReturnType<typeof vi.fn>).mockImplementation(({ method }: { method: string }) => method === "eth_requestAccounts" ? new Promise((r) => (release = () => r(["0x1"]))) : Promise.resolve("0x1"));
    const w = new WalletController({ expectedChainId: null, win: makeWin([{ rdns: "a", name: "A", p }]) });
    w.discover();
    const first = w.connect();
    await w.connect();
    expect((p.request as ReturnType<typeof vi.fn>).mock.calls.filter(([a]) => a.method === "eth_requestAccounts")).toHaveLength(1);
    release();
    await first;
    const p2 = fakeProvider({ reqError: { code: -32002 } });
    const w2 = new WalletController({ expectedChainId: null, win: makeWin([{ rdns: "b", name: "B", p: p2 }]) });
    w2.discover();
    await w2.connect();
    expect(w2.getState().error?.kind).toBe("pending");
  });
  it("detects a locked wallet (empty accounts)", async () => {
    const p = fakeProvider({ accounts: [] });
    const w = new WalletController({ expectedChainId: null, win: makeWin([{ rdns: "a", name: "A", p }]) });
    w.discover();
    await w.connect();
    expect(w.getState().error?.kind).toBe("locked");
  });
  it("follows account and chain changes", async () => {
    const p = fakeProvider({ chain: "0x1" });
    const w = new WalletController({ expectedChainId: 61999, win: makeWin([{ rdns: "a", name: "A", p }]) });
    w.discover();
    await w.connect();
    expect(w.isWrongNetwork()).toBe(true);
    p.emit("chainChanged", "0xf22f");
    expect(w.getState().chainId).toBe(61999);
    expect(w.isWrongNetwork()).toBe(false);
    p.emit("accountsChanged", ["0xdef"]);
    expect(w.getState().account).toBe("0xdef");
  });
  it("handles provider disconnect and empty accountsChanged", async () => {
    const p = fakeProvider();
    const w = new WalletController({ expectedChainId: null, win: makeWin([{ rdns: "a", name: "A", p }]) });
    w.discover();
    await w.connect();
    p.emit("disconnect");
    expect(w.getState().status).toBe("idle");
    expect(w.getState().error?.kind).toBe("disconnected");
    expect(p.count()).toBe(0);
  });
  it("lists multiple injected providers and asks which one", async () => {
    const a = fakeProvider(), b = fakeProvider();
    const w = new WalletController({ expectedChainId: null, win: makeWin([{ rdns: "a", name: "A", p: a }, { rdns: "b", name: "B", p: b }]) });
    w.discover();
    expect(w.getState().providers).toHaveLength(2);
    await w.connect();
    expect(a.request).not.toHaveBeenCalled();
    expect(w.getState().error?.message).toMatch(/Choose a wallet/);
    await w.connect("b");
    expect(w.getState().selectedId).toBe("b");
  });
  it("cleans up listeners on disconnect and destroy", async () => {
    const p = fakeProvider();
    const w = new WalletController({ expectedChainId: null, win: makeWin([{ rdns: "a", name: "A", p }]) });
    w.discover();
    await w.connect();
    expect(p.count()).toBe(3);
    w.disconnect();
    expect(p.count()).toBe(0);
    w.destroy();
  });
  it("restores silently after reload only if previously connected, without prompting", async () => {
    const storage = mem();
    const p = fakeProvider();
    const w1 = new WalletController({ expectedChainId: null, storage, win: makeWin([{ rdns: "a", name: "A", p }]) });
    w1.discover();
    await w1.connect();
    const p2 = fakeProvider();
    const w2 = new WalletController({ expectedChainId: null, storage, win: makeWin([{ rdns: "a", name: "A", p: p2 }]) });
    w2.discover();
    await w2.restore();
    expect(w2.getState().status).toBe("connected");
    expect((p2.request as ReturnType<typeof vi.fn>).mock.calls.some(([a]) => a.method === "eth_requestAccounts")).toBe(false);
  });
  it("never switches network on its own", async () => {
    const p = fakeProvider();
    const w = new WalletController({ expectedChainId: 61999, win: makeWin([{ rdns: "a", name: "A", p }]) });
    w.discover();
    await w.connect();
    expect((p.request as ReturnType<typeof vi.fn>).mock.calls.some(([a]) => a.method === "wallet_switchEthereumChain")).toBe(false);
    await w.switchNetwork();
    expect((p.request as ReturnType<typeof vi.fn>).mock.calls.some(([a]) => a.method === "wallet_switchEthereumChain")).toBe(true);
  });
  it("falls back to window.ethereum.providers", () => {
    const a = fakeProvider({ isMetaMask: true }), b = fakeProvider();
    const w = new WalletController({ expectedChainId: null, win: makeWin([], { providers: [a, b] }) });
    w.discover();
    expect(w.getState().providers.map((p) => p.isMetaMask)).toEqual([true, false]);
  });
});
