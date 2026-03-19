from datetime import datetime, timezone
from typing import Any


MOCK_VENDORS: list[dict] = [
    {
        "vendor_id":        "v-acme-001",
        "name":             "Acme Supplies Ltd",
        "category":         "industrial_components",
        "country":          "US",
        "rating":           4.7,
        "past_contracts":   12,
        "avg_delivery_days": 5,
        "certifications":   ["ISO-9001", "ISO-14001"],
        "status":           "invited",
        "score":            None,
        "quote_amount":     48_200.00,
        "quote_currency":   "USD",
        "submitted_at":     None,
    },
    {
        "vendor_id":        "v-globex-002",
        "name":             "Globex Industrial",
        "category":         "industrial_components",
        "country":          "DE",
        "rating":           4.2,
        "past_contracts":   5,
        "avg_delivery_days": 9,
        "certifications":   ["ISO-9001"],
        "status":           "invited",
        "score":            None,
        "quote_amount":     52_750.00,
        "quote_currency":   "USD",
        "submitted_at":     None,
    },
    {
        "vendor_id":        "v-initech-003",
        "name":             "Initech Components",
        "category":         "industrial_components",
        "country":          "SG",
        "rating":           3.8,
        "past_contracts":   2,
        "avg_delivery_days": 14,
        "certifications":   [],
        "status":           "invited",
        "score":            None,
        "quote_amount":     61_000.00,
        "quote_currency":   "USD",
        "submitted_at":     None,
    },
]


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


def _compute_confidence(vendors: list[dict]) -> tuple[float, str]:
    score   = 0.5
    reasons = ["baseline 0.5"]

    certified = sum(1 for v in vendors if v.get("certifications"))
    cert_bonus = min(certified, 2) * 0.1
    if cert_bonus:
        score += cert_bonus
        reasons.append(f"+{cert_bonus:.1f} for {certified} certified vendor(s)")

    if any(v.get("past_contracts", 0) >= 10 for v in vendors):
        score += 0.1
        reasons.append("+0.1 vendor with 10+ past contracts")

    if len({v.get("category") for v in vendors}) == 1:
        score += 0.1
        reasons.append("+0.1 coherent single-category pool")

    if any(v.get("avg_delivery_days", 0) > 10 for v in vendors):
        score -= 0.1
        reasons.append("-0.1 vendor with avg delivery > 10 days")

    return round(max(0.0, min(1.0, score)), 4), "; ".join(reasons)


def run_context_agent(state: dict[str, Any]) -> dict[str, Any]:
    agent   = "context-agent"
    step    = "vendor_discovery"
    vendors = [dict(v) for v in MOCK_VENDORS]

    state["logs"].append(_log(
        agent, step, "fetch_vendor_data",
        f"Queried vendor registry for category "
        f"'{state.get('metadata', {}).get('category', 'general')}'. "
        f"{len(vendors)} vendors returned.",
        1.0,
        f"[{agent}] Fetched {len(vendors)} vendors",
    ))

    confidence, reasoning = _compute_confidence(vendors)

    state["logs"].append(_log(
        agent, step, "score_vendor_pool",
        reasoning,
        confidence,
        f"[{agent}] Pool confidence: {confidence:.2f}",
    ))

    state["vendors"]          = vendors
    state["selected_vendor"]  = None
    state["current_step"]     = step
    state["status"]           = "executing"
    state["confidence_score"] = confidence
    state["updated_at"]       = _utcnow()

    state["logs"].append(_log(
        agent, step, "attach_vendors_to_state",
        f"Attached {len(vendors)} vendor(s). "
        f"Confidence: {confidence:.2f}. "
        f"Advancing to '{step}'.",
        confidence,
        f"[{agent}] Vendors attached to state",
    ))

    return state