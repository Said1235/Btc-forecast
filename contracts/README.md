# BTCForecast Intelligent Contract (authoritative source)

`btc_forecast.py` is the contract the frontend talks to. It is the exact source deployed on **GenLayer StudioNet** at
`0x8AB7b7FB6771cb91d65623964df704c075e7e2b7` ([explorer](https://explorer-studio.genlayer.com/address/0x8AB7b7FB6771cb91d65623964df704c075e7e2b7)).
It is included unmodified; upstream: https://github.com/Said1235/BTC-Forest-Intelligent-Contract

SHA-256 of `btc_forecast.py`: `06d4275b39cf0f274a4effd97f9c85f7b7f485d550c370ab0baa7548d47aba89`

## Methods and the client calls that use them

| Contract method | Kind | Frontend call (`src/data/contract/genlayerAdapter.ts`) |
|---|---|---|
| `submit_prediction(market_open_time_ms, prediction)` | write | `writeContract` after `simulateWriteContract` |
| `resolve_market(market_open_time_ms)` | write | `writeContract` |
| `claim_points(market_open_time_ms)` | write | `writeContract` after `simulateWriteContract` |
| `get_prediction(market_open_time_ms, user_address)` | view | `readContract` |
| `get_market_candidate(market_open_time_ms)` | view | `readContract` |
| `get_market_result(market_open_time_ms)` | view | `readContract` |
| `get_user_points(user_address)` | view | `readContract` |

`src/data/contract/contractSource.test.ts` reads `btc_forecast.py` and fails if the client calls a method the contract does not
have, or if the timing rules shown in the UI drift from the contract's constants.

## Binance settlement logic

`resolve_market` is the only method that reaches outside the chain. Inside `gl.vm.run_nondet`, the leader and every validator
independently fetch the closed daily candle from
`https://data-api.binance.vision/api/v3/klines` (`BTCUSDT`, `1d`, `timeZone=0`, exactly one row for the market's open time) and
validate it strictly (HTTP status, body size, JSON shape, 12-field row, exact open and close times, decimal format). The
validators accept only if their own fetch equals the leader's record field by field. The outcome (UP, DOWN or FLAT) is
derived from the open and close prices. A result is stored only after a confirmation interval, and an accepted result is
never overwritten.

## Rules the UI mirrors

| Rule | Value |
|---|---|
| Predictions editable until | 00:00 UTC of the market day |
| Prediction horizon | 7 days ahead |
| Resolution opens | market close + 5 min grace (`RESOLUTION_GRACE_MS`) |
| Confirmation interval | 5 min (`CONFIRMATION_INTERVAL_MS`) |
| Resolution needs | at least one prediction |
| Points | 1 per correct call, only after `claim_points` |
| Error prefixes | `[EXPECTED]`, `[EXTERNAL]`, `[TRANSIENT]` |

## Other material

- `docs/`: design document and security audit.
- `tests/direct/`: contract tests (see `requirements.txt` for the tooling versions).
- `deploy/deployScript.ts`: deployment script.
