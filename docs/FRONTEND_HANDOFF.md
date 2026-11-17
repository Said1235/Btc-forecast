# BTC Forecast: frontend handoff

Standalone frontend (Vite 8 + React 19 + TypeScript 6). The contract repo did not exist when this was built, so this is a new `btc-forecast-app` folder that touches no contract or backend code. Move it into the real repo's frontend folder when ready.

## Run
```
npm install
npm run dev        # http://localhost:5173  (add ?demo=1 for Demo Mode)
npm run build      # typecheck + production build
npm run lint && npm test
```

## What exists
- **Landing** (`#/`) and **app** (`#/app`), one design system. Light "cool slate" theme from the approved preview plus a graphite/orange theme (toggle, or system dark).
- **Market data**: Binance Spot `GET /api/v3/klines?symbol=BTCUSDT&interval=1d` and `/api/v3/time` (`src/data/binance.ts`). Exchange clock offset is measured; all market boundaries are UTC; forming candle is hollow and labelled; failures keep the last real data visible and flagged STALE; 429 uses Retry-After; older responses cannot overwrite newer ones (`LatestOnly`).
- **Domain** (`src/domain`): UTC day math, phases, UP/DOWN/FLAT on parsed numbers, candle validation (duplicates, malformed, off-boundary), presentation state.
- **Wallet** (`src/wallet/controller.ts`): EIP-6963 discovery + `window.ethereum(.providers)` fallback, user-initiated connect only, silent restore via `eth_accounts`, `accountsChanged`/`chainChanged`/`disconnect`, listener cleanup, wrong-network banner with a user-initiated switch. "Reset session" is local only.
- **Transaction journal** (`src/tx`): entries keyed by exact `txHash`, original wallet/market/args kept, in-flight guard per wallet+market+method, resume by hash, read-back with the original wallet, no "latest record" or wallet-diff logic anywhere.
- **Demo Mode**: `src/data/demo.ts` (seeded fixtures, ids like `demo-0001`). Always labelled DEMO; never auto-selected after a live failure.

## Integration boundary
`src/data/contract/adapter.ts` defines `ContractAdapter` (read market, user prediction, points, history, submit). These are UI concepts, not contract method names.
`src/data/contract/genlayerAdapter.ts` is inert: with no config it returns `not-configured`; with config it returns `unavailable` until the schema is mapped. Writes throw.

## Needed from the project owner
1. Deployed contract address, network name, chain ID, RPC URL (set `VITE_GENLAYER_*`, `VITE_CONTRACT_ADDRESS`; see `.env.example`).
2. Then inspect source/schema (`client.getContractSchema(address)`) and confirm: view methods, write methods, arg order/types, returns, whether predictions are editable before open, how results/points are exposed (and provisional vs final).

## genlayer-js findings (installed 1.1.8, read from its type definitions and the official boilerplate)
- `createClient({ chain, endpoint?, account?, provider? })`; chains in `genlayer-js/chains`: `studionet`, `localnet`, `testnetAsimov`, `testnetBradbury`. `studionet` id is 61999.
- `readContract({address, functionName, args})`, `writeContract({address, functionName, args, value})` (value is required), `waitForTransactionReceipt({hash, status?, interval?, retries?})`, `getTransaction({hash})`, `getContractSchema(address)`.
- Statuses: PENDING, PROPOSING, COMMITTING, REVEALING, ACCEPTED, UNDETERMINED, FINALIZED, CANCELED, APPEAL_*, READY_TO_FINALIZE, *_TIMEOUT. Mapped in `phaseFromStatus`.
- **1.1.8 exports no `isSuccessful()`**; the tracker checks `txExecutionResultName === "FINISHED_WITH_RETURN"` (`executionSucceeded`). Re-check this when the SDK version is chosen. Latest `rc` tag is 2.0.0-rc.3; do not mix it with stable examples.
- The boilerplate frontend (Next.js + wagmi) uses `createClient({chain: studionet, account})`; PM Kit is Next.js + Privy/wagmi with betting/bridge, none of which was used.
- Not verified here: the docs pages for networks/writing-data were not reachable (allowlist), so network values beyond the SDK's own definitions are unconfirmed.

## Tests actually run (see final report for results)
Domain, market-data, wallet, presentation, 10 transaction-journal regression scenarios and UI flows. Real-browser screenshots at 1440, 1024, 768, 390, 320; live rendering checked with mocked Binance responses (the build environment cannot reach Binance).

## Known limitations
- No real contract reads/writes/tx tracking yet (by design). `isSuccessful`-style check and read-back mapping need the real schema.
- Real Binance was not reachable from the build sandbox; the live path is tested with mocked responses.
- No real wallet (MetaMask) was used; wallet logic is tested with fake EIP-1193 providers.
- No Playwright e2e suite committed; UI tests use jsdom with the chart mocked.
- Landing hero is an illustration of the rule, not a screenshot of the app.
