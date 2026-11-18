# BTC Forecast

A daily Bitcoin candle prediction game. Each UTC day is a market: call whether the BTCUSDT daily candle will close **UP**, **DOWN** or **FLAT** relative to its open. One correct call is worth one point. Points only: no stakes, deposits or tokens.

Market data comes from the Binance Spot public API. Predictions, resolution and points live in the **BTCForecast Intelligent Contract on GenLayer StudioNet**, where validators independently re-fetch the closed candle and must agree on the result.

## How it works

| Step | What happens |
|---|---|
| Predict | Pick UP, DOWN or FLAT for a market that has not opened yet (up to 7 days ahead). You can change the pick until 00:00 UTC of that day. |
| Resolve | After the day closes (plus a 5 minute grace period) anyone can start resolution, provided the market has at least one prediction. Validators fetch the candle from Binance and must reach consensus. |
| Confirm | A candidate result is confirmed after a 5 minute interval. |
| Claim | Run `claim_points` on a resolved market to receive your point. Points exist on-chain only after the claim. |

Outcome rule: close above open is UP, below is DOWN, equal is FLAT.

## Network and contract

| | |
|---|---|
| Network | GenLayer StudioNet |
| Chain ID | `61999` (`0xf22f`) |
| RPC | `https://studio.genlayer.com/api` |
| Currency | GEN |
| Explorer | https://explorer-studio.genlayer.com |
| Contract | `0x8AB7b7FB6771cb91d65623964df704c075e7e2b7` |
| SDK | `genlayer-js` 1.1.8 using the official `studionet` preset |

Contract source: https://github.com/Said1235/BTC-Forest-Intelligent-Contract

Methods used by the app: `submit_prediction`, `resolve_market`, `claim_points` (writes) and `get_prediction`, `get_market_candidate`, `get_market_result`, `get_user_points` (views).

## Quick start

Requires Node 20 or newer.

```bash
npm install
npm run dev        # add ?demo=1 to the URL for Demo Mode (no wallet, no network writes)
```

| Script | Purpose |
|---|---|
| `npm run build` | Typecheck and production build |
| `npm run lint` | ESLint |
| `npm test` | Unit and component tests |
| `npm run test:live` | Real Binance request (`LIVE_BINANCE=1`) |
| `npm run test:studio` | Real StudioNet RPC and contract schema check (`LIVE_STUDIO=1`) |

## Configuration

Everything is optional. The defaults already target the StudioNet deployment above.

| Variable | Default |
|---|---|
| `VITE_GENLAYER_CHAIN_ID` | `61999` |
| `VITE_GENLAYER_RPC_URL` | `https://studio.genlayer.com/api` |
| `VITE_CONTRACT_ADDRESS` | `0x8AB7…e2b7` |
| `VITE_EXPLORER_URL` | `https://explorer-studio.genlayer.com` |
| `VITE_BINANCE_BASE` | `https://api.binance.com` |

The app refuses to send a transaction if the effective network is not StudioNet (see below), so overriding these to another network will block writes rather than silently use it.

## Architecture

Vite, React and TypeScript, with hash routing (`#/` landing, `#/app` game).

```
src/
  domain/    pure UTC, market-window and outcome logic
  data/      Binance provider (cancellation, out-of-order protection, cache),
             demo fixtures, GenLayer contract adapter
  rpc/       central RPC gate: shared cache, de-duplication, pacing, rate-limit handling
  tx/        transaction journal and tracker (exact-id tracking, reconciliation)
  wallet/    EIP-6963 discovery, window.ethereum fallback, network switching
  state/     app context
  ui/ pages/ components and screens
```

## Reliability and safety

- **Real data only.** The chart uses live Binance candles. Cached data is flagged as such, and there is no silent fallback to demo data. Loading, stale, offline, rate-limited and API-error states are all shown.
- **Runtime network verification.** Before every write the app checks that the wallet reports chain `0xf22f`, that both the read and write clients use the `studionet` preset with RPC `https://studio.genlayer.com/api`, and that they agree with each other. Any mismatch stops the send with an explanatory error.
- **RPC traffic control.** All reads go through one gate (shared cache, de-duplication, pacing). Rate-limit errors, even without HTTP 429, trigger exponential backoff with jitter and honor `Retry-After`, with bounded retries.
- **Serialized writes, no duplicates.** Writes run one at a time per account and network. A second operation for the same wallet, market and method is blocked while the first is unresolved, and a cool-down is enforced before the wallet is asked to sign again after a rate limit.
- **Never resend blindly.** If a send ends without a transaction id, the operation is marked uncertain. A "check before retrying" action compares the account nonce and the contract state, and only sufficient evidence reopens the send.
- **Honest results.** An operation is shown as finalized only after the leader's execution succeeded and a contract read-back confirms the expected state. Validators idled after quorum are not treated as failures.
- **Transactions are tracked by their exact id**, persisted in a local journal tied to account, network, contract, method and market, and resumed after a reload.

Known limit: `genlayer-js` 1.1.8 performs its own nonce, gas and receipt calls inside `writeContract`; those cannot be routed through the gate.

## Deploy on Vercel

`vercel.json` is already configured (Vite, `npm run build`, output `dist`).

1. Import `Said1235/Btc-forecast` at https://vercel.com/new and press Deploy. No environment variables are required.
2. Open `<your-url>/#/app` and check the LIVE chip.

CLI alternative: `npx vercel` (preview) or `npx vercel --prod`.

## Branding

Logo files for portals and listings are in `public/brand/`: `logo.svg`, `logo-512.png` (light background), `logo-512-dark.png` and `logo-512-transparent.png`.

## More

Frontend handoff notes and the contract mapping: [`docs/FRONTEND_HANDOFF.md`](docs/FRONTEND_HANDOFF.md).
