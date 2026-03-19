from datetime import datetime, timezone
from typing import Any


WEIGHTS = {"cost": 0.40, "reliability": 0.30, "sla": 0.30}

SLA_SCORES = {
    "platinum": 1.00,
    "gold":     0.80,
    "silver":   0.55,
    "bronze":   0.30,
    "none":     0.00,
}


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _log(agent, step, action, reasoning, confidence, message=None):
    return {
        "ts":         _utcnow(),
        "step":       step,
        "actor":      agent,
        "action":     action,
        "reasoning":  reasoning,
        "confidence": round(max(0.0, min(1.0, confidence)), 4),
        "message":    message or f"[{agent}] {action}",
    }


# ── Normalisation ──────────────────────────────────────────────────────────────

def _normalise_cost(vendors: list[dict]) -> dict[str, float]:
    amounts = [v["quote_amount"] for v in vendors if v.get("quote_amount") is not None]
    if not amounts:
        return {v["vendor_id"]: 0.0 for v in vendors}
    lo, hi = min(amounts), max(amounts)
    spread = hi - lo
    result = {}
    for v in vendors:
        amt = v.get("quote_amount")
        if amt is None:
            result[v["vendor_id"]] = 0.0
        elif spread == 0:
            result[v["vendor_id"]] = 1.0
        else:
            result[v["vendor_id"]] = round((hi - amt) / spread, 6)
    return result


def _normalise_reliability(vendors: list[dict]) -> dict[str, float]:
    result = {}
    for v in vendors:
        rating    = float(v.get("rating", 0.0))
        contracts = int(v.get("past_contracts", 0))
        score     = 0.7 * (rating / 5.0) + 0.3 * min(contracts / 20.0, 1.0)
        result[v["vendor_id"]] = round(score, 6)
    return result


def _normalise_sla(vendors: list[dict]) -> dict[str, float]:
    result = {}
    for v in vendors:
        tier = v.get("sla_tier", "").lower()
        if tier in SLA_SCORES:
            result[v["vendor_id"]] = SLA_SCORES[tier]
        else:
            days = float(v.get("avg_delivery_days", 14))
            result[v["vendor_id"]] = round(max(0.0, 1.0 - (days - 3) / 14.0), 6)
    return result


# ── Scoring ────────────────────────────────────────────────────────────────────

def _score_vendors(vendors: list[dict]) -> list[dict]:
    cost_map = _normalise_cost(vendors)
    rel_map  = _normalise_reliability(vendors)
    sla_map  = _normalise_sla(vendors)

    scored = []
    for v in vendors:
        vid = v["vendor_id"]
        c   = cost_map[vid]
        r   = rel_map[vid]
        s   = sla_map[vid]
        composite = (
            WEIGHTS["cost"]        * c +
            WEIGHTS["reliability"] * r +
            WEIGHTS["sla"]         * s
        )
        entry = dict(v)
        entry["_cost_score"]        = round(c, 4)
        entry["_reliability_score"] = round(r, 4)
        entry["_sla_score"]         = round(s, 4)
        entry["_composite_score"]   = round(composite, 4)
        entry["_score_breakdown"]   = {
            "cost":        {"raw": round(c, 4), "weighted": round(WEIGHTS["cost"] * c, 4)},
            "reliability": {"raw": round(r, 4), "weighted": round(WEIGHTS["reliability"] * r, 4)},
            "sla":         {"raw": round(s, 4), "weighted": round(WEIGHTS["sla"] * s, 4)},
        }
        scored.append(entry)

    scored.sort(key=lambda x: x["_composite_score"], reverse=True)
    return scored


# ── Confidence ─────────────────────────────────────────────────────────────────

def _decision_confidence(scored: list[dict], budget: dict | None) -> tuple[float, str]:
    if not scored:
        return 0.0, "no scored vendors"

    confidence = 0.0
    reasons    = []
    winner     = scored[0]

    if len(scored) >= 2:
        gap        = winner["_composite_score"] - scored[1]["_composite_score"]
        gap_credit = min(gap * 3.0, 0.30)
        confidence += gap_credit
        reasons.append(f"+{gap_credit:.2f} score gap vs runner-up ({gap:.3f})")
    else:
        confidence += 0.10
        reasons.append("+0.10 only one bidder")

    bid_credit  = min(len(scored) / 3.0 * 0.20, 0.20)
    confidence += bid_credit
    reasons.append(f"+{bid_credit:.2f} for {len(scored)} bid(s)")

    mag_credit  = round(winner["_composite_score"] * 0.20, 4)
    confidence += mag_credit
    reasons.append(f"+{mag_credit:.2f} winner composite {winner['_composite_score']:.3f}")

    if budget and winner.get("quote_amount") is not None:
        within = winner["quote_amount"] <= budget.get("approved", float("inf"))
        credit = 0.20 if within else 0.0
        confidence += credit
        reasons.append(f"+{credit:.2f} quote {'within' if within else 'exceeds'} budget")

    certs       = winner.get("certifications") or []
    cert_credit = min(len(certs) * 0.05, 0.10)
    confidence += cert_credit
    if cert_credit:
        reasons.append(f"+{cert_credit:.2f} winner holds {len(certs)} certification(s)")

    return round(min(confidence, 1.0), 4), "; ".join(reasons)


# ── Rejection reasoning ────────────────────────────────────────────────────────

def _rejection_reason(vendor: dict, winner: dict) -> str:
    parts = []

    delta = winner["_composite_score"] - vendor["_composite_score"]
    parts.append(
        f"composite {vendor['_composite_score']:.3f} vs "
        f"winner {winner['_composite_score']:.3f} (Δ -{delta:.3f})"
    )

    dims = [
        ("cost",        "_cost_score"),
        ("reliability", "_reliability_score"),
        ("sla",         "_sla_score"),
    ]
    weakest_dim, weakest_delta = None, 0.0
    for label, key in dims:
        d = winner[key] - vendor[key]
        if d > weakest_delta:
            weakest_delta = d
            weakest_dim   = label
    if weakest_dim:
        parts.append(f"largest gap on {weakest_dim} (Δ -{weakest_delta:.3f})")

    if vendor.get("quote_amount") and winner.get("quote_amount"):
        diff = vendor["quote_amount"] - winner["quote_amount"]
        if diff > 0:
            parts.append(f"quote ${diff:,.2f} higher than winner")

    return "; ".join(parts)


# ── Agent entrypoint ───────────────────────────────────────────────────────────

AGENT     = "decision-agent"
STEP      = "evaluation"
NEXT_STEP = "negotiation"


def run_decision_agent(state: dict[str, Any]) -> dict[str, Any]:
    vendors = state.get("vendors") or []

    if not vendors:
        state["logs"].append(_log(
            AGENT, STEP, "guard_fail_no_vendors",
            "No vendors in state. Context agent must run first.",
            0.0, f"[{AGENT}] Aborted — no vendors",
        ))
        state["status"]     = "failed"
        state["updated_at"] = _utcnow()
        raise ValueError("Decision agent requires vendors in state.")

    # Inject synthetic quotes if missing
    unquoted = [v["name"] for v in vendors if v.get("quote_amount") is None]
    if unquoted:
        import random
        rng = random.Random(42)
        for v in vendors:
            if v.get("quote_amount") is None:
                v["quote_amount"] = round(rng.uniform(35_000, 70_000), 2)
        state["logs"].append(_log(
            AGENT, STEP, "synthetic_quotes_injected",
            f"Vendors {unquoted} had no quote_amount. Synthetic quotes injected (seed=42).",
            0.40, f"[{AGENT}] Warning — synthetic quotes used",
        ))

    # Score
    scored       = _score_vendors(vendors)
    score_summary = ", ".join(
        f"{v['name']}={v['_composite_score']:.3f}" for v in scored
    )
    state["logs"].append(_log(
        AGENT, STEP, "score_vendors",
        f"Scored {len(scored)} vendor(s) — cost×{WEIGHTS['cost']}, "
        f"reliability×{WEIGHTS['reliability']}, SLA×{WEIGHTS['sla']}. "
        f"Results: {score_summary}.",
        0.95, f"[{AGENT}] Scoring complete",
    ))

    # Select winner
    winner     = scored[0]
    confidence, conf_reasoning = _decision_confidence(scored, state.get("budget"))
    winner["status"] = "shortlisted"

    state["logs"].append(_log(
        AGENT, STEP, "select_vendor",
        f"Selected '{winner['name']}' (composite {winner['_composite_score']:.3f}). "
        f"Cost: {winner['_cost_score']:.3f}, "
        f"Reliability: {winner['_reliability_score']:.3f}, "
        f"SLA: {winner['_sla_score']:.3f}. "
        f"Confidence: {confidence:.2f} — {conf_reasoning}.",
        confidence,
        f"[{AGENT}] Selected: {winner['name']}",
    ))

    # Log rejections
    for runner in scored[1:]:
        runner["status"] = "rejected"
        reason = _rejection_reason(runner, winner)
        state["logs"].append(_log(
            AGENT, STEP, "reject_vendor",
            f"Rejected '{runner['name']}': {reason}.",
            confidence,
            f"[{AGENT}] Rejected: {runner['name']}",
        ))

    # Commit
    state["vendors"]          = scored
    state["selected_vendor"]  = winner
    state["current_step"]     = NEXT_STEP
    state["status"]           = "executing"
    state["confidence_score"] = confidence
    state["updated_at"]       = _utcnow()

    return state