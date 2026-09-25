#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
from copy import deepcopy
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR
from pathlib import Path
from unittest.mock import patch

from openpyxl import Workbook, load_workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Font, PatternFill, Protection


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools" / "update_vipcars_rates.py"
CONFIG_PATH = ROOT / "vipcars-rate-update.config.json"
BASELINE_PATH = ROOT / "input" / "vipcars-rate-group-export.xlsx"
MANIFEST_PATH = ROOT / "input" / "vipcars-baseline-manifest.json"

HEADERS = [
    "Group", "Miles / pd", "Mile rate", "Pickup start", "Pickup end",
    "Rate zone", "Booking start", "Booking end", "1  per day",
    "2 - 6  per day", "7 - 8  per day", "9+ per day",
]
PRODUCTION_GROUPS = [
    "CDMR", "CFAR", "CFAR1", "CFAR2", "CFMR", "CWAR",
    "CWAR1", "CWAR2", "CWAR3", "CWMR", "EDAR", "EDMR",
]
FROZEN_GROUPS = ["IDAR", "IDAR1", "IFAR", "IFAR1", "IFAR2", "PDAR", "PFAR"]
WARSAW_ZONE = {
    "location": "Warsaw",
    "code": "WAR",
    "name": "WARSZAWA - AIRPORT",
    "metroplex": "Main Metroplex",
}
FX = Decimal("4.3")
VAT_MULTIPLIER = Decimal("1.23")
UNDERCUT = Decimal("0.5")
QUANTUM = Decimal("0.001")

EXISTING_REVIEW_HEADERS = [
    "Pickup date", "Duration", "Location", "Rate zone", "Rate zone name", "Metroplex",
    "Action", "Type", "Quality", "Coverage", "MM rank", "MM gross EUR/day",
    "Pay Now EUR", "Pay Now EUR/day", "Pay Now share", "Broker markup",
    "Broker multiplier", "MM net EUR/day", "Benchmark", "Benchmark EUR/day",
    "Individual target gross EUR/day", "Individual target net EUR/day", "Target rank", "Reason", "VAT percent",
]
NEW_REVIEW_HEADERS = [
    "Band net EUR/day", "Predicted gross EUR/day", "Achieved rank", "Band status",
    "Minimum MM gross PLN/day", "EUR/PLN", "FX source", "FX date",
]


def load_updater():
    spec = importlib.util.spec_from_file_location("vipcars_rate_updater", SCRIPT)
    updater = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(updater)
    return updater


def production_config() -> dict:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def single_zone_config(*, bands: list[dict] | None = None, groups: list[str] | None = None) -> dict:
    config = production_config()
    config["rate_zones"] = [deepcopy(WARSAW_ZONE)]
    config["apply_groups"] = list(groups or PRODUCTION_GROUPS)
    if bands is not None:
        config["duration_bands"] = deepcopy(bands)
    return config


def floor_pln(pickup_date: str, rental_days: int) -> Decimal:
    if date.fromisoformat(pickup_date) > date(2026, 10, 25):
        return Decimal(0)
    if 2 <= rental_days <= 6:
        return Decimal(30)
    if 7 <= rental_days <= 8:
        return Decimal(40)
    return Decimal(0)


def floor_net(pickup_date: str, rental_days: int) -> Decimal:
    return floor_pln(pickup_date, rental_days) / FX / VAT_MULTIPLIER


def quantize_down(value: Decimal) -> Decimal:
    return value.quantize(QUANTUM, rounding=ROUND_FLOOR)


def quantize_up(value: Decimal) -> Decimal:
    return value.quantize(QUANTUM, rounding=ROUND_CEILING)


def competitor_for_net(net_rate: Decimal, broker: Decimal) -> float:
    return float(net_rate * broker * VAT_MULTIPLIER + UNDERCUT)


def expected_cap(competitor_rate: float, broker: float) -> Decimal:
    raw = (Decimal(str(competitor_rate)) - UNDERCUT) / Decimal(str(broker)) / VAT_MULTIPLIER
    return quantize_down(raw)


def make_decision(
    pickup_date: str,
    rental_days: int,
    competitor_rates: list[float],
    *,
    broker: float = 1.1,
    mm_total_eur: float | None = None,
    pay_now_total_eur: float | None = None,
    location: str = "Warsaw",
    zone: dict | None = None,
) -> dict:
    zone = zone or WARSAW_ZONE
    exact_pairs = {
        Decimal("1.0"): (Decimal(10), Decimal(0)),
        Decimal("1.05"): (Decimal(21), Decimal(1)),
        Decimal("1.1"): (Decimal(11), Decimal(1)),
        Decimal("1.2"): (Decimal(6), Decimal(1)),
        Decimal("1.25"): (Decimal(5), Decimal(1)),
    }
    if mm_total_eur is None or pay_now_total_eur is None:
        site_rate, pay_now_rate = exact_pairs[Decimal(str(broker))]
        raw_total = site_rate * rental_days
        raw_pay_now = pay_now_rate * rental_days
    else:
        raw_total = Decimal(str(mm_total_eur))
        raw_pay_now = Decimal(str(pay_now_total_eur))
        site_rate = raw_total / rental_days
        pay_now_rate = raw_pay_now / rental_days
    supplier_gross_rate = (raw_total - raw_pay_now) / rental_days
    mm_net_rate = supplier_gross_rate / VAT_MULTIPLIER
    minimum_pln = floor_pln(pickup_date, rental_days)
    minimum_net = minimum_pln / FX / VAT_MULTIPLIER
    target_candidates = []
    for rank, competitor_rate in enumerate(competitor_rates, 1):
        site_target = Decimal(str(competitor_rate)) - UNDERCUT
        target_candidates.append({
            "target_rank": rank,
            "site_target_rate_eur_day": float(site_target),
            "net_rate_eur_day": float(site_target / Decimal(str(broker)) / VAT_MULTIPLIER),
        })
    first = target_candidates[0]
    pickup = date.fromisoformat(pickup_date)
    return {
        "location": location,
        "rate_zone": zone["code"],
        "rate_zone_name": zone["name"],
        "metroplex": zone["metroplex"],
        "pickup_date": pickup_date,
        "dropoff_date": (pickup + timedelta(days=rental_days)).isoformat(),
        "rental_days": rental_days,
        "currency": "EUR",
        "coverage_status": "complete",
        "data_quality_status": "ok",
        "action": "decrease",
        "recommendation_type": "absolute_competitor_undercut",
        "target_rank": 1,
        "reason": "Synthetic absolute-rate decision.",
        "mm_rank": len(competitor_rates) + 1,
        "mm_total_eur": float(raw_total),
        "mm_rate_eur_day": float(site_rate),
        "pay_now_total_eur": float(raw_pay_now),
        "pay_now_eur_day": float(pay_now_rate),
        "pay_now_share_percent": float(raw_pay_now / raw_total * 100),
        "broker_markup_multiplier": broker,
        "broker_markup_percent": float(raw_pay_now / (raw_total - raw_pay_now) * 100),
        "broker_markup_source": "scraped_pay_now",
        "mm_supplier_gross_rate_eur_day": float(supplier_gross_rate),
        "mm_net_rate_eur_day": float(mm_net_rate),
        "benchmark_provider": "Competitor 1",
        "benchmark_rate_eur_day": competitor_rates[0],
        "site_target_rate_eur_day": first["site_target_rate_eur_day"],
        "site_target_supplier_gross_rate_eur_day": first["site_target_rate_eur_day"] / broker,
        "site_target_net_rate_eur_day": first["net_rate_eur_day"],
        "maximum_adjustment_ratio": first["net_rate_eur_day"] / float(mm_net_rate),
        "vat_rate_percent": 23,
        "minimum_supplier_gross_pln_day": float(minimum_pln),
        "minimum_net_rate_eur_day": float(minimum_net),
        "competitor_rates_eur_day": [
            {"provider": f"Competitor {rank}", "rate_eur_day": rate}
            for rank, rate in enumerate(competitor_rates, 1)
        ],
        "target_candidates": target_candidates,
    }


def make_recommendations(decisions: list[dict], locations: list[str] | None = None) -> dict:
    return {
        "generated_at": "2026-09-25T00:00:00Z",
        "pricing_model": "absolute_net_v1",
        "transmission": "automatic",
        "vehicle_category": "",
        "exchange_rate": {
            "pln_per_eur": 4.3,
            "source": "fallback",
            "effective_date": None,
        },
        "vat_rate_percent": 23,
        "undercut_eur_day": 0.5,
        "expected_locations": locations or ["Warsaw"],
        "decisions": decisions,
    }


def expect_value_error(action, text: str) -> None:
    try:
        action()
    except ValueError as error:
        assert text.lower() in str(error).lower(), str(error)
    else:
        raise AssertionError(f"Expected ValueError containing {text!r}")


def sheet_with_rows(rows: list[list]):
    sheet = Workbook().active
    sheet.append(HEADERS)
    for row in rows:
        sheet.append(row)
    return sheet


def check_production_contract_and_baseline() -> None:
    config = production_config()
    assert config["apply_groups"] == PRODUCTION_GROUPS
    assert "minimum_change_eur_day" not in config
    assert config["pricing"] == {
        "vat_rate_percent": 23,
        "undercut_eur_day": 0.5,
        "min_broker_markup_multiplier": 1,
        "max_broker_markup_multiplier": 1.25,
    }
    assert config["rate_precision"] == 3
    assert config["exchange_rate"] == {"fallback_pln_per_eur": 4.3}
    assert config["minimum_rates"] == {
        "end_date": "2026-10-25",
        "bands": [
            {"min_days": 2, "max_days": 6, "min_pln_gross_day": 30},
            {"min_days": 7, "max_days": 8, "min_pln_gross_day": 40},
        ],
    }
    assert config["duration_bands"] == [
        {"column": "I", "label": "1", "min_days": 1, "max_days": 1, "update_enabled": False},
        {"column": "J", "label": "2-6", "min_days": 2, "max_days": 6},
        {"column": "K", "label": "7-8", "min_days": 7, "max_days": 8},
        {"column": "L", "label": "9+", "min_days": 9, "max_days": 14, "update_enabled": False},
    ]

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    baseline_hash = hashlib.sha256(BASELINE_PATH.read_bytes()).hexdigest()
    assert baseline_hash == manifest["workbook_sha256"]
    workbook = load_workbook(BASELINE_PATH, read_only=True, data_only=False)
    sheet = workbook[config["worksheet"]]
    assert [cell.value for cell in next(sheet.iter_rows(max_row=1))] == HEADERS
    assert sheet.max_row - 1 == 16322
    expanded_count = 0
    for row in sheet.iter_rows(min_row=2, values_only=True):
        start = datetime.strptime(row[3], "%d/%m/%Y").date()
        end = datetime.strptime(row[4], "%d/%m/%Y").date()
        expanded_count += (end - start).days + 1
        assert not any(isinstance(value, str) and value.startswith("=") for value in row)
    assert expanded_count == 17297
    workbook.close()


def check_expansion_preserves_formatting() -> None:
    updater = load_updater()
    bands = production_config()["duration_bands"]
    sheet = sheet_with_rows([
        ["CFAR", 0, 0, "02/09/2026", "04/09/2026", "WAR", None, None, 40, 20, 18, 17],
        ["CDMR", 0, 0, "05/09/2026", "05/09/2026", "WAR", None, None, 50, 40, 38, 37],
    ])
    sheet.row_dimensions[2].height = 24
    sheet.row_dimensions[2].hidden = True
    sheet.row_dimensions[3].height = 18
    source = sheet["J2"]
    source.font = Font(bold=True, color="123456")
    source.fill = PatternFill(fill_type="solid", fgColor="FEDCBA")
    source.alignment = Alignment(horizontal="right", wrap_text=True)
    source.protection = Protection(locked=False, hidden=True)
    source.number_format = "0.000"
    source.hyperlink = "https://www.vipcars.com/"
    source.comment = Comment("Source note", "Test")
    with patch.object(sheet, "insert_rows", wraps=sheet.insert_rows) as insert:
        assert updater.expand_pickup_ranges(sheet, bands) == 4
        insert.assert_called_once_with(3, 2)
    for row_index in (3, 4):
        copied = sheet.cell(row_index, 10)
        assert copied.value == source.value and copied._style == source._style
        assert copied._style is not source._style
        assert copied.comment.text == source.comment.text
        assert copied.hyperlink.target == source.hyperlink.target
        assert sheet.row_dimensions[row_index].height == 24
        assert sheet.row_dimensions[row_index].hidden is True
    assert [sheet.cell(row, 4).value for row in range(2, 6)] == [
        "02/09/2026", "03/09/2026", "04/09/2026", "05/09/2026",
    ]
    assert sheet["A5"].value == "CDMR"
    assert sheet.row_dimensions[5].height == 18
    assert sheet.row_dimensions[5].hidden is False


def check_header_and_baseline_rejections() -> None:
    updater = load_updater()
    bands = production_config()["duration_bands"]
    extra = sheet_with_rows([])
    extra["M1"] = "Unexpected"
    expect_value_error(lambda: updater.validate_sheet(extra, bands), "exactly 12 columns")
    wrong = sheet_with_rows([])
    wrong["J1"] = "2 - 5  per day"
    expect_value_error(lambda: updater.validate_sheet(wrong, bands), "unexpected import headers")

    with tempfile.TemporaryDirectory(prefix="vipcars-baseline-test-") as raw_temp:
        manifest_path = Path(raw_temp) / "wrong-baseline.json"
        manifest_path.write_text(json.dumps({"workbook_sha256": "0" * 64}), encoding="utf-8")
        expect_value_error(
            lambda: updater.verify_baseline(
                BASELINE_PATH,
                Path(raw_temp) / "config.json",
                {"baseline_manifest_file": str(manifest_path)},
            ),
            "baseline manifest",
        )


def check_shared_absolute_plans_and_application() -> None:
    updater = load_updater()
    config = single_zone_config()
    brokers = {2: 1.0, 3: 1.1, 4: 1.2, 5: 1.25, 6: 1.05, 7: 1.1, 8: 1.2}
    raw_caps = {
        2: Decimal("7.1004"), 3: Decimal("6.9009"), 4: Decimal("8.0004"),
        5: Decimal("6.2008"), 6: Decimal("5.7009"),
        7: Decimal("8.1009"), 8: Decimal("7.6008"),
    }
    decisions = []
    for days in range(2, 9):
        broker = Decimal(str(brokers[days]))
        first = competitor_for_net(raw_caps[days], broker)
        decision = make_decision(
            "2026-10-01", days, [first, first + 10, first + 20], broker=float(broker)
        )
        # The safety layer must derive the cap from raw competitor data.
        decision["target_candidates"][0]["net_rate_eur_day"] = 999.0
        decisions.append(decision)

    plans, blocked = updater.build_band_plans(
        make_recommendations(decisions), config["duration_bands"], config["rate_zones"], config
    )
    assert not blocked
    assert set(plans) == {("2026-10-01", "J", "WAR"), ("2026-10-01", "K", "WAR")}
    j_plan = plans[("2026-10-01", "J", "WAR")]
    k_plan = plans[("2026-10-01", "K", "WAR")]
    assert set(j_plan) == {"target_net_rate", "band", "controlling", "rate_zone", "checks"}
    assert set(k_plan) == {"target_net_rate", "band", "controlling", "rate_zone", "checks"}
    expected_j = min(expected_cap(
        decisions[days - 2]["competitor_rates_eur_day"][0]["rate_eur_day"], brokers[days]
    ) for days in range(2, 7))
    expected_k = min(expected_cap(
        decisions[days - 2]["competitor_rates_eur_day"][0]["rate_eur_day"], brokers[days]
    ) for days in range(7, 9))
    assert Decimal(str(j_plan["target_net_rate"])) == expected_j == Decimal("5.700")
    assert Decimal(str(k_plan["target_net_rate"])) == expected_k == Decimal("7.600")
    assert len(j_plan["checks"]) == 5 and len(k_plan["checks"]) == 2
    for check in j_plan["checks"] + k_plan["checks"]:
        assert check["target_rank"] == check["achieved_rank"] == 1
        assert check["supplier_gross_pln_day"] + 1e-9 >= check["minimum_supplier_gross_pln_day"]

    rows = []
    for group in PRODUCTION_GROUPS + FROZEN_GROUPS:
        j_rate = 5.7004 if group == "CFAR" else 1000
        rows.append([group, 0, None, "01/10/2026", "01/10/2026", "WAR", None, None, 2000, j_rate, 1000, 500])
    sheet = sheet_with_rows(rows)
    changes = updater.apply_plans(sheet, plans, config)
    assert len(changes) == len(PRODUCTION_GROUPS) * 2
    for row_index, group in enumerate(PRODUCTION_GROUPS + FROZEN_GROUPS, 2):
        values = [sheet.cell(row_index, column).value for column in range(9, 13)]
        if group in PRODUCTION_GROUPS:
            assert values == [2000, 5.7, 7.6, 500]
        else:
            assert values == [2000, 1000, 1000, 500]
    assert all(change["updated_rate"] in {5.7, 7.6} for change in changes)
    assert min(change["adjustment_ratio"] for change in changes) < 0.01


def check_rank_fallbacks_and_quantized_floor() -> None:
    updater = load_updater()
    band = {"column": "J", "label": "2", "min_days": 2, "max_days": 2}
    config = single_zone_config(bands=[band], groups=["CFAR"])
    raw_minimum = floor_net("2026-10-01", 2)
    minimum = quantize_up(raw_minimum)
    broker = Decimal("1.1")
    scenarios = [
        ([minimum + Decimal("0.0017"), minimum + 1, minimum + 2], 1),
        ([raw_minimum + Decimal("0.00001"), minimum + Decimal("0.2504"), minimum + 2], 2),
        ([raw_minimum - Decimal("0.00002"), raw_minimum + Decimal("0.00001"), minimum + 1], 3),
    ]
    for caps, expected_rank in scenarios:
        competitors = [competitor_for_net(cap, broker) for cap in caps]
        decision = make_decision("2026-10-01", 2, competitors, broker=float(broker))
        plans, blocked = updater.build_band_plans(
            make_recommendations([decision]), [band], config["rate_zones"], config
        )
        assert not blocked
        plan = plans[("2026-10-01", "J", "WAR")]
        assert plan["checks"][0]["target_rank"] == expected_rank
        assert Decimal(str(plan["target_net_rate"])) == expected_cap(
            competitors[expected_rank - 1], float(broker)
        )
        assert Decimal(str(plan["target_net_rate"])) >= minimum

    boundary_broker = float(Decimal("30") / Decimal("25.01"))
    boundary_decisions = []
    for days in range(2, 7):
        decision = make_decision(
            "2026-10-01", days, [8.87, 9.50], broker=boundary_broker,
            mm_total_eur=30, pay_now_total_eur=4.99,
        )
        decision["mm_total_eur"] = "30"
        decision["pay_now_total_eur"] = "4.99"
        boundary_decisions.append(decision)
    boundary_config = single_zone_config()
    boundary_plans, boundary_blocked = updater.build_band_plans(
        make_recommendations(boundary_decisions),
        boundary_config["duration_bands"],
        boundary_config["rate_zones"],
        boundary_config,
    )
    assert not boundary_blocked
    boundary_plan = boundary_plans[("2026-10-01", "J", "WAR")]
    assert boundary_plan["target_net_rate"] == 5.673
    assert len(boundary_plan["checks"]) == 5
    assert all(check["target_rank"] == check["achieved_rank"] == 1 for check in boundary_plan["checks"])
    assert all(check["predicted_site_gross_eur_day"] <= 8.37 for check in boundary_plan["checks"])
    assert all(check["supplier_gross_pln_day"] >= 30 for check in boundary_plan["checks"])

    blocked_caps = [
        raw_minimum - Decimal("0.002"),
        raw_minimum - Decimal("0.001"),
        raw_minimum + Decimal("0.00001"),
    ]
    blocked_decision = make_decision(
        "2026-10-01", 2,
        [competitor_for_net(cap, broker) for cap in blocked_caps],
        broker=float(broker),
    )
    plans, blocked = updater.build_band_plans(
        make_recommendations([blocked_decision]), [band], config["rate_zones"], config
    )
    assert not plans and len(blocked) == 1
    assert "floor blocks top3" in blocked[0]["reason"].lower()


def check_full_band_blocking() -> None:
    updater = load_updater()
    config = single_zone_config()
    decisions = [make_decision("2026-10-01", days, [30, 40, 50]) for days in range(2, 9)]

    missing = [item for item in decisions if item["rental_days"] != 4]
    plans, blocked = updater.build_band_plans(
        make_recommendations(missing), config["duration_bands"], config["rate_zones"], config
    )
    assert ("2026-10-01", "J", "WAR") not in plans
    assert ("2026-10-01", "K", "WAR") in plans
    assert {item["duration_band"] for item in blocked} == {"2-6"}

    invalid = deepcopy(decisions)
    next(item for item in invalid if item["rental_days"] == 4)["currency"] = None
    plans, blocked = updater.build_band_plans(
        make_recommendations(invalid), config["duration_bands"], config["rate_zones"], config
    )
    assert ("2026-10-01", "J", "WAR") not in plans
    assert any("expected an eur recommendation" in item["reason"].lower() for item in blocked)

    infeasible = deepcopy(decisions)
    old = next(item for item in infeasible if item["rental_days"] == 4)
    raw_minimum = floor_net("2026-10-01", 4)
    broker = Decimal(str(old["broker_markup_multiplier"]))
    rates = [competitor_for_net(raw_minimum - Decimal(index) / 1000, broker) for index in (3, 2, 1)]
    infeasible[infeasible.index(old)] = make_decision("2026-10-01", 4, rates, broker=float(broker))
    plans, blocked = updater.build_band_plans(
        make_recommendations(infeasible), config["duration_bands"], config["rate_zones"], config
    )
    assert ("2026-10-01", "J", "WAR") not in plans
    assert any("floor blocks top3" in item["reason"].lower() for item in blocked)
    sheet = sheet_with_rows([
        ["CFAR", 0, None, "01/10/2026", "01/10/2026", "WAR", None, None, 10, 20, 30, 40]
    ])
    updater.apply_plans(sheet, plans, config)
    assert sheet["J2"].value == 20


def check_disabled_bands_and_post_policy_rates() -> None:
    updater = load_updater()
    config = single_zone_config()
    disabled_decisions = [make_decision("2026-10-01", 1, [10, 20, 30])]
    disabled_decisions.extend(make_decision("2026-10-01", days, [10, 20, 30]) for days in range(9, 15))
    plans, blocked = updater.build_band_plans(
        make_recommendations(disabled_decisions), config["duration_bands"], config["rate_zones"], config
    )
    assert not plans
    assert {item["duration_band"] for item in blocked} == {"1", "9+"}

    band = {"column": "J", "label": "2", "min_days": 2, "max_days": 2}
    post_config = single_zone_config(bands=[band], groups=["CFAR"])
    for pickup_date in ("2026-10-26", "2026-10-31", "2035-01-01"):
        competitor = competitor_for_net(Decimal("0.0029"), Decimal("1.1"))
        decision = make_decision(pickup_date, 2, [competitor], broker=1.1)
        assert decision["minimum_supplier_gross_pln_day"] == 0
        assert decision["minimum_net_rate_eur_day"] == 0
        plans, blocked = updater.build_band_plans(
            make_recommendations([decision]), [band], post_config["rate_zones"], post_config
        )
        assert not blocked
        assert plans[(pickup_date, "J", "WAR")]["target_net_rate"] == 0.002


def check_fail_closed_payloads() -> None:
    updater = load_updater()
    band = {"column": "J", "label": "2", "min_days": 2, "max_days": 2}
    config = single_zone_config(bands=[band], groups=["CFAR"])
    decision = make_decision("2026-10-01", 2, [30, 40, 50])
    base = make_recommendations([decision])

    legacy = deepcopy(base)
    legacy.pop("pricing_model")
    legacy["decisions"][0]["maximum_adjustment_ratio"] = 0.5
    expect_value_error(
        lambda: updater.build_band_plans(legacy, [band], config["rate_zones"], config),
        "absolute_net_v1",
    )
    for exchange in ({}, {"pln_per_eur": 0, "source": "fallback", "effective_date": None}):
        invalid = deepcopy(base)
        invalid["exchange_rate"] = exchange
        expect_value_error(
            lambda invalid=invalid: updater.build_band_plans(invalid, [band], config["rate_zones"], config),
            "eur/pln",
        )
    wrong_model = deepcopy(base)
    wrong_model["pricing_model"] = "percentage_v1"
    expect_value_error(
        lambda: updater.build_band_plans(wrong_model, [band], config["rate_zones"], config),
        "absolute_net_v1",
    )
    wrong_vat = deepcopy(base)
    wrong_vat["vat_rate_percent"] = 22
    expect_value_error(
        lambda: updater.build_band_plans(wrong_vat, [band], config["rate_zones"], config),
        "vat differs",
    )
    wrong_undercut = deepcopy(base)
    wrong_undercut["undercut_eur_day"] = 0.25
    expect_value_error(
        lambda: updater.build_band_plans(wrong_undercut, [band], config["rate_zones"], config),
        "undercut differs",
    )

    wrong_floor = deepcopy(base)
    wrong_floor["decisions"][0]["minimum_supplier_gross_pln_day"] = 0
    plans, blocked = updater.build_band_plans(wrong_floor, [band], config["rate_zones"], config)
    assert not plans and len(blocked) == 1
    assert "decision minimum differs" in blocked[0]["reason"].lower()

    missing_raw_total = deepcopy(base)
    missing_raw_total["decisions"][0].pop("mm_total_eur")
    plans, blocked = updater.build_band_plans(missing_raw_total, [band], config["rate_zones"], config)
    assert not plans and len(blocked) == 1
    assert "mm gross total eur" in blocked[0]["reason"].lower()


def check_missing_locations_and_classes() -> None:
    updater = load_updater()
    band = {"column": "J", "label": "2", "min_days": 2, "max_days": 2}
    second_zone = {
        "location": "Krakow", "code": "KRA", "name": "KRAKOW - AIRPORT", "metroplex": "Main Metroplex"
    }
    config = single_zone_config(bands=[band], groups=["CFAR", "CDMR"])
    config["rate_zones"] = [deepcopy(WARSAW_ZONE), second_zone]
    recommendations = make_recommendations([make_decision("2026-10-01", 2, [30, 40, 50])])
    expect_value_error(
        lambda: updater.build_band_plans(recommendations, [band], config["rate_zones"], config),
        "every configured rate zone",
    )

    one_zone = single_zone_config(bands=[band], groups=["CFAR", "CDMR"])
    plans, blocked = updater.build_band_plans(
        recommendations, [band], one_zone["rate_zones"], one_zone
    )
    assert not blocked
    sheet = sheet_with_rows([
        ["CFAR", 0, None, "01/10/2026", "01/10/2026", "WAR", None, None, 10, 20, 30, 40]
    ])
    expect_value_error(lambda: updater.validate_plan_targets(sheet, plans, one_zone), "cdmr")

    for invalid_rate in ("not-a-rate", float("nan"), -1):
        duplicate_invalid = sheet_with_rows([
            ["CFAR", 0, None, "01/10/2026", "01/10/2026", "WAR", None, None, 10, 20, 30, 40],
            ["CFAR", 0, None, "01/10/2026", "01/10/2026", "WAR", None, None, 10, invalid_rate, 30, 40],
            ["CDMR", 0, None, "01/10/2026", "01/10/2026", "WAR", None, None, 10, 20, 30, 40],
        ])
        expect_value_error(
            lambda sheet=duplicate_invalid: updater.validate_plan_targets(sheet, plans, one_zone),
            "invalid planned baseline rate in row",
        )

    non_target_invalid = sheet_with_rows([
        ["CFAR", 0, None, "01/10/2026", "01/10/2026", "WAR", None, None, 10, 20, 30, 40],
        ["CDMR", 0, None, "01/10/2026", "01/10/2026", "WAR", None, None, 10, 20, 30, 40],
        ["IDAR", 0, None, "01/10/2026", "01/10/2026", "WAR", None, None, 10, "not-a-rate", 30, 40],
    ])
    updater.validate_plan_targets(non_target_invalid, plans, one_zone)


def generate_real_recommendations(path: Path) -> dict:
    generated = subprocess.run([
        "node", "-e", r"""
const fs = require('node:fs');
const { buildRecommendations } = require('./src/vipcars/pricingRecommendations');
const config = require('./vipcars-rate-update.config.json');
const offers = [];
const coverage = [];
for (const zone of config.rate_zones) {
  for (let days = 2; days <= 14; days++) {
    const check = {
      location: zone.location,
      duration_days: days,
      pickup_date: '2026-10-01',
      dropoff_date: `2026-10-${String(1 + days).padStart(2, '0')}`,
      status: 'complete',
      result_count: 2
    };
    coverage.push(check);
    offers.push({
      ...check,
      provider: 'MM Cars Rental',
      currency: 'EUR',
      price_per_day: 133,
      total_price: 133 * days,
      pay_now_amount: 10 * days,
      pay_now_currency: 'EUR'
    });
    offers.push({
      ...check,
      provider: 'Test competitor',
      currency: 'EUR',
      price_per_day: 157.85,
      total_price: 157.85 * days
    });
  }
}
const fixedExchangeRate = { pln_per_eur: 4.3, source: 'fallback', effective_date: null };
const result = buildRecommendations(offers, coverage, {
  expectedLocations: config.rate_zones.map((zone) => zone.location),
  expectedDurations: Array.from({ length: 13 }, (_, index) => index + 2),
  expectedPickupCount: 1,
  rateZones: config.rate_zones,
  pricingModel: 'absolute_net_v1',
  transmission: 'automatic',
  vehicleCategory: '',
  vatRatePercent: config.pricing.vat_rate_percent,
  undercutEurDay: config.pricing.undercut_eur_day,
  minBrokerMarkupMultiplier: config.pricing.min_broker_markup_multiplier,
  maxBrokerMarkupMultiplier: config.pricing.max_broker_markup_multiplier,
  exchangeRate: fixedExchangeRate,
  plnPerEur: fixedExchangeRate.pln_per_eur,
  exchangeRateSource: fixedExchangeRate.source,
  exchangeRateEffectiveDate: fixedExchangeRate.effective_date,
  minimumRates: config.minimum_rates
});
fs.writeFileSync(process.argv[1], JSON.stringify(result));
""", str(path)
    ], cwd=ROOT, capture_output=True, text=True)
    assert generated.returncode == 0, generated.stderr or generated.stdout
    return json.loads(path.read_text(encoding="utf-8"))


def check_js_payload(payload: dict) -> None:
    assert payload["pricing_model"] == "absolute_net_v1"
    assert payload["transmission"] == "automatic"
    assert payload["vehicle_category"] == ""
    assert payload["exchange_rate"] == {
        "pln_per_eur": 4.3, "source": "fallback", "effective_date": None,
    }
    assert payload["vat_rate_percent"] == 23
    assert payload["undercut_eur_day"] == 0.5
    assert len(payload["decisions"]) == 7 * 13
    expected_broker = 133 / 123
    expected_target = 157.35 / expected_broker / 1.23
    for decision in payload["decisions"]:
        days = decision["rental_days"]
        expected_floor = 30 if days <= 6 else 40 if days <= 8 else 0
        assert decision["currency"] == "EUR"
        assert decision["coverage_status"] == "complete"
        assert decision["data_quality_status"] == "ok"
        assert Decimal(str(decision["mm_total_eur"])) == Decimal(133 * days)
        assert Decimal(str(decision["pay_now_total_eur"])) == Decimal(10 * days)
        assert abs(decision["broker_markup_multiplier"] - expected_broker) < 1e-12
        assert decision["vat_rate_percent"] == 23
        assert decision["minimum_supplier_gross_pln_day"] == expected_floor
        assert abs(
            decision["minimum_net_rate_eur_day"] - (expected_floor / 4.3 / 1.23)
        ) < 1e-12
        assert decision["competitor_rates_eur_day"] == [
            {"provider": "Test competitor", "rate_eur_day": 157.85}
        ]
        assert len(decision["target_candidates"]) == 1
        candidate = decision["target_candidates"][0]
        assert candidate["target_rank"] == 1
        assert candidate["site_target_rate_eur_day"] == 157.35
        assert abs(candidate["net_rate_eur_day"] - expected_target) < 1e-12
        assert decision["mm_net_rate_eur_day"] == 100


def iter_expected_source_rows(source_rows: list[tuple]):
    for source in source_rows:
        start = datetime.strptime(source[3], "%d/%m/%Y").date()
        end = datetime.strptime(source[4], "%d/%m/%Y").date()
        for offset in range((end - start).days + 1):
            day = start + timedelta(days=offset)
            expected = list(source)
            expected[3] = expected[4] = day.strftime("%d/%m/%Y")
            yield day, expected


def check_production_end_to_end() -> None:
    config = production_config()
    baseline_hash = hashlib.sha256(BASELINE_PATH.read_bytes()).hexdigest()
    source_book = load_workbook(BASELINE_PATH, read_only=True, data_only=False)
    source_sheet = source_book[config["worksheet"]]
    source_rows = list(source_sheet.iter_rows(min_row=2, values_only=True))
    source_book.close()
    target_counts = {
        (row[0], row[5]): 0 for row in source_rows
        if row[0] in PRODUCTION_GROUPS
    }
    for row in source_rows:
        if row[0] in PRODUCTION_GROUPS and row[3] == row[4] == "01/10/2026":
            target_counts[(row[0], row[5])] += 1
    expected_targets = {(group, zone["code"]) for group in PRODUCTION_GROUPS for zone in config["rate_zones"]}
    assert set(target_counts) == expected_targets
    assert set(target_counts.values()) == {1}

    with tempfile.TemporaryDirectory(prefix="vipcars-absolute-integration-") as raw_temp:
        temp = Path(raw_temp)
        recommendations_path = temp / "recommendations.json"
        payload = generate_real_recommendations(recommendations_path)
        check_js_payload(payload)
        report_path = temp / "review.xlsx"
        import_path = temp / "import.xlsx"
        summary_path = temp / "summary.json"
        result = subprocess.run([
            sys.executable, str(SCRIPT),
            "--workbook", str(BASELINE_PATH),
            "--recommendations", str(recommendations_path),
            "--config", str(CONFIG_PATH),
            "--report-output", str(report_path),
            "--import-output", str(import_path),
            "--summary-output", str(summary_path),
        ], cwd=ROOT, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr or result.stdout
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        assert summary["source_workbook_sha256"] == baseline_hash
        assert summary["expanded_source_row_count"] == 17297
        assert summary["change_count"] == 12 * 7 * 2 == 168
        assert summary["blocked_band_count"] == 7
        assert {item["duration_band"] for item in summary["blocked_bands"]} == {"9+"}

        imported = load_workbook(import_path, read_only=False, data_only=False)
        assert imported.sheetnames == ["RateGroup Export"]
        import_sheet = imported["RateGroup Export"]
        assert import_sheet.max_row - 1 == 17297
        actual_rows = iter(import_sheet.iter_rows(min_row=2, values_only=True))
        approved_positions = 0
        for day, expected in iter_expected_source_rows(source_rows):
            actual = next(actual_rows)
            for index, (actual_value, expected_value) in enumerate(zip(actual, expected)):
                approved = (
                    day.isoformat() == "2026-10-01"
                    and expected[0] in PRODUCTION_GROUPS
                    and index in (9, 10)
                )
                if approved:
                    assert actual_value == 118.308, (expected[0], expected[5], index)
                    assert type(actual_value) is float
                    approved_positions += 1
                else:
                    assert actual_value == expected_value, (expected[0], expected[5], day, index)
                    assert type(actual_value) is type(expected_value), (
                        expected[0], expected[5], day, index, type(actual_value), type(expected_value)
                    )
                assert not (isinstance(actual_value, str) and actual_value.startswith("="))
        assert next(actual_rows, None) is None
        assert approved_positions == 168
        assert all(cell.comment is None for row in import_sheet for cell in row)

        report = load_workbook(report_path, read_only=False, data_only=False)
        assert report.sheetnames == [
            "RateGroup Export", "Changed Positions", "Recommendations Review", "Validation"
        ]
        report_sheet = report["RateGroup Export"]
        for report_row, import_row in zip(
            report_sheet.iter_rows(values_only=True), import_sheet.iter_rows(values_only=True)
        ):
            assert report_row == import_row

        changed_sheet = report["Changed Positions"]
        changed_headers = [cell.value for cell in changed_sheet[1]]
        changed_index = {name: index for index, name in enumerate(changed_headers)}
        changed_rows = list(changed_sheet.iter_rows(min_row=2, values_only=True))
        assert len(changed_rows) == 168
        assert {row[changed_index["Updated net EUR/day"]] for row in changed_rows} == {118.308}
        assert all(
            row[changed_index["Original net EUR/day"]] != row[changed_index["Updated net EUR/day"]]
            for row in changed_rows
        )
        changed_cells = {row[changed_index["Cell"]] for row in changed_rows}
        annotated_cells = {
            cell.coordinate for row in report_sheet.iter_rows() for cell in row if cell.comment is not None
        }
        assert annotated_cells == changed_cells
        assert len(changed_cells) == 168
        for address in changed_cells:
            assert report_sheet[address].comment.author == "VipCars scraper"
            assert report_sheet[address].fill.fgColor.rgb == "00FFF2CC"

        review = report["Recommendations Review"]
        review_headers = [cell.value for cell in review[1]]
        assert len(review_headers) == len(EXISTING_REVIEW_HEADERS) + len(NEW_REVIEW_HEADERS)
        assert set(review_headers) == set(EXISTING_REVIEW_HEADERS + NEW_REVIEW_HEADERS)
        assert review.max_row == len(payload["decisions"]) + 1
        first_review = dict(zip(review_headers, [cell.value for cell in review[2]]))
        assert first_review["Pay Now EUR"] == 20
        assert isinstance(first_review["Pay Now EUR"], (int, float))
        assert first_review["Individual target net EUR/day"] is not None
        assert first_review["Band net EUR/day"] == 118.308
        assert first_review["Achieved rank"] == 1
        assert first_review["Band status"] == "VERIFIED"
        assert first_review["Minimum MM gross PLN/day"] in {0, 30, 40}
        assert first_review["EUR/PLN"] == 4.3
        assert first_review["FX source"] == "fallback"
        report.close()
        imported.close()

    assert hashlib.sha256(BASELINE_PATH.read_bytes()).hexdigest() == baseline_hash


def main() -> None:
    check_production_contract_and_baseline()
    check_expansion_preserves_formatting()
    check_header_and_baseline_rejections()
    check_shared_absolute_plans_and_application()
    check_rank_fallbacks_and_quantized_floor()
    check_full_band_blocking()
    check_disabled_bands_and_post_policy_rates()
    check_fail_closed_payloads()
    check_missing_locations_and_classes()
    check_production_end_to_end()
    print("All VipCars absolute rate updater tests passed.")


if __name__ == "__main__":
    main()
