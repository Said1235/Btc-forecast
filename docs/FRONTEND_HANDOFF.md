# BTC Forecast: frontend handoff (contract connected)

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

## Contract integration (StudioNet)
- Network StudioNet, chain ID 61999, RPC `https://studio.genlayer.com/api`, contract `0x8AB7b7FB6771cb91d65623964df704c075e7e2b7` (`src/config.ts`; overridable with `VITE_*`). Chain ID and RPC match genlayer-js 1.1.8 `studionet`.
- The contract source in `Said1235/BTC-Forest-Intelligent-Contract` was compared with the file supplied in chat: identical. The mapping below comes from that source.
- Writes (all via `writeContract`, value 0, tracked by exact hash): `submit_prediction(market_open_time_ms:int, prediction:"UP"|"DOWN"|"FLAT")`, `resolve_market(ms)`, `claim_points(ms)`.
- Views: `get_prediction(ms, Address)`, `get_market_candidate(ms)`, `get_market_result(ms)`, `get_user_points(Address)`. Address arguments are sent as `CalldataAddress` (a plain string would be encoded as `str`).
- Rules reflected in the UI: a prediction can be changed until the market's 00:00 UTC start and must be within 7 days; resolution is two permissionless steps (candidate after 5 min grace, confirmation 5 min later, both need >= 1 prediction); points exist only after `claim_points`. Provisional candidate and final result are shown separately.
- No history view exists, so "My activity" reads the last 7 closed markets one by one.
- Before sending `submit_prediction`/`claim_points`, `simulateWriteContract` is run; an `[EXPECTED]` refusal stops the call before the wallet prompt. `resolve_market` is not simulated (it does a web fetch).
- The contract fetches Binance from `data-api.binance.vision`; the chart uses `api.binance.com`. Same market data, different host.

## genlayer-js findings (installed 1.1.8, read from its type definitions and the official boilerplate)
- `createClient({ chain, endpoint?, account?, provider? })`; chains in `genlayer-js/chains`: `studionet`, `localnet`, `testnetAsimov`, `testnetBradbury`. `studionet` id is 61999.
- `readContract({address, functionName, args})`, `writeContract({address, functionName, args, value})` (value is required), `waitForTransactionReceipt({hash, status?, interval?, retries?})`, `getTransaction({hash})`, `getContractSchema(address)`.
- Statuses: PENDING, PROPOSING, COMMITTING, REVEALING, ACCEPTED, UNDETERMINED, FINALIZED, CANCELED, APPEAL_*, READY_TO_FINALIZE, *_TIMEOUT. Mapped in `phaseFromStatus`.
- **1.1.8 exports no `isSuccessful()`**; the tracker checks `txExecutionResultName === "FINISHED_WITH_RETURN"` (`executionSucceeded`). Re-check this when the SDK version is chosen. Latest `rc` tag is 2.0.0-rc.3; do not mix it with stable examples.
- The boilerplate frontend (Next.js + wagmi) uses `createClient({chain: studionet, account})`; PM Kit is Next.js + Privy/wagmi with betting/bridge, none of which was used.
- Not verified here: the docs pages for networks/writing-data were not reachable (allowlist), so network values beyond the SDK's own definitions are unconfirmed.

## Tests
`npm test` (96 tests: domain, Binance, wallet, adapter with a fake SDK, 10 journal regression scenarios, UI flows). Live checks, run on a machine with internet: `npm run test:live` (Binance) and `npm run test:studio` (Studio RPC, chain id, contract schema, public reads).

## Known limitations
- Contract calls were NOT executed against StudioNet from the build environment (RPC blocked). The adapter is tested with a fake SDK; run `npm run test:studio` and one real prediction to confirm.
- Real Binance was not reachable from the build sandbox; the live path is tested with mocked responses.
- No real wallet (MetaMask) was used; wallet logic is tested with fake EIP-1193 providers.
- No Playwright e2e suite committed; UI tests use jsdom with the chart mocked.
- Landing hero is an illustration of the rule, not a screenshot of the app.

## StudioNet RPC rate limiting (fix)

- Cause (probable, measured on our side): the page issued 28 `gen_call` reads on load and again every 60 s (56 in 70 s), uncached and unpaced, plus a 3 s receipt poll and a fresh write client per send. That traffic shares the Studio RPC limit with the wallet's own `eth_sendRawTransaction` to its configured 0xf22f RPC. After the fix: 14 reads on load, 14 in 70 s. The wallet-side error itself cannot be reproduced from the sandbox.
- `src/rpc/gate.ts`: reads are deduplicated, cached (TTL), paced, paused on rate limit (backoff + jitter + Retry-After, max 3 retries); writes are serialized per account+chain and enter a cool-down after a limit, enforced before the wallet is asked to sign.
- `verifyStudioNetwork` (adapter): before every write checks wallet `eth_chainId` = 0xf22f, both clients' `chain.id` = 61999 and effective RPC = `https://studio.genlayer.com/api`, and that read and write clients agree.
- States: `rate-limited` (nothing sent, provable) and `send-rate-limited` (the send was limited; acceptance not proven, never resent automatically). Recovery: "Check before retrying" reads nonce (latest/pending vs nonce recorded before signing) and contract state; only sufficient evidence reopens the send. "I checked: it was not sent" is a manual user decision.
- Known limit: genlayer-js 1.1.8 `writeContract` makes its own nonce/gas/receipt RPC calls internally (no retry, `retryCount: 0`); they cannot be routed through the gate.
