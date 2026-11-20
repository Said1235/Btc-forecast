# BTC Forecast — Security Audit, Architecture Review and Remediation (final)

Audited contract: `contracts/btc_forecast.py` (single Intelligent Contract `BTCForecast`)
Design document: `docs/BTC_FORECAST_CONTRACT_DESIGN.md`
Labels: **[CONFIRMED]** reproduced by running code · **[SOURCE]** established from SDK source / official docs · **[UNVERIFIED]** could not be checked here.
Line numbers refer to the **final** contract unless marked "v1" (the first implementation, audited and then replaced).

---

## 0. Conclusion (read this first)

**The contract is not declared secure and is not ready for a public deployment.**

- No CRITICAL or HIGH finding is confirmed, and no confirmed vulnerability remains open. Every confirmed defect found in the original code is fixed with a regression test.
- Three items that could be security-relevant **cannot be verified without a real GenLayer Studio / network** and remain open (§5): transaction-timestamp provenance (prediction deadline), real multi-validator consensus plus GenVM access to Binance, and the SDK generation required by the audit task. Until they are verified, a potentially-HIGH risk (deadline bypass if a sender can influence the transaction time) is **not excluded**.
- Passing tests were not used as the conclusion. 340 Direct Mode tests pass, and 27 deliberate bugs (mutants) were all detected, but Direct Mode uses mocks, the older SDK bundle, and a validator model reproduced from SDK source.

## 1. What could not be done (scope limits)

1. **The real repository was not available.** Inspected: the public `genlayer-project-boilerplate` clone in which the contract was written. No deployment was performed (none was allowed).
2. **Studio / real consensus not run.** No Studio is reachable here; there is no Studio test file because I will not ship an unrun test as evidence.
3. **GenVM → Binance connectivity unverified.** This sandbox cannot reach Binance; all Binance data in tests is mocked.
4. **The newer API generation named in the audit task is untestable here.** The task names `gl.contract.Contract` / `gl.vm.run_nondet_default` (SDK `main`, v0.4.0-rc1, runner `kzybg95x…`). Obtainable toolchain: GenVM release tags end at `v0.3.0-rc7` (its asset returns HTTP 404), `genlayer-test` ends at 0.29.2, and tests ran on the `v0.2.16` SDK bundle (runner `1jb45aa8…`).
5. I authored the audited code; this is not an independent third-party review.

## 2. Findings

Class: **V** = confirmed vulnerability · **D** = design weakness · **S** = deviation from the authoritative specification · **L** = runtime/transport limitation · **U** = unverified · **I** = inherent / informational.
"Formerly" = ID in the previous report.

| ID | Sev. | Class | Title | Status |
|---|---|---|---|---|
| A-01 | MEDIUM | S, D | Finalization from a single observation, no post-close grace (v1) | **Fixed** |
| A-02 | MEDIUM | D | Unsafe nondeterministic API, hand-rolled validator error handling (v1) — formerly F-01 | **Fixed** |
| A-03 | MEDIUM | S | Deploy script targets a different contract (`football_bets.py`) | **Corrected** (artifact provided; not deployed) |
| A-04 | LOW | V | Validator equality accepted `1.0` for `1` (v1) — formerly F-05 | **Fixed** |
| A-05 | LOW | V | Vacuous pickling test (false assurance) (v1 tests) — formerly F-06 | **Fixed** |
| A-06 | LOW | S | Resolved market reverted instead of returning its result (v1) | **Fixed** |
| A-07 | LOW | S | Request shape differed from the specification (`limit=2`, no `endTime`, 2 rows) (v1) — formerly F-02 | **Fixed** (see A-12) |
| A-08 | LOW | D | High/low sanity check added permanent-unresolvability risk for no benefit (v1) — formerly F-07 | **Fixed** (removed) |
| A-09 | INFO | D | Scores were `u32` | **Hardened** (`u64`) |
| A-10 | LOW | D | Broad `except Exception` around the web call; `RecursionError` unclassified — formerly F-09 | **Partly hardened** |
| A-11 | MEDIUM | U | Transaction-timestamp provenance — formerly F-03 | **Open** |
| A-12 | MEDIUM | U, I | Finality evidence is policy-based; `startTime`/`endTime` inclusivity undocumented by Binance | **Open** |
| A-13 | MEDIUM | U | SDK generation differs from the audit task — formerly F-04 | **Open** |
| A-14 | LOW | L | No transport-level response-size limit | **Cannot be fixed with the current API** |
| A-15 | LOW | S (decision) | Resolution requires ≥ 1 prediction — formerly F-08 | **Open (your decision)** |
| A-16 | INFO | I | Single-source trust, sybil accounts, appeals/finality, `MIN_MARKET_OPEN_MS` | Documented |

### A-01 — MEDIUM — Single-observation finalization, no grace (v1)
v1 wrote an irreversible settlement from one observation and had no post-close delay; the authoritative rules forbid both ("Do not finalize a market from a single observation"). Not an exploit I could demonstrate; the impact would be an irreversible settlement from one transient, provisional or glitched response. (v1's "next candle exists" signal reduced, but did not remove, this.)
**Fix** (`contracts/btc_forecast.py`): `RESOLUTION_GRACE_MS` and `CONFIRMATION_INTERVAL_MS` = 300,000 (L39–40); window check L406; `Candidate` storage; interval check L426 (and again after consensus L462); finalize only when `_candidate_matches` (L330, L464) — every evidence field; otherwise the candidate is replaced and the timer restarts.
**Regression tests** (`test_btc_forecast_security.py`): `test_F_no_resolution_before_candle_close_plus_grace[9 boundaries]`, `test_F_exact_lifecycle_by_an_arbitrary_third_party`, `test_F_candidate_is_not_a_settlement`, `test_G_identical_second_observation_finalizes`, `test_G_changed_evidence_never_finalizes_and_restarts_the_interval[5]`, `test_G_candidate_can_be_replaced_repeatedly`, `test_G_equivalent_representations_count_as_identical_evidence`. Mutants M01–M08 (no interval, no grace, off-by-one grace, first observation finalizes, match always true / ignoring a price, timer not reset) all killed.

### A-02 — MEDIUM — Unsafe nondeterministic API (v1) **[SOURCE]**
`run_nondet_unsafe` runs the validator without an extra sandbox; any non-`UserError` validator exception can only be a Disagree. The safe `run_nondet` runs the validator in a `spawn_sandbox` sub-VM, requires a `bool` return, compares user/VM errors by message, and treats a leader/validator result-type mismatch as disagreement. The validator re-fetches first so its own errors reach that comparison.
**Fix:** L431–444 (`validate`, `gl.vm.run_nondet`). **Tests:** `test_B_no_llm_unsafe_api_float_or_regex_anywhere`, `test_E_*` (below), mutants M15, M16 killed.

### A-03 — MEDIUM — Deployment points at another contract
`deploy/deployScript.ts` line 13 reads `contracts/football_bets.py`. Deploying with it would not deploy the audited source. **Correction:** `deploy/deployScript.ts` (delivered) changes only that path to `contracts/btc_forecast.py`; constructor args `[]` already match the zero-argument constructor. Nothing was deployed. Your own repository's deploy artifacts were not available: check them.

### A-04 — LOW **[CONFIRMED]** — Validator equality
v1 compared `leader.calldata == mine`; with a `leader_result` carrying `float(T)` the validator accepted it. Unreachable through real calldata (no floats) but it weakened "identical evidence". **Fix:** `_same_record` L211 (canonical JSON). **Tests:** `test_V_tampered_leader_record_disagrees[15 cases incl. float/str/bool/None]`; mutant M17 killed.

### A-05 — LOW **[CONFIRMED]** — Vacuous test
Direct Mode only pickle-checks the **safe** API and only **warns**. **Fix:** `test_closures_are_picklable_in_direct_mode` promotes the warning to a failure; mutant M25 (closure captures an unpicklable lock) killed. Real-VM pickling remains **[UNVERIFIED]** (Direct Mode pickles by reference inside one process).

### A-06 — LOW — Resolved market handling
The rules say a resolved market returns its existing result and never refetches. **Fix:** L411 (returns stored result, no fetch). **Tests:** `test_J_resolved_market_returns_existing_result_without_fetching`, `test_J_conflicting_data_after_settlement_cannot_change_the_result` (a spy on `gl.nondet.web.get` records zero calls); mutant M09 killed.

### A-07 / A-08 — request shape and high/low check
Now exactly: `…symbol=BTCUSDT&interval=1d&timeZone=0&startTime=<t>&endTime=<t>&limit=1` (L148–159) and exactly one 12-cell row. Strict mock regexes anchor the full URL, so a different request fails the test (`test_exact_request_shape_is_fixed`; mutant M11 killed; M12 accepts-multiple-rows killed). The high/low parsing was removed: the specification only needs indexes 0, 1, 4, 6, and the extra check could only make a legitimate row permanently unresolvable.

### A-09 / A-10 — hardening
Scores `u64` (L364). `RecursionError` is classified (L173); depth 100 / 3,000 / 4,090 JSON all produce a classified error (`test_A_deeply_nested_json_is_classified_not_crashed`); a crash was **not** reproduced on CPython 3.12. The broad `except Exception` at L163 is kept because the exception class raised by a failed GenVM web call is unknown; it wraps only the single `get` call.

### A-11 — MEDIUM (potentially HIGH) **[UNVERIFIED]** — Transaction timestamp
The prediction deadline (I4) and the resolution gates (I6, I10 timing) rest entirely on `datetime.now(timezone.utc)` (L262–267) being the consensus transaction time. The Transaction Context page says GenVM pins the clock to the transaction datetime; I could not establish **who sets that value**. If a sender can influence it, the deadline can be bypassed. **Required:** a Studio test with controlled timing and the GenLayer transaction-execution documentation.

### A-12 — MEDIUM **[UNVERIFIED]** — Finality and request semantics
The REST row has no closed-candle flag and its `closeTime` is the nominal interval end even mid-day; with `limit=1` the response alone cannot prove finality. Protection is **policy**: grace + two independent observations ≥ 5 min apart with identical evidence. This does not exclude a stale/cached identical response served twice, nor a later Binance correction. Binance's documentation does not state whether `startTime`/`endTime` are inclusive; the specified `startTime=endTime=<t>` must be confirmed on a live request. v1's "next candle exists" signal was dropped because the specification requires exactly one row; that is a weaker, accepted trade-off.

### A-13 — MEDIUM **[UNVERIFIED]** — SDK generation
Contract uses `gl.Contract`, `TreeMap`, `gl.vm.run_nondet`, runner `1jb45aa8…`. The audit task requires the newer names. Mapping (same intent): `run_nondet` (old) ≡ `run_nondet_default` (new); `run_nondet_unsafe` (old) ≡ `run_nondet` (new); `.message` ≡ `.data`; `datetime.now(timezone.utc)` ≡ `gl.vm.get_timestamp()`. Porting without a newer linter/test runner would be unverified code, so it was not done.

### A-14 — LOW — Transport-level size limit **[SOURCE]**
`gl.nondet.web.get` sends only `{url, method, body, headers}`; there is no size parameter. The 8,192-byte check (L170) runs after the body is materialized and **before** decoding or parsing (test `test_A_size_guard_runs_before_decode_300kb_invalid_utf8` proves the order). A true download cap is **not achieved**; whether the GenVM host enforces one is **[UNVERIFIED]**.

### A-15 — LOW (decision)
`resolve_market` requires ≥ 1 prediction (anti-spam; markets nobody predicted cannot be settled). The product rules do not state it. Decide: keep (safest for the MVP) or remove.

### A-16 — INFORMATIONAL
Single-source trust in Binance (consensus verifies agreement, not truth; a later correction never rewrites a settlement; unavailable Binance ⇒ retryable, nothing stored). `sender_address` is the immediate caller (a calling contract becomes the scoring identity). Nothing stops one person from using several accounts. A "decided" resolution may be subject to appeal **[UNVERIFIED]**. `MIN_MARKET_OPEN_MS` (BTCUSDT listing date) is from memory **[UNVERIFIED]** and only bounds accepted timestamps.

## 3. Source / deployment consistency report

| Check | Result |
|---|---|
| Source compiled/deployed by the (corrected) script | `contracts/btc_forecast.py` — after correction A-03 |
| Source executed by tests | `tests/direct/btc_helpers.py: CONTRACT = "contracts/btc_forecast.py"` — **same file** |
| Delivered vs tested source | byte-identical, sha256 `06d4275b39cf0f274a4effd97f9c85f7b7f485d550c370ab0baa7548d47aba89` |
| Runner header | `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6` (pinned hash, no `latest`) |
| Linter / SDK | `genvm-linter 0.11.0`; SDK bundle `v0.2.16` (the `v0.3.0-rc7` the test runner requests returns 404) |
| Repo pins | `genlayer-test @ …@v0.29`, `genvm-linter @ …@main` (requirements.txt) — the second is unpinned |
| Constructor | 0 parameters; deploy script passes `args: []` |
| Schema | 7 methods: write `submit_prediction`, `resolve_market` (returns `dict`), `claim_points`; view `get_prediction`, `get_market_candidate` (new), `get_market_result`, `get_user_points` |
| Generated interfaces / other artifacts | none exist for this contract; `artifacts/` is empty |
| Frontend | not touched; note the ABI change (`resolve_market` now returns a status dict; new view) |

## 4. Test evidence

Environment: Python 3.12, `genlayer-test 0.29.2`, SDK bundle `v0.2.16` copied from the linter cache into the test runner's cache (workaround for the 404 above).

Commands executed:
```
genvm-lint check contracts/btc_forecast.py --json
genvm-lint schema contracts/btc_forecast.py --json
python3 -m pytest tests/direct/test_btc_forecast.py tests/direct/test_btc_forecast_security.py -q
python3 /tmp/mutall.py        # 27 mutants, each run against both test files
```

| Layer | Result |
|---|---|
| Static / lint / validate | passed, 0 warnings; ctor 0 params; 3 write + 4 view |
| Direct Mode, `test_btc_forecast.py` | **158 passed**, 0 failed, 0 skipped |
| Direct Mode, `test_btc_forecast_security.py` | **182 passed**, 0 failed, 0 skipped |
| Total | **340 passed** |
| Strict mocks | every web mock must be matched (unused mock ⇒ failure at teardown); mocks anchor the exact URL incl. `startTime=endTime`, `limit=1` |
| Validator agreement/disagreement | via `vm.run_validator()` + a helper reproducing the SDK's sandbox-wrapper rules (see below) |
| Pickling | checked in Direct Mode, warning promoted to failure |
| **Studio Mode / real consensus** | **NOT RUN** |
| Mutation check | **27 / 27 killed** (one initially survived: the redundant timestamp upper bound; a test was added and it is now killed) |

Coverage of the required test groups: A hostile payloads (300 KB HTML, oversized JSON, 8,192/8,193 boundary, junk around valid JSON, BOM, deep nesting, size guard before decode) · B injection and static audit (AST: no LLM/unsafe/float/regex, closures free of storage/clock, interface accepts only a timestamp) · C wrong-candle (28 malformed shapes + 6 wrong roots) · D single source · E HTTP/timeouts/null/empty/invalid UTF-8/JSON — 11 failure kinds × leader-only, validator-only, both, initial tx, confirmation tx · F third-party timing (9 pre-window boundaries, exact grace, 1 ms before/at confirmation) · G candidate changes · H decimals vs oracle · I prediction/claim rules (injection strings, spoofing, horizon, lock boundary) · J idempotency, sequential callers, no partial mutation.

**Direct Mode limitation on validators [CONFIRMED]:** `run_validator()` calls the validator function directly (no sandbox), and a validator is registered only when the leader succeeded. The helper `votes()` reproduces the SDK's rules (return bool; type mismatch ⇒ False; `UserError` messages compared). Concurrent execution cannot be simulated; the post-consensus re-read (L450–462) is covered only by inspection and by the sequential-caller tests.

## 5. Unresolved items

| Item | Why open | What closes it |
|---|---|---|
| A-11 timestamp provenance | Not documented on pages read; cannot be tested offline | Studio test + GenLayer transaction-execution docs |
| Real consensus, Binance connectivity from GenVM, real-VM pickling, appeals | No Studio | A Studio run: deploy, observe, confirm one real closed candle, force a validator disagreement |
| A-12 `startTime`/`endTime` semantics, caching | No Binance access | One live request per candle; compare two requests ≥ 5 min apart |
| A-13 SDK generation | No newer toolchain obtainable | Tell me the runner your Studio serves |
| A-15 resolution guard | Product decision | Keep or remove |
| A-14 transport size limit | No API for it | GenLayer host limit, if any |

## 6. Trust boundary (explicit)

- **GenLayer consensus verifies:** that validators, each fetching the fixed Binance endpoint, produced a canonical evidence record identical to the leader's, and that the record is internally consistent (outcome recomputed).
- **Binance is trusted to provide:** the correct open and close of the target daily candle, and stable data between observations.
- **Consensus cannot prove:** that Binance is correct, that the REST row is final, or that history will never be corrected. Two matching observations are **not** cryptographic proof.
- **If Binance is unavailable:** nothing is stored; any later caller retries.
- **If Binance corrects history later:** an accepted settlement is not rewritten (by design).
