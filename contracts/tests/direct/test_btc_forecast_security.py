"""Adversarial / lifecycle / consensus tests for contracts/btc_forecast.py.

Direct Mode only (mocked Binance, leader path + explicit validator votes).
Real multi-validator consensus (Studio) is NOT exercised here.
"""

import ast
import json
import warnings

import pytest

from tests.direct.btc_helpers import (  # noqa: F401  (env is a fixture)
    A,
    CONF,
    CONTRACT,
    DAY,
    FAILURES,
    GRACE,
    OBS1,
    T,
    env,
    iso,
    leader_record,
    row,
    rows_for,
    votes,
)


def bare(env):
    """Alice has a prediction; nothing resolved yet."""
    env.submit(env.alice, "UP")
    return env.state()


# ---------------------------------------------------------------------------
# A. Hostile / oversized payloads (application-level size guard)
# ---------------------------------------------------------------------------
def pad_to(rows, size):
    base = json.dumps(rows)
    return base + " " * (size - len(base))


HOSTILE = {
    "html_300kb": "<html><body>" + "<div class='x'>junk</div>" * 12_000 + "</body></html>",
    "json_300kb_padding": json.dumps(rows_for()) + " " * 300_000,
    "oversized_valid_json_8193": pad_to(rows_for(), 8193),
    "row_with_huge_field": json.dumps([row(T, "100", "120") [:5] + ["v" * 9000] + row(T, "1", "1")[6:]]),
}


@pytest.mark.parametrize("name", sorted(HOSTILE))
def test_A_oversized_bodies_rejected_by_size_guard_before_parsing(env, name):
    before = bare(env)
    with env.vm.expect_revert("[EXTERNAL] body size"):
        env.resolve(OBS1, rows=None, body=HOSTILE[name])
    assert env.state() == before


def test_A_size_guard_runs_before_decode_300kb_invalid_utf8(env):
    """If the guard ran after decoding, this would report 'invalid json'."""
    before = bare(env)
    env.as_(env.charlie)
    env.at(OBS1)
    env.mock_raw(body=b"\xff" * 300_000)
    with env.vm.expect_revert("[EXTERNAL] body size"):
        env.c.resolve_market(T)
    assert env.state() == before


def test_A_size_boundary_8192_accepted_8193_rejected(env):
    bare(env)
    r = env.resolve(OBS1, rows=None, body=pad_to(rows_for(), 8192))
    assert r["status"] == "CANDIDATE_RECORDED"
    env2_before = env.state()
    with env.vm.expect_revert("[EXTERNAL] body size"):
        env.resolve(OBS1 + CONF, rows=None, body=pad_to(rows_for(), 8193))
    assert env.state() == env2_before


NON_JSON = {
    "small_html_error_page": "<html><body><h1>502 Bad Gateway</h1></body></html>",
    "html_with_json_looking_excerpt": "<html><pre>" + json.dumps(rows_for()) + "</pre></html>",
    "valid_json_surrounded_by_junk": "junk " + json.dumps(rows_for()) + " junk",
    "valid_json_then_html_comment": json.dumps(rows_for()) + "\n<!-- trailing -->",
    "two_json_documents": json.dumps(rows_for()) + json.dumps(rows_for()),
    "bom_prefixed": "\ufeff" + json.dumps(rows_for()),
    "single_quotes": json.dumps(rows_for()).replace('"', "'"),
    "truncated": json.dumps(rows_for())[:-5],
}


@pytest.mark.parametrize("name", sorted(NON_JSON))
def test_A_only_the_exact_structured_response_is_accepted(env, name):
    before = bare(env)
    with env.vm.expect_revert("[EXTERNAL] invalid json"):
        env.resolve(OBS1, rows=None, body=NON_JSON[name])
    assert env.state() == before


@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity"])
def test_A_json_non_finite_literals_become_floats_and_are_rejected(env, literal):
    before = bare(env)
    body = json.dumps(rows_for()).replace('"100.00"', literal, 1)
    with env.vm.expect_revert("[EXTERNAL] bad decimal"):
        env.resolve(OBS1, rows=None, body=body)
    assert env.state() == before


@pytest.mark.parametrize("depth", [100, 3000, 4090])
def test_A_deeply_nested_json_is_classified_not_crashed(env, depth):
    before = bare(env)
    with env.vm.expect_revert("[EXTERNAL]"):
        env.resolve(OBS1, rows=None, body="[" * depth + "]" * depth)
    assert env.state() == before


def test_A_unmatched_request_fails_closed(env):
    """No mock => the contract must not invent a result (also proves that the
    'no fetch on resolved market' tests below are meaningful)."""
    before = bare(env)
    env.as_(env.charlie)
    env.at(OBS1)
    with pytest.raises(Exception):
        env.c.resolve_market(T)
    assert env.state() == before


# ---------------------------------------------------------------------------
# B. Injection / static audit of the resolution path
# ---------------------------------------------------------------------------
SRC = open(CONTRACT).read()
TREE = ast.parse(SRC)


def names_in(node):
    out = set()
    for n in ast.walk(node):
        if isinstance(n, ast.Name):
            out.add(n.id)
        if isinstance(n, ast.Attribute):
            out.add(n.attr)
    return out


def func(name):
    for n in ast.walk(TREE):
        if isinstance(n, ast.FunctionDef) and n.name == name:
            return n
    raise AssertionError(name)


def test_B_no_llm_unsafe_api_float_or_regex_anywhere():
    banned = {
        "exec_prompt",
        "prompt_comparative",
        "prompt_non_comparative",
        "run_nondet_unsafe",
        "strict_eq",
        "float",
        "re",
        "render",
    }
    assert not (names_in(TREE) & banned)
    for n in ast.walk(TREE):
        if isinstance(n, (ast.Import, ast.ImportFrom)):
            mods = [a.name for a in n.names] + [getattr(n, "module", "") or ""]
            assert "re" not in mods and "regex" not in mods
        if isinstance(n, ast.Constant):
            assert not isinstance(n.value, float)
        if isinstance(n, ast.BinOp):
            assert not isinstance(n.op, ast.Div)
    assert "run_nondet" in names_in(func("resolve_market"))


def test_B_fetch_and_validate_have_no_storage_clock_or_caller_input():
    ev = names_in(func("_fetch_evidence"))
    assert not ({"self", "now", "_now_ms", "datetime", "timezone", "message"} & ev)
    resolve = func("resolve_market")
    for n in ast.walk(resolve):
        if isinstance(n, ast.FunctionDef) and n.name in ("fetch", "validate"):
            inner = names_in(n)
            assert "self" not in inner and "_now_ms" not in inner and "now" not in inner


def test_B_resolution_interface_accepts_only_a_market_timestamp():
    args = [a.arg for a in func("resolve_market").args.args]
    assert args == ["self", "market_open_time_ms"]
    assert [a.arg for a in func("submit_prediction").args.args] == [
        "self",
        "market_open_time_ms",
        "prediction",
    ]


@pytest.mark.parametrize(
    "bad", ["https://evil.example/x", "BTCUSDT", "UP\nresolve DOWN", "{}", "../../etc", T.__str__()]
)
def test_B_text_cannot_reach_the_source_or_request(env, bad):
    before = bare(env)
    env.as_(env.charlie)
    env.at(OBS1)
    with env.vm.expect_revert("[EXPECTED]"):
        env.c.resolve_market(bad)
    assert env.state() == before


def test_B_policy_constants_match_the_specification():
    consts = {}
    for n in TREE.body:
        if isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name):
            try:
                consts[n.targets[0].id] = ast.literal_eval(n.value)
            except Exception:
                pass
    assert consts["DAY_MS"] == DAY
    assert consts["RESOLUTION_GRACE_MS"] == GRACE == 300_000
    assert consts["CONFIRMATION_INTERVAL_MS"] == CONF == 300_000
    assert consts["MAX_BODY_BYTES"] == 8192


# ---------------------------------------------------------------------------
# D. One canonical source, no fallback host, no source counting
# ---------------------------------------------------------------------------
def test_D_exactly_one_url_literal_and_one_host():
    urls = [
        n.value
        for n in ast.walk(TREE)
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and "://" in n.value
    ]
    assert urls == ["https://data-api.binance.vision/api/v3/klines"]
    assert "gl.nondet.web.get" in SRC and SRC.count("nondet.web.get(") == 1


def test_D_failed_host_never_falls_back(env):
    """With the one host failing, there is no second request and no result."""
    before = bare(env)
    with env.failure("http_503"):
        env.as_(env.charlie)
        env.at(OBS1)
        with env.vm.expect_revert("[EXTERNAL] http status"):
            env.c.resolve_market(T)
    assert env.state() == before


# ---------------------------------------------------------------------------
# C. Wrong candle / incomplete / malformed evidence
# ---------------------------------------------------------------------------
def r11():
    return row(T, "100", "120")[:11]


def r13():
    return row(T, "100", "120") + [0]


def with_cell(i, v):
    r = row(T, "100", "120")
    r[i] = v
    return [r]


CASES = {
    "empty_list": ([], "[EXTERNAL] candle not available"),
    "wrong_open_previous_day": ([row(T - DAY, "100", "120")], "[EXTERNAL] wrong open time"),
    "wrong_open_next_day": ([row(T + DAY, "100", "120")], "[EXTERNAL] wrong open time"),
    "close_time_plus_1": ([row(T, "100", "120", close_ms=T + DAY)], "[EXTERNAL] wrong close time"),
    "close_time_minus_1": ([row(T, "100", "120", close_ms=T + DAY - 2)], "[EXTERNAL] wrong close time"),
    "two_rows_target_first": ([row(T, "100", "120"), row(T + DAY, "1", "2")], "[EXTERNAL] unexpected row count"),
    "two_rows_wrong_candle_first": ([row(T - DAY, "1", "2"), row(T, "100", "120")], "[EXTERNAL] unexpected row count"),
    "three_rows": ([row(T, "1", "2")] * 3, "[EXTERNAL] unexpected row count"),
    "row_11_fields": ([r11()], "[EXTERNAL] bad row shape"),
    "row_13_fields": ([r13()], "[EXTERNAL] bad row shape"),
    "row_empty": ([[]], "[EXTERNAL] bad row shape"),
    "row_none": ([None], "[EXTERNAL] bad row shape"),
    "row_string": (["abc"], "[EXTERNAL] bad row shape"),
    "row_dict": ([{}], "[EXTERNAL] bad row shape"),
    "open_time_bool": (with_cell(0, True), "[EXTERNAL] wrong open time"),
    "open_time_float": (with_cell(0, float(T)), "[EXTERNAL] wrong open time"),
    "open_time_string": (with_cell(0, str(T)), "[EXTERNAL] wrong open time"),
    "open_time_none": (with_cell(0, None), "[EXTERNAL] wrong open time"),
    "close_time_bool": (with_cell(6, True), "[EXTERNAL] wrong close time"),
    "close_time_float": (with_cell(6, float(T + DAY - 1)), "[EXTERNAL] wrong close time"),
    "close_time_string": (with_cell(6, str(T + DAY - 1)), "[EXTERNAL] wrong close time"),
    "close_time_none": (with_cell(6, None), "[EXTERNAL] wrong close time"),
    "open_price_int": (with_cell(1, 100), "[EXTERNAL] bad decimal"),
    "open_price_none": (with_cell(1, None), "[EXTERNAL] bad decimal"),
    "close_price_none": (with_cell(4, None), "[EXTERNAL] bad decimal"),
    "close_price_list": (with_cell(4, ["120"]), "[EXTERNAL] bad decimal"),
    "close_price_bool": (with_cell(4, True), "[EXTERNAL] bad decimal"),
    "close_price_float": (with_cell(4, 120.5), "[EXTERNAL] bad decimal"),
}


@pytest.mark.parametrize("name", sorted(CASES))
def test_C_only_the_exact_target_kline_is_accepted(env, name):
    before = bare(env)
    rows, msg = CASES[name]
    with env.vm.expect_revert(msg):
        env.resolve(OBS1, rows=rows)
    assert env.state() == before


ROOTS = {
    "root_dict": '{"data": []}',
    "root_dict_with_correct_row_inside": json.dumps({"klines": rows_for()}),
    "root_string": '"x"',
    "root_number": "1",
    "root_null": "null",
    "root_true": "true",
}


@pytest.mark.parametrize("name", sorted(ROOTS))
def test_C_wrong_root_structure_rejected(env, name):
    before = bare(env)
    with env.vm.expect_revert("[EXTERNAL] not a list"):
        env.resolve(OBS1, rows=None, body=ROOTS[name])
    assert env.state() == before


def test_C_exact_target_row_with_different_unused_columns_is_accepted(env):
    bare(env)
    r = row(T, "100", "120", h="5", l="1")
    r[5] = "weird"  # volume is not decision-bearing
    out = env.resolve(OBS1, rows=[r])
    assert out["status"] == "CANDIDATE_RECORDED"


# ---------------------------------------------------------------------------
# E. HTTP errors / timeouts / invalid bodies, in every phase and role
# ---------------------------------------------------------------------------
KINDS = sorted(FAILURES)


def attempt(env, now, kind):
    env.as_(env.charlie)
    env.at(now)
    with env.failure(kind):
        with env.vm.expect_revert(FAILURES[kind]):
            env.c.resolve_market(T)


@pytest.mark.parametrize("kind", KINDS)
def test_E_failure_in_initial_observation_creates_nothing_and_retry_works(env, kind):
    before = bare(env)
    attempt(env, OBS1, kind)
    assert env.state() == before  # no candidate, no settlement, no FLAT, no flag
    out = env.resolve(OBS1 + 1, rows=rows_for("100", "120"))  # retry later
    assert out["status"] == "CANDIDATE_RECORDED"


@pytest.mark.parametrize("kind", KINDS)
def test_E_failure_in_confirmation_keeps_candidate_intact_and_retry_works(env, kind):
    bare(env)
    env.resolve(OBS1, rows=rows_for("100", "120"))
    before = env.state()
    attempt(env, OBS1 + CONF, kind)
    assert env.state() == before  # same candidate, not replaced, not settled
    assert env.c.get_market_candidate(T)["observed_at_ms"] == OBS1
    out = env.resolve(OBS1 + CONF + 1, rows=rows_for("100", "120"))
    assert out["status"] == "RESOLVED"


@pytest.fixture
def after_leader(env):
    bare(env)
    env.resolve(OBS1, rows=rows_for("100", "120"))  # leader ran, validator captured
    return env


@pytest.mark.parametrize("kind", KINDS)
def test_E_leader_ok_validator_fails_is_disagreement(after_leader, kind):
    with after_leader.failure(kind):
        assert votes(after_leader.vm, leader_result=leader_record()) is False


@pytest.mark.parametrize("kind", KINDS)
def test_E_both_fail_identically_agree_but_nothing_is_stored(after_leader, kind):
    """Matching failures are NOT evidence: they agree that the call fails."""
    before = after_leader.state()
    with after_leader.failure(kind):
        assert votes(after_leader.vm, leader_error=Exception(FAILURES[kind])) is True
        assert votes(after_leader.vm, leader_error=Exception("[EXTERNAL] something else")) is False
    assert after_leader.state() == before


@pytest.mark.parametrize("kind", KINDS)
def test_E_leader_fails_validator_ok_is_disagreement(after_leader, kind):
    assert votes(after_leader.vm, leader_error=Exception(FAILURES[kind])) is False


# ---------------------------------------------------------------------------
# F. Premature / third-party resolution and exact temporal boundaries
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "now",
    [T - DAY, T - 1, T, T + 1, T + DAY // 2, T + DAY - 1, T + DAY, T + DAY + 1, T + DAY + GRACE - 1],
)
def test_F_no_resolution_before_candle_close_plus_grace(env, now):
    before = bare(env)
    env.as_(env.charlie)
    env.at(now)  # no mock: a fetch attempt would be visible
    with env.vm.expect_revert("resolution window not open"):
        env.c.resolve_market(T)
    assert env.state() == before


def test_F_exact_lifecycle_by_an_arbitrary_third_party(env):
    bare(env)
    env.as_(env.charlie)  # never predicted, no privileges
    out = env.resolve(OBS1, who=env.charlie, rows=rows_for("100", "120"))
    assert out["status"] == "CANDIDATE_RECORDED"
    assert out["observed_at_ms"] == OBS1 and out["confirmable_at_ms"] == OBS1 + CONF
    assert env.c.get_market_result(T) == {"resolved": False}
    # an immediate second call, and one 1 ms early, cannot finalize
    for now in (OBS1, OBS1 + 1, OBS1 + CONF - 1):
        env.as_(env.charlie)
        env.at(now)
        with env.vm.expect_revert("confirmation interval not elapsed"):
            env.c.resolve_market(T)
        assert env.c.get_market_result(T) == {"resolved": False}
    out = env.resolve(OBS1 + CONF, who=env.charlie, rows=rows_for("100", "120"))
    assert out["status"] == "RESOLVED"
    assert env.c.get_market_result(T)["resolved"] is True


def test_F_candidate_is_not_a_settlement(env):
    bare(env)
    env.resolve(OBS1, rows=rows_for("100", "120"))
    assert env.c.get_market_result(T) == {"resolved": False}
    assert env.c.get_market_candidate(T)["exists"] is True
    env.as_(env.alice)
    with env.vm.expect_revert("market not resolved"):
        env.c.claim_points(T)


def test_F_resolution_needs_at_least_one_prediction(env):
    env.as_(env.charlie)
    env.at(OBS1)
    with env.vm.expect_revert("no predictions for market"):
        env.c.resolve_market(T)  # no mock: nothing may be fetched
    assert env.c.get_market_candidate(T) == {"exists": False}


# ---------------------------------------------------------------------------
# G. Candidate change handling
# ---------------------------------------------------------------------------
def test_G_identical_second_observation_finalizes(env):
    bare(env)
    a = env.resolve(OBS1, rows=rows_for("100", "120"))
    b = env.resolve(OBS1 + CONF, rows=rows_for("100", "120"))
    assert (a["status"], b["status"]) == ("CANDIDATE_RECORDED", "RESOLVED")
    r = env.c.get_market_result(T)
    assert (r["outcome"], r["open_price"], r["close_price"]) == ("UP", "100", "120")
    assert r["first_observed_at_ms"] == OBS1 and r["resolved_at_ms"] == OBS1 + CONF


@pytest.mark.parametrize(
    "second,outcome",
    [
        (("101", "120"), "UP"),  # different open
        (("100", "121"), "UP"),  # different close
        (("100", "90"), "DOWN"),  # different outcome
        (("100", "100"), "FLAT"),
        (("100.000000000001", "120"), "UP"),  # one unit of the last digit
    ],
)
def test_G_changed_evidence_never_finalizes_and_restarts_the_interval(env, second, outcome):
    bare(env)
    env.resolve(OBS1, rows=rows_for("100", "120"))
    out = env.resolve(OBS1 + CONF, rows=rows_for(*second))
    assert out["status"] == "CANDIDATE_REPLACED"
    assert env.c.get_market_result(T) == {"resolved": False}
    cand = env.c.get_market_candidate(T)
    assert cand["outcome"] == outcome and cand["observed_at_ms"] == OBS1 + CONF
    # interval restarted: an immediate or 1 ms early call cannot finalize
    for now in (OBS1 + CONF, OBS1 + 2 * CONF - 1):
        env.as_(env.charlie)
        env.at(now)
        with env.vm.expect_revert("confirmation interval not elapsed"):
            env.c.resolve_market(T)
    # a later STABLE observation finalizes using the replaced evidence
    out = env.resolve(OBS1 + 2 * CONF, rows=rows_for(*second))
    assert out["status"] == "RESOLVED"
    r = env.c.get_market_result(T)
    assert r["outcome"] == outcome and r["first_observed_at_ms"] == OBS1 + CONF


def test_G_candidate_can_be_replaced_repeatedly(env):
    bare(env)
    env.resolve(OBS1, rows=rows_for("100", "120"))
    env.resolve(OBS1 + CONF, rows=rows_for("100", "121"))
    env.resolve(OBS1 + 2 * CONF, rows=rows_for("100", "122"))
    assert env.c.get_market_result(T) == {"resolved": False}
    out = env.resolve(OBS1 + 3 * CONF, rows=rows_for("100", "122"))
    assert out["status"] == "RESOLVED"
    assert env.c.get_market_result(T)["close_price"] == "122"


def test_G_equivalent_representations_count_as_identical_evidence(env):
    bare(env)
    env.resolve(OBS1, rows=rows_for("100.0", "120.00000000"))
    out = env.resolve(OBS1 + CONF, rows=rows_for("100.000", "120"))
    assert out["status"] == "RESOLVED"


# ---------------------------------------------------------------------------
# J. Idempotency, replay and state consistency
# ---------------------------------------------------------------------------
def test_J_resolved_market_returns_existing_result_without_fetching(env):
    env.settle("100", "120", "UP")
    first = env.c.get_market_result(T)
    for now in (OBS1 + CONF + 1, OBS1 + 10 * DAY):
        env.as_(env.bob)
        env.at(now)  # NO mock: any fetch would fail (see test_A_unmatched_request_fails_closed)
        out = env.c.resolve_market(T)
        assert out["status"] == "RESOLVED" and out["outcome"] == "UP"
    assert env.c.get_market_result(T) == first


def test_J_conflicting_data_after_settlement_cannot_change_the_result(env):
    env.settle("100", "120", "UP")
    first = env.c.get_market_result(T)
    env.as_(env.bob)
    env.at(OBS1 + 5 * DAY)
    env.vm.strict_mocks = False  # this mock is intentionally never used
    env.vm.clear_mocks()
    env.mock(rows_for("100", "50"))  # Binance "corrects" history
    with env.web_spy() as spy:
        out = env.c.resolve_market(T)
    assert spy.call_count == 0  # never fetched
    assert out["outcome"] == "UP" and env.c.get_market_result(T) == first


def test_J_sequential_attempts_by_different_callers(env):
    bare(env)
    env.resolve(OBS1, who=env.alice, rows=rows_for("100", "120"))
    env.as_(env.bob)
    env.at(OBS1)
    with env.vm.expect_revert("confirmation interval not elapsed"):
        env.c.resolve_market(T)  # second caller, same instant
    out = env.resolve(OBS1 + CONF, who=env.bob, rows=rows_for("100", "120"))
    assert out["status"] == "RESOLVED"
    again = env.resolve(OBS1 + CONF, who=env.alice)  # third caller: no fetch, no mock
    assert again["status"] == "RESOLVED"


def test_J_failed_transactions_do_not_partially_mutate(env):
    bare(env)
    env.resolve(OBS1, rows=rows_for("100", "120"))
    before = env.state()
    # early confirmation, failing fetch, wrong candle, bad market, bad prediction
    env.as_(env.bob)
    env.at(OBS1 + 1)
    with env.vm.expect_revert("confirmation interval not elapsed"):
        env.c.resolve_market(T)
    attempt(env, OBS1 + CONF, "http_503")
    with env.vm.expect_revert("[EXTERNAL] wrong open time"):
        env.resolve(OBS1 + CONF, rows=[row(T - DAY, "1", "2")])
    env.as_(env.bob)
    env.at(T - 100)  # market already locked for new predictions? (T-100 < T: still open)
    with env.vm.expect_revert("[EXPECTED]"):
        env.c.submit_prediction(T, "SIDEWAYS")
    assert env.state() == before


def test_J_resolving_markets_is_independent(env):
    env.submit(env.alice, "UP", t=T)
    env.submit(env.alice, "DOWN", now=T + DAY - 3_600_000, t=T + DAY)
    env.resolve(OBS1 + DAY, t=T + DAY, rows=rows_for("100", "90", t=T + DAY))
    assert env.c.get_market_candidate(T) == {"exists": False}
    assert env.c.get_market_candidate(T + DAY)["outcome"] == "DOWN"


# ---------------------------------------------------------------------------
# Layer 3: validator agreement / disagreement (whole-record, type-exact)
# ---------------------------------------------------------------------------
def test_V_identical_evidence_agrees(after_leader):
    assert votes(after_leader.vm) is True


def test_V_equivalent_decimal_representations_agree(after_leader):
    after_leader.remock(rows_for("100.0", "120.00000000"))
    assert votes(after_leader.vm) is True


@pytest.mark.parametrize("o,c", [("105", "120"), ("100", "121"), ("100", "90")])
def test_V_different_prices_disagree_even_with_same_outcome(after_leader, o, c):
    after_leader.remock(rows_for(o, c))
    assert votes(after_leader.vm) is False


@pytest.mark.parametrize(
    "tamper",
    [
        dict(open_time_ms=T + DAY),
        dict(close_time_ms=T + DAY),
        dict(symbol="ETHUSDT"),
        dict(interval="1h"),
        dict(timezone="UTC+8"),
        dict(exchange="BINANCE_FUTURES"),
        dict(source="evil.example"),
        dict(outcome="DOWN"),
        dict(open_price="100.0"),  # non-canonical representation is not equal
        dict(close_price="119"),
        # type confusion: Python == would accept these, canonical JSON does not
        dict(open_time_ms=float(T)),
        dict(close_time_ms=float(T + DAY - 1)),
        dict(open_time_ms=str(T)),
        dict(open_time_ms=True),
        dict(close_time_ms=None),
    ],
)
def test_V_tampered_leader_record_disagrees(after_leader, tamper):
    assert votes(after_leader.vm, leader_result=leader_record(**tamper)) is False


def test_V_untampered_record_agrees(after_leader):
    assert votes(after_leader.vm, leader_result=leader_record()) is True


@pytest.mark.parametrize(
    "bad",
    [
        "UP",
        None,
        {},
        {"outcome": "UP"},
        {k: v for k, v in leader_record().items() if k != "close_price"},
        dict(leader_record(), extra="x"),
        dict(leader_record(), next_open_time_ms=T + DAY),
    ],
)
def test_V_malformed_leader_result_disagrees(after_leader, bad):
    assert votes(after_leader.vm, leader_result=bad) is False


@pytest.mark.parametrize(
    "rows",
    [
        [],
        [row(T, "100", "120")[:7]],
        [row(T - DAY, "100", "120")],
        [row(T, "100", "120"), row(T + DAY, "1", "2")],
    ],
)
def test_V_validator_with_incomplete_or_wrong_evidence_disagrees(after_leader, rows):
    after_leader.remock(rows)
    assert votes(after_leader.vm, leader_result=leader_record()) is False


# ---------------------------------------------------------------------------
# Real-VM readiness checks that Direct Mode CAN perform
# ---------------------------------------------------------------------------
def test_closures_are_picklable_in_direct_mode(env):
    """Direct Mode pickles leader/validator closures only for the SAFE run_nondet
    and only WARNS on failure; promote that warning to a failure. This pickles by
    reference inside one process, so it does NOT prove real-VM pickling."""
    env.vm.check_pickling = True
    bare(env)
    with warnings.catch_warnings():
        warnings.filterwarnings("error", message=".*not picklable.*")
        env.resolve(OBS1, rows=rows_for("100", "120"))
    assert len(env.vm._captured_validators) == 1


def test_views_never_fetch_or_write(env):
    bare(env)
    before = env.state()
    with env.web_spy() as spy:
        env.c.get_market_candidate(T)
        env.c.get_market_result(T)
        env.c.get_prediction(T, A(env.alice))
        env.c.get_user_points(A(env.alice))
    assert env.state() == before and spy.call_count == 0
