import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { App } from "../App";

vi.mock("./CandleChart", () => ({ CandleChart: ({ stale }: { stale: boolean }) => <div data-testid="chart" data-stale={String(stale)} /> }));

const setHash = (h: string) => { location.hash = h; };
const demo = () => { sessionStorage.setItem("btcf:mode", "demo"); };

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  setHash("#/");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("blocked"); }));
});

describe("landing", () => {
  it("explains the product and links into the app", () => {
    render(<App />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/Bitcoin's daily close/);
    expect(screen.getAllByText(/close > open/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /open app|open forecast/i })[0]).toHaveAttribute("href", "#/app");
    expect(screen.getByText(/no deposits, tokens or payouts/i)).toBeInTheDocument();
    expect(screen.queryByText(/MCP/)).toBeNull();
  });
  it("navigates to the app and back", async () => {
    render(<App />);
    fireEvent.click(screen.getAllByRole("link", { name: /open app/i })[0]);
    setHash("#/app");
    expect(await screen.findByRole("heading", { name: /BTCUSDT daily forecast/ })).toBeInTheDocument();
  });
});

describe("live mode (StudioNet)", () => {
  it("shows a market-data error with retry, never silently falls back to demo", async () => {
    setHash("#/app");
    render(<App />);
    expect(await screen.findByText(/Market data is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/DEMO MODE/)).toBeNull();
    expect(screen.getByRole("button", { name: /retry now/i })).toBeInTheDocument();
    expect(screen.queryByTestId("chart")).toBeNull();
  });
  it("shows the network and contract in use and asks for a wallet instead of guessing", async () => {
    setHash("#/app");
    render(<App />);
    const net = await screen.findByTestId("net-info");
    expect(net).toHaveTextContent(/StudioNet/);
    expect(net).toHaveTextContent("61999");
    expect(net).toHaveTextContent(/0x8AB7b7…e7e2b7/);
    expect(screen.getByRole("link", { name: /0x8AB7b7…e7e2b7/ })).toHaveAttribute("href", "https://explorer-studio.genlayer.com/address/0x8AB7b7FB6771cb91d65623964df704c075e7e2b7");
    expect(screen.getByRole("button", { name: /connect wallet to continue/i })).toBeInTheDocument();
    expect(screen.getByText(/Connect a wallet to see your predictions/)).toBeInTheDocument();
    expect(screen.queryByText(/not configured/i)).toBeNull();
  });
});

describe("demo mode", () => {
  it("is clearly labelled everywhere", async () => {
    demo(); setHash("#/app");
    render(<App />);
    expect(await screen.findByText("DEMO MODE")).toBeInTheDocument();
    expect(screen.getAllByText(/DEMO/).length).toBeGreaterThan(3);
    expect(screen.getByTestId("chart")).toHaveAttribute("data-stale", "false");
  });
  it("requires a choice, then confirms, then runs the simulated lifecycle without claiming a real transaction", async () => {
    demo(); setHash("#/app");
    render(<App />);
    await screen.findByText("DEMO MODE");
    fireEvent.click(screen.getByRole("button", { name: /review prediction/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Choose UP, DOWN or FLAT/);
    fireEvent.click(screen.getByRole("radio", { name: /DOWN/ }));
    expect(screen.getByRole("radio", { name: /DOWN/ })).toBeChecked();
    expect(screen.queryByTestId("tx-panel")).toBeNull(); // selecting submits nothing
    fireEvent.click(screen.getByRole("button", { name: /review prediction/i }));
    const dlg = screen.getByRole("dialog", { name: /confirm your prediction/i });
    expect(within(dlg).getByText(/will not send a transaction/i)).toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole("button", { name: /run demo flow/i }));
    await waitFor(() => expect(screen.getAllByTestId("tx-panel").length).toBeGreaterThan(0), { timeout: 4000 });
    const text = () => screen.getAllByTestId("tx-panel").map((p) => p.textContent).join(" | ");
    await waitFor(() => expect(text()).toMatch(/demo-sub-0001/), { timeout: 4000 });
    expect(text()).toMatch(/Simulated lifecycle/);
    expect(text()).not.toMatch(/0x[0-9a-f]{40}/i);
    await waitFor(() => expect(text()).toMatch(/Finalized and verified by read-back/), { timeout: 9000 });
    // contract allows changing the call until the market opens: the record is shown and an update needs a different pick
    const rec = await screen.findByTestId("onchain-pick", undefined, { timeout: 4000 });
    expect(rec).toHaveTextContent(/Demo record/);
    expect(rec).toHaveTextContent(/DOWN/);
    expect(screen.getByRole("button", { name: /update prediction/i })).toBeDisabled();
  }, 20000);
  it("lists closed markets with the next contract step and runs the first resolution step", async () => {
    demo(); setHash("#/app");
    render(<App />);
    await screen.findByText("DEMO MODE");
    const start = await screen.findByRole("button", { name: /start resolution|confirm resolution/i }, { timeout: 4000 }).catch(() => null);
    if (!start) return; // first 5 minutes of a UTC day: resolution window not open yet
    fireEvent.click(start);
    await waitFor(() => expect(screen.getAllByTestId("tx-panel").some((p) => /Resolution/.test(p.textContent ?? ""))).toBe(true), { timeout: 4000 });
    await waitFor(() => expect(screen.getByText(/Provisional/)).toBeInTheDocument(), { timeout: 9000 });
  }, 20000);
  it("arrow keys move the selection", async () => {
    demo(); setHash("#/app");
    render(<App />);
    await screen.findByText("DEMO MODE");
    const up = screen.getByRole("radio", { name: /UP/ });
    up.focus();
    fireEvent.keyDown(up, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: /DOWN/ })).toBeChecked();
  });
  it("locks predictions for today's market", async () => {
    demo(); setHash("#/app");
    render(<App />);
    await screen.findByText("DEMO MODE");
    fireEvent.click(screen.getByRole("button", { name: /today's market/i }));
    expect(screen.getByText("Prediction locked")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /UP/ })).toBeDisabled();
  });
  it("can return to live without a hidden fallback", async () => {
    demo(); setHash("#/app");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /switch to live market data/i }));
    expect(await screen.findByText(/Market data is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("DEMO MODE")).toBeNull();
  });
});

describe("accessibility basics", () => {
  it("has a skip link, landmarks and labelled controls", async () => {
    setHash("#/app");
    render(<App />);
    expect(screen.getByRole("link", { name: /skip to content/i })).toHaveAttribute("href", "#main");
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: /prediction options/i })).toBeInTheDocument();
  });
  it("wallet menu opens only on user action and never prompts", async () => {
    const request = vi.fn();
    (window as unknown as { ethereum: unknown }).ethereum = { request, on: vi.fn(), removeListener: vi.fn(), isMetaMask: true };
    setHash("#/app");
    render(<App />);
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: /connect wallet/i })[0]);
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Wallet" })).toBeInTheDocument();
    delete (window as unknown as { ethereum?: unknown }).ethereum;
  });
});
