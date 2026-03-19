import uuid
from datetime import datetime, timezone
from typing import Any


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


# ── PO builder ─────────────────────────────────────────────────────────────────

def _generate_po_number() -> str:
    date_part   = datetime.now(timezone.utc).strftime("%Y%m%d")
    unique_part = uuid.uuid4().hex[:8].upper()
    return f"PO-{date_part}-{unique_part}"


def _build_po(vendor: dict, budget: dict | None, metadata: dict) -> dict[str, Any]:
    quote_amount = vendor.get("quote_amount", 0.0)
    currency     = vendor.get("quote_currency", "USD")
    approved     = (budget or {}).get("approved", quote_amount)

    return {
        "po_number":        _generate_po_number(),
        "status":           "issued",
        "issued_at":        _utcnow(),
        "vendor_id":        vendor["vendor_id"],
        "vendor_name":      vendor["name"],
        "vendor_country":   vendor.get("country", "—"),
        "line_items": [
            {
                "line":        1,
                "description": f"Supply of {metadata.get('category', 'goods')}",
                "quantity":    1,
                "unit_price":  quote_amount,
                "currency":    currency,
                "total":       quote_amount,
            }
        ],
        "subtotal":         quote_amount,
        "tax_rate":         0.0,
        "tax_amount":       0.0,
        "total_amount":     quote_amount,
        "currency":         currency,
        "budget_approved":  approved,
        "budget_remaining": approved - quote_amount,
        "within_budget":    quote_amount <= approved,
        "payment_terms":    "NET-30",
        "expected_delivery": f"{vendor.get('avg_delivery_days', 14)} business days",
        "department":       metadata.get("department", "—"),
        "cost_centre":      metadata.get("cost_centre", "—"),
        "requester_id":     metadata.get("requester_id", "—"),
        "certifications":   vendor.get("certifications", []),
        "notes":            "Simulated PO — replace with ERP integration in production.",
    }


# ── Confidence ─────────────────────────────────────────────────────────────────

def _execution_confidence(po: dict, vendor: dict) -> tuple[float, str]:
    score   = 0.0
    reasons = []

    if po.get("po_number") and po.get("issued_at"):
        score += 0.40
        reasons.append("+0.40 PO structurally valid")

    if po.get("within_budget"):
        score += 0.25
        reasons.append("+0.25 quote within approved budget")

    if vendor.get("certifications"):
        score += 0.15
        reasons.append(f"+0.15 vendor holds {len(vendor['certifications'])} certification(s)")

    if vendor.get("past_contracts", 0) >= 5:
        score += 0.10
        reasons.append(f"+0.10 vendor has {vendor['past_contracts']} past contracts")

    if vendor.get("avg_delivery_days", 99) <= 10:
        score += 0.10
        reasons.append(f"+0.10 delivery in {vendor['avg_delivery_days']} business days")

    return round(min(score, 1.0), 4), "; ".join(reasons)


# ── Agent entrypoint ───────────────────────────────────────────────────────────

AGENT     = "execution-agent"
STEP      = "order_placed"
NEXT_STEP = "delivery_confirmed"


def run_execution_agent(state: dict[str, Any]) -> dict[str, Any]:
    vendor = state.get("selected_vendor")

    # Guard: vendor must exist
    if not vendor:
        state["logs"].append(_log(
            AGENT, STEP, "guard_fail_no_vendor",
            "No selected_vendor in state. Decision agent must run first.",
            0.0, f"[{AGENT}] Aborted — selected_vendor missing",
        ))
        state["status"]     = "failed"
        state["updated_at"] = _utcnow()
        raise ValueError("Execution agent requires a selected_vendor in state.")

    # Guard: quote must be present
    if vendor.get("quote_amount") is None:
        state["logs"].append(_log(
            AGENT, STEP, "guard_fail_no_quote",
            f"Vendor '{vendor['name']}' has no quote_amount. Cannot create PO.",
            0.0, f"[{AGENT}] Aborted — quote_amount missing",
        ))
        state["status"]     = "failed"
        state["updated_at"] = _utcnow()
        raise ValueError(f"Vendor '{vendor['name']}' has no quote_amount.")

    budget   = state.get("budget")
    metadata = state.get("metadata", {})
    approved = (budget or {}).get("approved", float("inf"))
    quote    = vendor["quote_amount"]

    # Pre-flight budget check
    within = quote <= approved
    state["logs"].append(_log(
        AGENT, STEP, "preflight_budget_check",
        f"Quote {vendor.get('quote_currency','USD')} {quote:,.2f} "
        f"{'within' if within else 'EXCEEDS'} approved budget of {approved:,.2f}.",
        0.95 if within else 0.40,
        f"[{AGENT}] Budget check: {'PASS' if within else 'WARN — over budget'}",
    ))

    # Build PO
    po = _build_po(vendor, budget, metadata)
    state["logs"].append(_log(
        AGENT, STEP, "create_purchase_order",
        f"PO {po['po_number']} issued to '{vendor['name']}' "
        f"({vendor.get('country','—')}) for "
        f"{po['currency']} {po['total_amount']:,.2f}. "
        f"Payment terms: {po['payment_terms']}. "
        f"Expected delivery: {po['expected_delivery']}.",
        0.95,
        f"[{AGENT}] PO created: {po['po_number']}",
    ))

    # Confidence
    confidence, conf_reasoning = _execution_confidence(po, vendor)
    state["logs"].append(_log(
        AGENT, STEP, "assess_execution_confidence",
        conf_reasoning,
        confidence,
        f"[{AGENT}] Execution confidence: {confidence:.2f}",
    ))

    # Deduct from budget
    if budget:
        budget["remaining"] = round(
            budget.get("remaining", approved) - quote, 2
        )
        state["logs"].append(_log(
            AGENT, STEP, "update_budget_remaining",
            f"Deducted {po['currency']} {quote:,.2f}. "
            f"Remaining: {po['currency']} {budget['remaining']:,.2f} "
            f"of {po['currency']} {approved:,.2f}.",
            confidence,
            f"[{AGENT}] Budget remaining: {budget['remaining']:,.2f}",
        ))
        state["budget"] = budget

    # Commit
    state["purchase_order"]   = po
    state["contract_ref"]     = po["po_number"]
    state["current_step"]     = NEXT_STEP
    state["status"]           = "executing"
    state["confidence_score"] = confidence
    state["updated_at"]       = _utcnow()

    return state