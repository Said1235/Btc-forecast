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

describe("live mode without contract", () => {
  it("shows a market-data error with retry, never silently falls back to demo", async () => {
    setHash("#/app");
    render(<App />);
    expect(await screen.findByText(/Market data is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/DEMO MODE/)).toBeNull();
    expect(screen.getByRole("button", { name: /retry now/i })).toBeInTheDocument();
    expect(screen.queryByTestId("chart")).toBeNull();
  });
  it("shows integration-not-configured (not an RPC failure) and an unverified, non-submittable selector", async () => {
    setHash("#/app");
    render(<App />);
    expect(await screen.findByText(/Contract integration not configured/)).toBeInTheDocument();
    expect(screen.getByText(/Cannot verify or record predictions yet/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /UP/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /review prediction/i })).toBeNull();
    expect(screen.getByText(/Connect a wallet to see your predictions/)).toBeInTheDocument();
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
    const panel = await screen.findByTestId("tx-panel", undefined, { timeout: 4000 });
    expect(panel).toHaveTextContent(/Simulated lifecycle/);
    expect(panel).toHaveTextContent(/Waiting for wallet approval/);
    await waitFor(() => expect(screen.getByTestId("tx-panel")).toHaveTextContent(/demo-0001/), { timeout: 4000 });
    expect(screen.getByTestId("tx-panel")).not.toHaveTextContent(/0x[0-9a-f]{40}/i);
    await waitFor(() => expect(screen.getByTestId("tx-panel")).toHaveTextContent(/Finalized and verified by read-back/), { timeout: 9000 });
    // a second submission is no longer possible for this market
    expect(screen.queryByRole("button", { name: /review prediction/i })).toBeNull();
    expect(screen.getByText(/Prediction submitted/)).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Wallet" })).toBeInTheDocument();
    delete (window as unknown as { ethereum?: unknown }).ethereum;
  });
});
