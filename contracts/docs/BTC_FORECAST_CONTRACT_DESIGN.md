# BTC Forecast — Contract Design (post-audit)

Contract: `contracts/btc_forecast.py` · class `BTCForecast` · SDK generation "A" (boilerplate naming) · runner `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6`
Companion report: `docs/BTC_FORECAST_SECURITY_AUDIT.md` (findings, evidence, residual risks).
Labels: **[V]** verified by running code or reading the SDK/official docs · **[U]** unverified in this environment.

## 1. Contract responsibilities

A non-financial daily prediction game on Binance Spot BTCUSDT 1d candles (UTC). Users predict UP / DOWN / FLAT before the candle opens; anyone can resolve the market after the candle closes through a two-stage, validator-checked process; each user then claims one point per correct prediction. No tokens, bets, administrator or manual override. One contract, no registry, no LLM.

## 2. Market identity

A market is the UTC opening timestamp `t` (`market_open_time_ms`) of a daily candle. Valid iff it is an `int` (not `bool`), `MIN_MARKET_OPEN_MS ≤ t ≤ 2^63−1`, and `t % 86_400_000 == 0`. Exchange, symbol, interval and timezone are constants (`BINANCE_SPOT`, `BTCUSDT`, `1d`, `UTC`). Candle interval `[t, t+DAY_MS)`; expected inclusive Binance close time `t + DAY_MS − 1`. No `create_market`; storage is created only by a prediction or an observation.

## 3. Prediction lifecycle

`submit_prediction(t, prediction)`, owner = `gl.message.sender_address` (no owner parameter exists; passing one raises `TypeError`). Prediction must equal one of the three enum strings. Allowed only while `now < t` and `t ≤ now + 7·DAY_MS`: always exactly the next seven UTC daily markets. Editing before open replaces the single record `(t, user)`. `market_pred_count[t]` counts a user once.

## 4. Market lock rules

`now = datetime.now(timezone.utc)` read in deterministic code only (never inside leader/validator functions), converted to integer ms by timedelta floor-division (no float). Locked from `now == t` (inclusive). Time points are derived, never stored as a status: OPEN `now<t`; LOCKED `t≤now<t+DAY`; WAITING `now<t+DAY+GRACE`; OBSERVABLE afterwards; RESOLVED iff a settlement record exists.

## 5. Binance data source

One canonical source: `GET https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d&timeZone=0&startTime=<t>&endTime=<t>&limit=1`. No API key, no caller-supplied URL/path/symbol, no fallback host or exchange. A second host serving Binance data would not be independent corroboration and is deliberately absent (test `test_D_exactly_one_url_literal_and_one_host`).
**[U]** Binance's official klines documentation does not state whether `startTime`/`endTime` are inclusive; `startTime=endTime=<t>` follows the specification and must be confirmed against a live request.

## 6. Response parser (bounded, linear)

Order matters: HTTP status exactly 200 → body not `None`, non-empty and ≤ 8,192 bytes **before any decoding** → UTF-8 + `json.loads` → root is a list → exactly one row → row is a list of exactly 12 cells → `row[0]` is a real `int` equal to `t` → `row[6]` is a real `int` equal to `t+DAY−1` → `row[1]`, `row[4]` pass the decimal parser. Booleans, floats, strings in timestamp cells are rejected. No regex, no HTML handling, no price extraction from text; `RecursionError` is classified. High/low/volume cells are not read.
Limit: the 8,192-byte check is **application-level, after the body is materialized**. The SDK web call exposes no response-size parameter **[V: `WebRequest` carries only url/method/body/headers]**; a transport-level download cap is therefore **not achieved**.

## 7. Exact decimal comparison

Single pass over a string of ≤ 32 chars: `digits+ ('.' digits+)?`, ASCII `0-9` checked by membership (not `isdigit`), ≤ 18 integer and ≤ 12 fractional digits, positive. Leading zeros and trailing fractional zeros are stripped; value kept as `(int, scale)`; comparison aligns scales with integer multiplication. `1.0 == 1.000` ⇒ FLAT. Canonical strings (e.g. `"100.00000000"→"100"`) are what is bound and stored. Tests compare 27 price pairs against an independent `decimal.Decimal` oracle, plus 33 malformed strings (signs, exponents, whitespace, full-width/Arabic digits, `NaN`, 19/40/5,000-char inputs).

## 8. Leader–validator architecture (safe API)

`gl.vm.run_nondet(fetch, validate)` (Gen A name of the safe API; `run_nondet_default` in the newer naming). **[V from SDK source]**: the validator function runs in a `spawn_sandbox` sub-VM; it must return `bool`; a validator `UserError` is compared with the leader's `UserError` by message; a type mismatch (leader error vs validator success or the reverse) is a disagreement.
`fetch` = fixed request + validation + canonical record. `validate(leader_res)` **re-fetches first**, then requires `isinstance(leader_res, gl.vm.Return)`, then compares the **whole record, type-exact** (`json.dumps(sort_keys=True)`, so `1`, `1.0`, `true` differ). The validator never judges the leader's JSON by format; a well-formed false record disagrees. Both functions contain no storage access, clock reads or caller-controlled text (AST-checked). The accepted record is re-validated deterministically and the outcome recomputed before any write.
Canonical record (all bound): `source, exchange, symbol, interval, timezone, open_time_ms, close_time_ms, open_price, close_price, outcome`.

## 9. Consensus trust assumptions

Consensus verifies that independent validators, each retrieving the fixed Binance endpoint, obtained identical normalized evidence and that the leader reported exactly that. Binance is trusted to publish correct data. Consensus **cannot** prove Binance correct, nor that a published historical candle will never be corrected. Several validators reading the same host are not independent sources. If Binance is unavailable, nothing is stored and resolution stays retryable. An accepted settlement is never rewritten, even if Binance later corrects history.

## 10. Candidate observation (stage 1)

Allowed when `now ≥ t + DAY_MS + RESOLUTION_GRACE_MS` (300,000 ms), the market has ≥ 1 prediction, and no settlement exists. After consensus the evidence is stored as a **Candidate** with `observed_at_ms = now` and the call returns `CANDIDATE_RECORDED`. A candidate is not a settlement: claims stay impossible.

## 11. Confirmation and final settlement (stage 2)

A later call is accepted only when `now ≥ candidate.observed_at_ms + CONFIRMATION_INTERVAL_MS` (300,000 ms); earlier calls revert without fetching. It fetches again through fresh consensus. If **every** evidence field equals the stored candidate: derive outcome again, write the **Settlement**, return `RESOLVED`. If any field differs: replace the candidate with the new accepted evidence, reset `observed_at_ms`, return `CANDIDATE_REPLACED`. A resolved market returns its stored result without any fetch.
Both intervals are operational safety policy, not proof that Binance has finished publishing or will never correct data.

## 12. Failure and retry behavior

Failures (HTTP 429/500/502/503/504, timeout, connection error, null/empty body, invalid UTF-8/JSON, wrong or missing candle, malformed row) raise a classified `UserError` (`[EXTERNAL]`, `[TRANSIENT]`, `[EXPECTED]`); the transaction fails and **no state changes**: no candidate, no replacement of an existing candidate, no settlement, no FLAT default, no persistent failure flag. Matching failures on leader and validator agree only that the call fails; they are never evidence of a result. Any later permissionless transaction retries.

## 13. Persistent storage model

```
predictions:       TreeMap[str, Prediction]  key "<t>:<addr_hex>"   {choice u8, submitted_at_ms u64, processed bool}
candidates:        TreeMap[str, Candidate]   key "<t>"              evidence fields + observed_at_ms u64
settlements:       TreeMap[str, Settlement]  key "<t>"              evidence fields + first_observed_at_ms, resolved_at_ms
scores:            TreeMap[str, u64]         key "<addr_hex>"
market_pred_count: TreeMap[str, u32]         key "<t>"
```
Flat string keys (digits, `:`, fixed 40 hex chars) cannot collide; no tuple keys, no nested maps. Claim status lives in `Prediction.processed`. No loop over participants anywhere. Scores are `u64`. Constructor: zero arguments.

## 14. Point claims

`claim_points(t)`: settlement must exist (a candidate is not enough); caller must have a prediction; not processed. Correct ⇒ +1; incorrect ⇒ +0; either way `processed = True`. Repeats revert and never change the score.

## 15. Security invariants

I1 unique market identity · I2 fixed source/symbol/interval/timezone · I3 one prediction per (market,user) · I4 no prediction at/after open · I5 enum-only predictions · I6 no observation before close+grace · I7 exact candle identity (open and close timestamps) · I8 whole-record validator equality · I9 stored outcome = recomputed outcome · I10 no accepted consensus ⇒ no write · I11 no finalization from a single observation · I12 changed evidence never finalizes and restarts the interval · I13 settlement immutable, never refetched · I14 one-time scoring, exact-match points · I15 caller isolation (`sender_address`) · I16 no partial writes · I17 no participant loop.

## 16. Known limitations

Binance single-source trust and possible later corrections; weaker finality evidence than a closed-candle flag (REST has none) compensated only by policy delays; application-level (not transport-level) size bound; `startTime`/`endTime` inclusivity unverified; transaction-timestamp provenance, real-VM closure pickling, real multi-validator consensus, GenVM→Binance connectivity and appeal/finality behavior unverified (Studio not run); SDK generation differs from the newer API named in the audit task; resolution requires ≥ 1 prediction (anti-spam choice, not in the product rules); sybil accounts cannot be prevented at contract level; `resolve_market` now returns a status `dict` and a new view `get_market_candidate` exists (ABI change for any client).
