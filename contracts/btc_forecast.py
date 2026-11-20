# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""
BTCForecast - daily Binance Spot BTCUSDT (1d, UTC) prediction game.

No bets, tokens or admin. A market is identified by the UTC opening timestamp
of its daily candle. Resolution is two-stage and permissionless:

  1. After the candle closed + RESOLUTION_GRACE_MS, anyone may trigger a
     CANDIDATE observation (provisional, not a settlement).
  2. After CONFIRMATION_INTERVAL_MS, anyone may trigger a CONFIRMATION. Fresh,
     independently validated evidence identical to the stored candidate
     finalizes the market; different evidence only replaces the candidate and
     restarts the interval.

Every observation uses a leader/validator pair on the SDK's SAFE API
(gl.vm.run_nondet): each validator independently re-fetches the evidence and
must produce an identical canonical record (whole-record, type-exact equality).
No LLM is involved anywhere.

SDK generation: "A" (boilerplate / docs.genlayer.com naming).
"""

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from genlayer import *

# ----------------------------------------------------------------------------
# Fixed business configuration (callers can never change any of this)
# ----------------------------------------------------------------------------
DAY_MS = 86_400_000
HORIZON_MS = 7 * DAY_MS
MIN_MARKET_OPEN_MS = 1_502_928_000_000  # 2017-08-17T00:00:00Z
MAX_MARKET_OPEN_MS = (1 << 63) - 1  # keeps every stored u64 in range

# Policy parameters (operational safety policy, NOT proof that Binance will
# never correct historical data).
RESOLUTION_GRACE_MS = 300_000
CONFIRMATION_INTERVAL_MS = 300_000

SOURCE = "binance-spot-data-api-vision"
EXCHANGE = "BINANCE_SPOT"
SYMBOL = "BTCUSDT"
INTERVAL = "1d"
TIMEZONE = "UTC"
KLINES_URL = "https://data-api.binance.vision/api/v3/klines"

CHOICE_CODES = {"UP": 1, "DOWN": 2, "FLAT": 3}
CHOICE_NAMES = {1: "UP", 2: "DOWN", 3: "FLAT"}

MAX_BODY_BYTES = 8192
MAX_DECIMAL_LEN = 32
MAX_INT_DIGITS = 18
MAX_FRAC_DIGITS = 12
_DIGITS = "0123456789"
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

E_EXPECTED = "[EXPECTED] "
E_EXTERNAL = "[EXTERNAL] "
E_TRANSIENT = "[TRANSIENT] "

RECORD_KEYS = frozenset(
    [
        "source",
        "exchange",
        "symbol",
        "interval",
        "timezone",
        "open_time_ms",
        "close_time_ms",
        "open_price",
        "close_price",
        "outcome",
    ]
)


# ----------------------------------------------------------------------------
# Exact decimal arithmetic (no float, no tolerance)
# ----------------------------------------------------------------------------
def _parse_decimal(s):
    """Parse a positive decimal string into (integer_value, scale), normalized.

    Single pass over a bounded string. Raises ValueError for anything outside:
    digits+ ('.' digits+)? (no sign, exponent, whitespace, non-ASCII digit,
    empty parts), over-long input, or zero.
    """
    if type(s) is not str or len(s) == 0 or len(s) > MAX_DECIMAL_LEN:
        raise ValueError("decimal shape")
    if s.count(".") > 1:
        raise ValueError("decimal dots")
    if "." in s:
        int_part, frac_part = s.split(".")
        if int_part == "" or frac_part == "":
            raise ValueError("decimal empty part")
    else:
        int_part, frac_part = s, ""
    for ch in int_part + frac_part:
        if ch not in _DIGITS:
            raise ValueError("decimal char")
    if len(int_part) > MAX_INT_DIGITS or len(frac_part) > MAX_FRAC_DIGITS:
        raise ValueError("decimal precision")
    int_part = int_part.lstrip("0")
    frac_part = frac_part.rstrip("0")
    digits = int_part + frac_part
    value = int(digits) if digits != "" else 0
    if value == 0:
        raise ValueError("decimal zero")
    return value, len(frac_part)


def _canonical_decimal(value, scale):
    digits = str(value)
    if scale == 0:
        return digits
    if len(digits) <= scale:
        digits = "0" * (scale - len(digits) + 1) + digits
    return digits[:-scale] + "." + digits[-scale:]


def _compare_decimal(a, b):
    va, sa = a
    vb, sb = b
    s = sa if sa > sb else sb
    na = va * (10 ** (s - sa))
    nb = vb * (10 ** (s - sb))
    if na > nb:
        return 1
    if na < nb:
        return -1
    return 0


def _outcome_of(open_dec, close_dec):
    c = _compare_decimal(close_dec, open_dec)
    if c > 0:
        return "UP"
    if c < 0:
        return "DOWN"
    return "FLAT"


# ----------------------------------------------------------------------------
# Evidence acquisition. Runs ONLY inside the non-deterministic block.
# No storage writes, no clock reads, no caller-controlled text.
# ----------------------------------------------------------------------------
def _fetch_evidence(open_ms):
    url = (
        KLINES_URL
        + "?symbol="
        + SYMBOL
        + "&interval="
        + INTERVAL
        + "&timeZone=0&startTime="
        + str(open_ms)
        + "&endTime="
        + str(open_ms)
        + "&limit=1"
    )
    try:
        resp = gl.nondet.web.get(url)
    except Exception:
        raise gl.vm.UserError(E_TRANSIENT + "web request failed")

    if resp.status != 200:
        raise gl.vm.UserError(E_EXTERNAL + "http status")
    # Size guard FIRST: nothing is decoded or parsed before this check.
    if resp.body is None or len(resp.body) == 0 or len(resp.body) > MAX_BODY_BYTES:
        raise gl.vm.UserError(E_EXTERNAL + "body size")
    try:
        rows = json.loads(resp.body.decode("utf-8"))
    except (ValueError, RecursionError):
        raise gl.vm.UserError(E_EXTERNAL + "invalid json")

    if type(rows) is not list:
        raise gl.vm.UserError(E_EXTERNAL + "not a list")
    if len(rows) == 0:
        raise gl.vm.UserError(E_EXTERNAL + "candle not available")
    if len(rows) != 1:
        raise gl.vm.UserError(E_EXTERNAL + "unexpected row count")

    row = rows[0]
    if type(row) is not list or len(row) != 12:
        raise gl.vm.UserError(E_EXTERNAL + "bad row shape")
    if type(row[0]) is not int or row[0] != open_ms:
        raise gl.vm.UserError(E_EXTERNAL + "wrong open time")
    if type(row[6]) is not int or row[6] != open_ms + DAY_MS - 1:
        raise gl.vm.UserError(E_EXTERNAL + "wrong close time")

    try:
        open_dec = _parse_decimal(row[1])
        close_dec = _parse_decimal(row[4])
    except ValueError:
        raise gl.vm.UserError(E_EXTERNAL + "bad decimal")

    return {
        "source": SOURCE,
        "exchange": EXCHANGE,
        "symbol": SYMBOL,
        "interval": INTERVAL,
        "timezone": TIMEZONE,
        "open_time_ms": open_ms,
        "close_time_ms": open_ms + DAY_MS - 1,
        "open_price": _canonical_decimal(*open_dec),
        "close_price": _canonical_decimal(*close_dec),
        "outcome": _outcome_of(open_dec, close_dec),
    }


def _same_record(a, b):
    """Type-exact equality of two evidence records.

    Python's == treats 1 == 1.0 == True; canonical JSON does not, so a record
    only matches if every field has the same value AND the same type.
    """
    try:
        return type(a) is dict and json.dumps(a, sort_keys=True) == json.dumps(
            b, sort_keys=True
        )
    except (TypeError, ValueError):
        return False


def _check_accepted_record(record, open_ms):
    """Deterministic re-validation of the consensus-accepted record."""
    try:
        if type(record) is not dict or set(record.keys()) != RECORD_KEYS:
            raise ValueError("keys")
        if (
            record["source"] != SOURCE
            or record["exchange"] != EXCHANGE
            or record["symbol"] != SYMBOL
            or record["interval"] != INTERVAL
            or record["timezone"] != TIMEZONE
        ):
            raise ValueError("constants")
        for name, expected in (
            ("open_time_ms", open_ms),
            ("close_time_ms", open_ms + DAY_MS - 1),
        ):
            if type(record[name]) is not int or record[name] != expected:
                raise ValueError("timestamps")
        open_dec = _parse_decimal(record["open_price"])
        close_dec = _parse_decimal(record["close_price"])
        if (
            _canonical_decimal(*open_dec) != record["open_price"]
            or _canonical_decimal(*close_dec) != record["close_price"]
        ):
            raise ValueError("not canonical")
        outcome = _outcome_of(open_dec, close_dec)
        if record["outcome"] != outcome:
            raise ValueError("outcome")
    except ValueError:
        raise gl.vm.UserError(E_EXTERNAL + "accepted record invalid")
    return record["open_price"], record["close_price"], outcome


# ----------------------------------------------------------------------------
# Deterministic helpers
# ----------------------------------------------------------------------------
def _now_ms():
    """Transaction timestamp in integer milliseconds (no float involved)."""
    # GenVM pins the standard clock to the transaction datetime (see the
    # Transaction Context docs), so every validator sees the same value.
    dt = datetime.now(timezone.utc)
    return (dt - _EPOCH) // timedelta(milliseconds=1)


def _validate_market(market_open_time_ms):
    t = market_open_time_ms
    if type(t) is not int:
        raise gl.vm.UserError(E_EXPECTED + "market timestamp must be int")
    if t < MIN_MARKET_OPEN_MS or t > MAX_MARKET_OPEN_MS or t % DAY_MS != 0:
        raise gl.vm.UserError(E_EXPECTED + "invalid market timestamp")
    return t


def _addr_key(address):
    return address.as_bytes.hex()


def _pred_key(t, address):
    return str(t) + ":" + _addr_key(address)


@allow_storage
@dataclass
class Prediction:
    choice: u8
    submitted_at_ms: u64
    processed: bool


@allow_storage
@dataclass
class Candidate:
    """Provisional observation. NOT a settlement."""

    source: str
    exchange: str
    symbol: str
    interval: str
    timezone: str
    open_time_ms: u64
    close_time_ms: u64
    open_price: str
    close_price: str
    outcome: str
    observed_at_ms: u64


@allow_storage
@dataclass
class Settlement:
    source: str
    exchange: str
    symbol: str
    interval: str
    timezone: str
    open_time_ms: u64
    close_time_ms: u64
    open_price: str
    close_price: str
    outcome: str
    first_observed_at_ms: u64
    resolved_at_ms: u64


def _candidate_matches(cand, record):
    """Compare EVERY evidence field of the stored candidate with a new record."""
    return (
        cand.source == record["source"]
        and cand.exchange == record["exchange"]
        and cand.symbol == record["symbol"]
        and cand.interval == record["interval"]
        and cand.timezone == record["timezone"]
        and int(cand.open_time_ms) == record["open_time_ms"]
        and int(cand.close_time_ms) == record["close_time_ms"]
        and cand.open_price == record["open_price"]
        and cand.close_price == record["close_price"]
        and cand.outcome == record["outcome"]
    )


def _status(status, t, open_price, close_price, outcome, observed_at_ms=None):
    out = {
        "status": status,
        "market_open_time_ms": t,
        "open_price": open_price,
        "close_price": close_price,
        "outcome": outcome,
    }
    if observed_at_ms is not None:
        out["observed_at_ms"] = int(observed_at_ms)
        out["confirmable_at_ms"] = int(observed_at_ms) + CONFIRMATION_INTERVAL_MS
    return out


class BTCForecast(gl.Contract):
    predictions: TreeMap[str, Prediction]
    candidates: TreeMap[str, Candidate]
    settlements: TreeMap[str, Settlement]
    scores: TreeMap[str, u64]
    market_pred_count: TreeMap[str, u32]

    def __init__(self):
        pass

    # ------------------------------------------------------------------
    # Writes
    # ------------------------------------------------------------------
    @gl.public.write
    def submit_prediction(self, market_open_time_ms: int, prediction: str) -> None:
        t = _validate_market(market_open_time_ms)
        if type(prediction) is not str or prediction not in CHOICE_CODES:
            raise gl.vm.UserError(E_EXPECTED + "invalid prediction")

        now = _now_ms()
        if not now < t:
            raise gl.vm.UserError(E_EXPECTED + "market locked")
        if t > now + HORIZON_MS:
            raise gl.vm.UserError(E_EXPECTED + "market beyond horizon")

        market_key = str(t)
        if market_key in self.settlements:
            raise gl.vm.UserError(E_EXPECTED + "market already resolved")

        key = _pred_key(t, gl.message.sender_address)
        is_new = self.predictions.get(key) is None
        self.predictions[key] = Prediction(
            choice=CHOICE_CODES[prediction],
            submitted_at_ms=now,
            processed=False,
        )
        if is_new:
            self.market_pred_count[market_key] = (
                self.market_pred_count.get(market_key, 0) + 1
            )

    @gl.public.write
    def resolve_market(self, market_open_time_ms: int) -> dict:
        t = _validate_market(market_open_time_ms)
        now = _now_ms()
        if now < t + DAY_MS + RESOLUTION_GRACE_MS:
            raise gl.vm.UserError(E_EXPECTED + "resolution window not open")

        market_key = str(t)
        settled = self.settlements.get(market_key)
        if settled is not None:
            # Idempotent: never fetch, never change an accepted result.
            return _status(
                "RESOLVED",
                t,
                settled.open_price,
                settled.close_price,
                settled.outcome,
                settled.first_observed_at_ms,
            )

        if self.market_pred_count.get(market_key, 0) < 1:
            raise gl.vm.UserError(E_EXPECTED + "no predictions for market")

        cand = self.candidates.get(market_key)
        if cand is not None and now < int(cand.observed_at_ms) + CONFIRMATION_INTERVAL_MS:
            raise gl.vm.UserError(E_EXPECTED + "confirmation interval not elapsed")

        def fetch() -> dict:
            return _fetch_evidence(t)

        def validate(leader_res) -> bool:
            # Runs in the SDK's validator sandbox (gl.vm.run_nondet). No storage
            # access, no clock reads. The validator ALWAYS re-fetches first: if
            # that fails with a UserError and the leader also ended in a
            # UserError, the SDK compares both messages (equal => agreement, the
            # call fails and nothing is stored). A leader/validator type mismatch
            # (error vs success) is a disagreement.
            mine = _fetch_evidence(t)
            if not isinstance(leader_res, gl.vm.Return):
                return False
            # Whole-record, type-exact equality binds EVERY decision field.
            return _same_record(leader_res.calldata, mine)

        record = gl.vm.run_nondet(fetch, validate)

        open_price, close_price, outcome = _check_accepted_record(record, t)

        # Re-read state AFTER consensus (a concurrent transaction may have
        # changed it) and only then write.
        settled = self.settlements.get(market_key)
        if settled is not None:
            return _status(
                "RESOLVED",
                t,
                settled.open_price,
                settled.close_price,
                settled.outcome,
                settled.first_observed_at_ms,
            )
        cand = self.candidates.get(market_key)
        if cand is not None and now < int(cand.observed_at_ms) + CONFIRMATION_INTERVAL_MS:
            raise gl.vm.UserError(E_EXPECTED + "confirmation interval not elapsed")

        if cand is not None and _candidate_matches(cand, record):
            self.settlements[market_key] = Settlement(
                source=SOURCE,
                exchange=EXCHANGE,
                symbol=SYMBOL,
                interval=INTERVAL,
                timezone=TIMEZONE,
                open_time_ms=t,
                close_time_ms=t + DAY_MS - 1,
                open_price=open_price,
                close_price=close_price,
                outcome=outcome,
                first_observed_at_ms=int(cand.observed_at_ms),
                resolved_at_ms=now,
            )
            return _status(
                "RESOLVED", t, open_price, close_price, outcome, cand.observed_at_ms
            )

        replaced = cand is not None
        self.candidates[market_key] = Candidate(
            source=SOURCE,
            exchange=EXCHANGE,
            symbol=SYMBOL,
            interval=INTERVAL,
            timezone=TIMEZONE,
            open_time_ms=t,
            close_time_ms=t + DAY_MS - 1,
            open_price=open_price,
            close_price=close_price,
            outcome=outcome,
            observed_at_ms=now,
        )
        return _status(
            "CANDIDATE_REPLACED" if replaced else "CANDIDATE_RECORDED",
            t,
            open_price,
            close_price,
            outcome,
            now,
        )

    @gl.public.write
    def claim_points(self, market_open_time_ms: int) -> None:
        t = _validate_market(market_open_time_ms)
        settlement = self.settlements.get(str(t))
        if settlement is None:
            raise gl.vm.UserError(E_EXPECTED + "market not resolved")

        sender = gl.message.sender_address
        key = _pred_key(t, sender)
        pred = self.predictions.get(key)
        if pred is None:
            raise gl.vm.UserError(E_EXPECTED + "no prediction")
        if pred.processed:
            raise gl.vm.UserError(E_EXPECTED + "already claimed")

        points = 1 if CHOICE_NAMES[int(pred.choice)] == settlement.outcome else 0

        self.predictions[key] = Prediction(
            choice=pred.choice,
            submitted_at_ms=pred.submitted_at_ms,
            processed=True,
        )
        if points > 0:
            skey = _addr_key(sender)
            self.scores[skey] = self.scores.get(skey, 0) + points

    # ------------------------------------------------------------------
    # Views
    # ------------------------------------------------------------------
    @gl.public.view
    def get_prediction(self, market_open_time_ms: int, user_address: Address) -> dict:
        t = _validate_market(market_open_time_ms)
        pred = self.predictions.get(_pred_key(t, user_address))
        if pred is None:
            return {"exists": False}
        return {
            "exists": True,
            "prediction": CHOICE_NAMES[int(pred.choice)],
            "submitted_at_ms": int(pred.submitted_at_ms),
            "processed": bool(pred.processed),
        }

    @gl.public.view
    def get_market_candidate(self, market_open_time_ms: int) -> dict:
        t = _validate_market(market_open_time_ms)
        c = self.candidates.get(str(t))
        if c is None:
            return {"exists": False}
        return {
            "exists": True,
            "source": c.source,
            "exchange": c.exchange,
            "symbol": c.symbol,
            "interval": c.interval,
            "timezone": c.timezone,
            "open_time_ms": int(c.open_time_ms),
            "close_time_ms": int(c.close_time_ms),
            "open_price": c.open_price,
            "close_price": c.close_price,
            "outcome": c.outcome,
            "observed_at_ms": int(c.observed_at_ms),
            "confirmable_at_ms": int(c.observed_at_ms) + CONFIRMATION_INTERVAL_MS,
        }

    @gl.public.view
    def get_market_result(self, market_open_time_ms: int) -> dict:
        t = _validate_market(market_open_time_ms)
        s = self.settlements.get(str(t))
        if s is None:
            return {"resolved": False}
        return {
            "resolved": True,
            "source": s.source,
            "exchange": s.exchange,
            "symbol": s.symbol,
            "interval": s.interval,
            "timezone": s.timezone,
            "open_time_ms": int(s.open_time_ms),
            "close_time_ms": int(s.close_time_ms),
            "open_price": s.open_price,
            "close_price": s.close_price,
            "outcome": s.outcome,
            "first_observed_at_ms": int(s.first_observed_at_ms),
            "resolved_at_ms": int(s.resolved_at_ms),
        }

    @gl.public.view
    def get_user_points(self, user_address: Address) -> int:
        return int(self.scores.get(_addr_key(user_address), 0))
