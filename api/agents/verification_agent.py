import uuid
from datetime import datetime, timezone
from typing import Any


AMOUNT_TOLERANCE = 0.01   # 1 % tolerance on invoice totals


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


# ── Invoice simulation ─────────────────────────────────────────────────────────

def _generate_invoice_number() -> str:
    date_part   = datetime.now(timezone.utc).strftime("%Y%m%d")
    unique_part = uuid.uuid4().hex[:8].upper()
    return f"INV-{date_part}-{unique_part}"


def _simulate_invoice(po: dict, scenario: str = "clean") -> dict[str, Any]:
    """
    Build a mock invoice against the given PO.

    scenario options:
      "clean"            — matches PO exactly
      "amount_mismatch"  — invoice total inflated by 12%
      "vendor_mismatch"  — different vendor on invoice
      "currency_mismatch"— invoice currency differs
      "duplicate"        — invoice number same as PO number
      "missing_po_ref"   — invoice carries no PO reference
    """
    base   = po["total_amount"]
    cur    = po["currency"]
    over   = {}

    if scenario == "amount_mismatch":
        over["total_amount"] = round(base * 1.12, 2)
        over["line_items"]   = [{
            **po["line_items"][0],
            "unit_price": over["total_amount"],
            "total":      over["total_amount"],
        }]
    elif scenario == "vendor_mismatch":
        over["vendor_id"]   = "v-unknown-999"
        over["vendor_name"] = "Shadow Supplies Co."
    elif scenario == "currency_mismatch":
        over["currency"] = "EUR"
    elif scenario == "duplicate":
        over["invoice_number"] = po["po_number"]
    elif scenario == "missing_po_ref":
        over["po_reference"] = None

    return {
        "invoice_number": over.get("invoice_number", _generate_invoice_number()),
        "issued_at":      _utcnow(),
        "vendor_id":      over.get("vendor_id",   po["vendor_id"]),
        "vendor_name":    over.get("vendor_name", po["vendor_name"]),
        "po_reference":   over.get("po_reference", po["po_number"]),
        "line_items":     over.get("line_items", [{
            "line":        1,
            "description": po["line_items"][0]["description"],
            "quantity":    1,
            "unit_price":  base,
            "currency":    over.get("currency", cur),
            "total":       base,
        }]),
        "subtotal":      over.get("total_amount", base),
        "tax_amount":    0.0,
        "total_amount":  over.get("total_amount", base),
        "currency":      over.get("currency", cur),
        "payment_terms": po.get("payment_terms", "NET-30"),
        "scenario":      scenario,
    }


# ── Validation checks ──────────────────────────────────────────────────────────

class _Check:
    __slots__ = ("name", "passed", "expected", "actual", "severity", "detail")

    def __init__(self, name, passed, expected, actual, severity, detail=""):
        self.name     = name
        self.passed   = passed
        self.expected = expected
        self.actual   = actual
        self.severity = severity
        self.detail   = detail

    def to_dict(self) -> dict:
        return {
            "check":    self.name,
            "passed":   self.passed,
            "severity": self.severity,
            "expected": self.expected,
            "actual":   self.actual,
            "detail":   self.detail,
        }


def _run_checks(po: dict, invoice: dict) -> list[_Check]:
    checks = []

    # 1. PO reference present
    checks.append(_Check(
        "po_reference_present",
        bool(invoice.get("po_reference")),
        po["po_number"], invoice.get("po_reference"),
        "blocking",
        "Invoice must carry the originating PO number.",
    ))

    # 2. PO reference matches
    checks.append(_Check(
        "po_reference_matches",
        invoice.get("po_reference") == po["po_number"],
        po["po_number"], invoice.get("po_reference"),
        "blocking",
        "Invoice PO reference must exactly match issued PO.",
    ))

    # 3. Vendor ID matches
    checks.append(_Check(
        "vendor_id_matches",
        invoice["vendor_id"] == po["vendor_id"],
        po["vendor_id"], invoice["vendor_id"],
        "blocking",
        "Invoice vendor must match the PO vendor.",
    ))

    # 4. Vendor name matches (warning only — trading name variations)
    checks.append(_Check(
        "vendor_name_matches",
        invoice["vendor_name"].strip().lower() == po["vendor_name"].strip().lower(),
        po["vendor_name"], invoice["vendor_name"],
        "warning",
        "Vendor name discrepancy may indicate a trading-name variation.",
    ))

    # 5. Currency matches
    checks.append(_Check(
        "currency_matches",
        invoice["currency"] == po["currency"],
        po["currency"], invoice["currency"],
        "blocking",
        "Currency mismatch creates unhedged FX exposure.",
    ))

    # 6. Amount within tolerance
    po_total  = po["total_amount"]
    inv_total = invoice["total_amount"]
    delta_pct = abs(inv_total - po_total) / po_total if po_total else 1.0
    checks.append(_Check(
        "amount_within_tolerance",
        delta_pct <= AMOUNT_TOLERANCE,
        f"{po_total:,.2f} ±{AMOUNT_TOLERANCE*100:.0f}%",
        f"{inv_total:,.2f} (Δ {delta_pct*100:.2f}%)",
        "blocking",
        f"Invoice deviates {delta_pct*100:.2f}% from PO total.",
    ))

    # 7. Line-item count
    checks.append(_Check(
        "line_item_count_matches",
        len(invoice["line_items"]) == len(po["line_items"]),
        len(po["line_items"]), len(invoice["line_items"]),
        "warning",
        "Unexpected line items may indicate unauthorised additions.",
    ))

    # 8. Payment terms
    checks.append(_Check(
        "payment_terms_match",
        invoice.get("payment_terms") == po.get("payment_terms"),
        po.get("payment_terms"), invoice.get("payment_terms"),
        "warning",
        "Payment term deviation requires finance sign-off.",
    ))

    # 9. Invoice number not duplicate of PO number
    checks.append(_Check(
        "invoice_number_not_duplicate_of_po",
        invoice["invoice_number"] != po["po_number"],
        f"not {po['po_number']}", invoice["invoice_number"],
        "blocking",
        "Invoice number must be unique and distinct from PO number.",
    ))

    return checks


# ── Confidence ─────────────────────────────────────────────────────────────────

def _verification_confidence(
    checks:     list[_Check],
    mismatches: list[_Check],
) -> tuple[float, str]:
    score   = 1.0
    reasons = []

    blocking = [c for c in mismatches if c.severity == "blocking"]
    warnings = [c for c in mismatches if c.severity == "warning"]

    b_deduction = min(len(blocking) * 0.25, 0.75)
    w_deduction = min(len(warnings) * 0.08, 0.16)

    if b_deduction:
        score -= b_deduction
        reasons.append(f"-{b_deduction:.2f} for {len(blocking)} blocking failure(s)")
    if w_deduction:
        score -= w_deduction
        reasons.append(f"-{w_deduction:.2f} for {len(warnings)} warning(s)")

    passed = sum(1 for c in checks if c.passed)
    reasons.append(f"{passed}/{len(checks)} checks passed")

    return round(max(0.0, score), 4), "; ".join(reasons)


# ── Agent entrypoint ───────────────────────────────────────────────────────────

AGENT     = "verification-agent"
STEP      = "invoice_approved"
NEXT_STEP = "payment_released"


def run_verification_agent(
    state:            dict[str, Any],
    invoice_scenario: str = "clean",
) -> dict[str, Any]:
    po = state.get("purchase_order")

    # Guard: PO must exist
    if not po:
        state["logs"].append(_log(
            AGENT, STEP, "guard_fail_no_po",
            "No purchase_order in state. Execution agent must run first.",
            0.0, f"[{AGENT}] Aborted — purchase_order missing",
        ))
        state["status"]     = "failed"
        state["updated_at"] = _utcnow()
        raise ValueError("Verification agent requires a purchase_order in state.")

    # Simulate invoice receipt
    invoice = _simulate_invoice(po, scenario=invoice_scenario)
    state["logs"].append(_log(
        AGENT, STEP, "receive_invoice",
        f"Invoice {invoice['invoice_number']} received from "
        f"'{invoice['vendor_name']}' for "
        f"{invoice['currency']} {invoice['total_amount']:,.2f}. "
        f"References PO: {invoice['po_reference'] or '(none)'}. "
        f"Scenario: '{invoice_scenario}'.",
        1.0,
        f"[{AGENT}] Invoice received: {invoice['invoice_number']}",
    ))

    # Run all checks
    checks     = _run_checks(po, invoice)
    mismatches = [c for c in checks if not c.passed]
    blocking   = [c for c in mismatches if c.severity == "blocking"]
    warnings   = [c for c in mismatches if c.severity == "warning"]

    check_summary = (
        f"{sum(1 for c in checks if c.passed)}/{len(checks)} passed, "
        f"{len(blocking)} blocking, {len(warnings)} warnings"
    )
    state["logs"].append(_log(
        AGENT, STEP, "run_validation_checks",
        f"Ran {len(checks)} validation rules. {check_summary}.",
        0.95,
        f"[{AGENT}] Validation complete — {check_summary}",
    ))

    # Log each mismatch individually
    for m in mismatches:
        state["logs"].append(_log(
            AGENT, STEP, f"mismatch_detected_{m.name}",
            f"{m.severity.upper()} — {m.name}: "
            f"expected '{m.expected}', got '{m.actual}'. {m.detail}",
            0.0 if m.severity == "blocking" else 0.50,
            f"[{AGENT}] {'BLOCK' if m.severity == 'blocking' else 'WARN'} "
            f"{m.name}",
        ))

    # Verdict
    confidence, conf_reasoning = _verification_confidence(checks, mismatches)
    approved = len(blocking) == 0

    state["logs"].append(_log(
        AGENT, STEP,
        "approve_invoice" if approved else "reject_invoice",
        f"Invoice {'APPROVED' if approved else 'REJECTED'}. "
        f"{check_summary}. "
        f"Confidence: {confidence:.2f} — {conf_reasoning}."
        + (f" Blocking: {[c.name for c in blocking]}." if blocking else ""),
        confidence,
        f"[{AGENT}] Invoice {invoice['invoice_number']} "
        f"{'APPROVED' if approved else 'REJECTED'} "
        f"(confidence {confidence:.2f})",
    ))

    # Verification report
    report = {
        "verified_at":    _utcnow(),
        "invoice_number": invoice["invoice_number"],
        "po_number":      po["po_number"],
        "approved":       approved,
        "confidence":     confidence,
        "total_checks":   len(checks),
        "passed_checks":  sum(1 for c in checks if c.passed),
        "blocking_count": len(blocking),
        "warning_count":  len(warnings),
        "checks":         [c.to_dict() for c in checks],
        "mismatches":     [c.to_dict() for c in mismatches],
        "scenario":       invoice_scenario,
    }

    # Commit
    state["invoice"]          = invoice
    state["verification"]     = report
    state["confidence_score"] = confidence
    state["updated_at"]       = _utcnow()

    if approved:
        state["current_step"] = NEXT_STEP
        state["status"]       = "executing"
    else:
        state["status"] = "failed"
        state.setdefault("failures", []).append({
            "ts":          _utcnow(),
            "step":        STEP,
            "error":       f"Invoice rejected — {len(blocking)} blocking failure(s): "
                           f"{[c.name for c in blocking]}",
            "kind":        "invoice_mismatch",
            "retry_count": 1,
            "resolved":    False,
            "vendor_id":   (state.get("selected_vendor") or {}).get("vendor_id", ""),
        })

    return state