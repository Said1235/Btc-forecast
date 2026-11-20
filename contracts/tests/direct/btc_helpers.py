"""Shared helpers for the BTCForecast Direct Mode tests.

Direct Mode runs the leader path only. Validator logic is exercised through
``vm.run_validator()`` (see ``votes``), which models the SDK's validator-sandbox
wrapper. None of this proves real network consensus or GenVM access to Binance.
"""

import json
import warnings
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from unittest import mock as umock

import pytest

DAY = 86_400_000
GRACE = 300_000
CONF = 300_000
T = int(datetime(2026, 11, 10, tzinfo=timezone.utc).timestamp()) * 1000
OBS1 = T + DAY + GRACE  # first moment a candidate may be recorded
CONTRACT = "contracts/btc_forecast.py"
URL_RE = r"^https://data-api\.binance\.vision/api/v3/klines\?symbol=BTCUSDT&interval=1d&timeZone=0&startTime=(\d+)&endTime=\1&limit=1$"

# error message produced by the contract for each injected failure kind
FAILURES = {
    "http_429": "[EXTERNAL] http status",
    "http_500": "[EXTERNAL] http status",
    "http_502": "[EXTERNAL] http status",
    "http_503": "[EXTERNAL] http status",
    "http_504": "[EXTERNAL] http status",
    "timeout": "[TRANSIENT] web request failed",
    "connection": "[TRANSIENT] web request failed",
    "null_body": "[EXTERNAL] body size",
    "empty_body": "[EXTERNAL] body size",
    "invalid_json": "[EXTERNAL] invalid json",
    "invalid_utf8": "[EXTERNAL] invalid json",
}


def A(raw):
    """Direct-mode fixtures are raw bytes; real calls decode to Address."""
    from genlayer.py.types import Address

    return raw if hasattr(raw, "as_bytes") else Address(raw)


def iso(ms):
    dt = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=ms)
    return dt.isoformat().replace("+00:00", "Z")


def row(open_ms, o, c, h="999999999999999999", l="0.000000000001", close_ms=None):
    return [
        open_ms,
        o,
        h,
        l,
        c,
        "1000.0",
        close_ms if close_ms is not None else open_ms + DAY - 1,
        "1.0",
        1,
        "1.0",
        "1.0",
        "0",
    ]


def rows_for(o="100.00", c="120.00", t=T):
    return [row(t, o, c)]


def votes(vm, **kw):
    """Validator vote, modelling the SDK's gl.vm.run_nondet wrapper.

    Direct Mode calls validate() directly (no sandbox), so the wrapper rules are
    reproduced here (see SDK vm.run_nondet):
      * validator returns bool, leader result is a Return        -> that bool
      * validator returns bool, leader result is an error        -> type mismatch -> False
      * validator raises UserError, leader result is a UserError -> messages equal?
      * validator raises UserError, leader result is a Return    -> type mismatch -> False
      * any other validator exception                            -> not an agreement
    """
    import genlayer.gl.vm as g

    leader_error = kw.get("leader_error")
    try:
        answer = vm.run_validator(**kw)
    except g.UserError as e:
        return leader_error is not None and str(leader_error) == e.message
    except Exception:
        return False
    if not isinstance(answer, bool):
        raise TypeError("validator function returned non-bool")
    if leader_error is not None:
        return False
    return answer


def leader_record(**over):
    rec = {
        "source": "binance-spot-data-api-vision",
        "exchange": "BINANCE_SPOT",
        "symbol": "BTCUSDT",
        "interval": "1d",
        "timezone": "UTC",
        "open_time_ms": T,
        "close_time_ms": T + DAY - 1,
        "open_price": "100",
        "close_price": "120",
        "outcome": "UP",
    }
    rec.update(over)
    return rec


class Ctx:
    def __init__(self, contract, vm, alice, bob, charlie):
        self.c, self.vm = contract, vm
        self.alice, self.bob, self.charlie = alice, bob, charlie

    # --- time / identity -------------------------------------------------
    def at(self, ms):
        self.vm.warp(iso(ms))

    def as_(self, who):
        self.vm.sender = who

    # --- mocks (strict: unused mocks fail the test at teardown) ----------
    def mock(self, rows=None, status=200, body=None):
        if body is None:
            body = json.dumps(rows)
        self.vm.mock_web(URL_RE, {"status": status, "body": body})

    def mock_raw(self, status=200, body=None):
        """Full-format mock allowing bytes / None bodies."""
        self.vm.mock_web(
            URL_RE,
            {"method": "GET", "response": {"status": status, "headers": {}, "body": body}},
        )

    def remock(self, *a, **k):
        self.vm.clear_mocks()
        self.mock(*a, **k)

    def mock_failure(self, kind):
        if kind.startswith("http_"):
            self.mock(status=int(kind[5:]), body="error")
        elif kind == "null_body":
            self.mock_raw(body=None)
        elif kind == "empty_body":
            self.mock_raw(body=b"")
        elif kind == "invalid_json":
            self.mock(body="<html>not json</html>")
        elif kind == "invalid_utf8":
            self.mock_raw(body=b"\xff\xfe\xfa[")
        else:
            raise AssertionError(kind)

    @contextmanager
    def web_spy(self):
        """Count real web requests the contract attempts (stale-mock-proof)."""
        import genlayer.gl.nondet.web as w

        with umock.patch.object(w, "get", wraps=w.get) as spy:
            yield spy

    @contextmanager
    def web_get_raises(self, exc):
        import genlayer.gl.nondet.web as w

        with umock.patch.object(w, "get", side_effect=exc):
            yield

    @contextmanager
    def failure(self, kind):
        """Make every web request fail in the given way."""
        if kind == "timeout":
            with self.web_get_raises(TimeoutError("timed out")):
                yield
        elif kind == "connection":
            with self.web_get_raises(ConnectionError("connection refused")):
                yield
        else:
            self.vm.clear_mocks()
            self.mock_failure(kind)
            yield

    # --- actions -----------------------------------------------------------
    def submit(self, who, pred, now=T - 3_600_000, t=T):
        self.as_(who)
        self.at(now)
        self.c.submit_prediction(t, pred)

    def resolve(self, now, who=None, t=T, rows=None, **mockkw):
        """Resolve at `now`; mocks `rows` first when given."""
        self.as_(who or self.charlie)
        self.at(now)
        if rows is not None or mockkw:
            self.remock(rows, **mockkw)
        return self.c.resolve_market(t)

    def state(self, t=T):
        """Observable persistent state of a market (for no-partial-write checks)."""
        a, b, c = self.alice, self.bob, self.charlie
        return {
            "result": self.c.get_market_result(t),
            "candidate": self.c.get_market_candidate(t),
            "preds": [self.c.get_prediction(t, A(x)) for x in (a, b, c)],
            "points": [self.c.get_user_points(A(x)) for x in (a, b, c)],
        }

    def settle(self, o="100.00", c="120.00", pred="UP"):
        """Alice predicts, then candidate + confirmation with identical evidence."""
        self.submit(self.alice, pred)
        r1 = self.resolve(OBS1, rows=rows_for(o, c))
        r2 = self.resolve(OBS1 + CONF, rows=rows_for(o, c))
        return r1, r2


@pytest.fixture
def env(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract = direct_deploy(CONTRACT)
    direct_vm.sender = direct_alice
    direct_vm.strict_mocks = True
    ctx = Ctx(contract, direct_vm, direct_alice, direct_bob, direct_charlie)
    yield ctx
    # Strict mocks: a mock that was never matched means the test was not
    # exercising what it thought it was. Promote that warning to a failure.
    with warnings.catch_warnings():
        warnings.filterwarnings("error", message="Web mock never matched")
        direct_vm._warn_unused_mocks()
