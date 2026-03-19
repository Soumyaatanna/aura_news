from datetime import datetime, timezone
from typing import Any


MAX_RETRIES = 3

_ERROR_PATTERNS: list[tuple[str, str]] = [
    ("timeout",          "vendor_timeout"),
    ("timed out",        "vendor_timeout"),
    ("unreachable",      "vendor_timeout"),
    ("connection",       "vendor_timeout"),
    ("mismatch",         "invoice_mismatch"),
    ("rejected",         "invoice_mismatch"),
    ("blocking failure", "invoice_mismatch"),
    ("exceeds",          "budget_exceeded"),
    ("over budget",      "budget_exceeded"),
    ("no vendor",        "no_vendor"),
    ("no selected",      "no_vendor"),
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


# ── Failure classification ─────────────────────────────────────────────────────

def _classify(failure: dict) -> str:
    text = failure.get("error", "").lower()
    for pattern, kind in _ERROR_PATTERNS:
        if pattern in text:
            return kind
    return "unknown"


def _group_failures(failures: list[dict]) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = {}
    for f in failures:
        grouped.setdefault(_classify(f), []).append(f)
    return grouped


# ── Vendor selection ───────────────────────────────────────────────────────────

def _composite_score(vendor: dict) -> float:
    if "_composite_score" in vendor:
        return float(vendor["_composite_score"])
    quote   = float(vendor.get("quote_amount") or 0)
    cost_s  = max(0.0, 1.0 - quote / 100_000.0)
    rating  = float(vendor.get("rating", 0))
    contr   = int(vendor.get("past_contracts", 0))
    rel_s   = 0.7 * (rating / 5.0) + 0.3 * min(contr / 20.0, 1.0)
    days    = float(vendor.get("avg_delivery_days", 14))
    sla_s   = max(0.0, 1.0 - (days - 3) / 14.0)
    return round(0.40 * cost_s + 0.30 * rel_s + 0.30 * sla_s, 6)


def _best_fallback(
    vendors:     list[dict],
    excluded:    set[str],
    budget:      dict | None,
) -> dict | None:
    approved   = (budget or {}).get("approved", float("inf"))
    candidates = [
        v for v in vendors
        if v["vendor_id"] not in excluded
        and v.get("status") != "rejected"
        and (v.get("quote_amount") or 0) <= approved
    ]
    if not candidates:
        return None
    candidates.sort(key=_composite_score, reverse=True)
    return candidates[0]


def _note(vendor: dict, reason: str) -> str:
    return (
        f"Vendor '{vendor['name']}' "
        f"(id={vendor['vendor_id']}, score={_composite_score(vendor):.3f}) "
        f"excluded: {reason}."
    )


# ── Recovery strategies ────────────────────────────────────────────────────────

def _recover_vendor_timeout(
    state:    dict,
    failures: list[dict],
) -> tuple[bool, str]:
    current    = state.get("selected_vendor") or {}
    current_id = current.get("vendor_id", "")
    budget     = state.get("budget")

    excluded = {current_id} | {
        f.get("vendor_id", "")
        for f in failures
        if _classify(f) == "vendor_timeout"
    }

    for v in state.get("vendors", []):
        if v["vendor_id"] == current_id:
            v["status"] = "rejected"
            break

    fallback = _best_fallback(state.get("vendors", []), excluded, budget)
    if not fallback:
        return False, (
            f"No eligible fallback after excluding timed-out vendor "
            f"'{current.get('name', current_id)}'. Manual intervention required."
        )

    fallback["status"]        = "shortlisted"
    state["selected_vendor"]  = fallback
    return True, (
        f"Timeout on '{current.get('name', current_id)}'. "
        f"{_note(current, 'timeout/unreachable')} "
        f"Promoted '{fallback['name']}' "
        f"(score={_composite_score(fallback):.3f}, "
        f"quote={fallback.get('quote_currency','USD')} "
        f"{fallback.get('quote_amount',0):,.2f})."
    )


def _recover_invoice_mismatch(
    state:    dict,
    failures: list[dict],
) -> tuple[bool, str]:
    current    = state.get("selected_vendor") or {}
    current_id = current.get("vendor_id", "")

    mismatch_count = sum(
        1 for f in failures
        if _classify(f) == "invoice_mismatch"
        and f.get("vendor_id", current_id) == current_id
    )

    verification   = state.get("verification") or {}
    blocking       = [
        c["check"] for c in verification.get("mismatches", [])
        if c.get("severity") == "blocking"
    ]
    retryable_only = all(
        chk in ("amount_within_tolerance", "payment_terms_match")
        for chk in blocking
    )

    # First offence on retryable fields — clear invoice and retry same vendor
    if mismatch_count <= 1 and retryable_only:
        state["invoice"]      = None
        state["verification"] = None
        return True, (
            f"Retryable mismatch on {blocking}. "
            "Invoice cleared — will re-request from same vendor."
        )

    # Repeated / non-retryable — swap vendor
    budget   = state.get("budget")
    excluded = {current_id}
    for v in state.get("vendors", []):
        if v["vendor_id"] == current_id:
            v["status"] = "rejected"
            break

    fallback = _best_fallback(state.get("vendors", []), excluded, budget)
    if not fallback:
        return False, (
            f"Non-retryable mismatch {blocking} for "
            f"'{current.get('name', current_id)}' "
            "and no fallback available."
        )

    fallback["status"]        = "shortlisted"
    state["selected_vendor"]  = fallback
    state["invoice"]          = None
    state["verification"]     = None
    state["purchase_order"]   = None
    state["contract_ref"]     = None
    return True, (
        f"Repeated/non-retryable mismatch {blocking} "
        f"for '{current.get('name', current_id)}' "
        f"(count={mismatch_count}). "
        f"{_note(current, 'invoice integrity failure')} "
        f"Swapped to '{fallback['name']}'. PO and invoice cleared."
    )


def _recover_budget_exceeded(
    state:    dict,
    failures: list[dict],
) -> tuple[bool, str]:
    current    = state.get("selected_vendor") or {}
    current_id = current.get("vendor_id", "")
    budget     = state.get("budget") or {}
    approved   = budget.get("approved", 0)

    for v in state.get("vendors", []):
        if v["vendor_id"] == current_id:
            v["status"] = "rejected"
            break

    fallback = _best_fallback(state.get("vendors", []), {current_id}, budget)
    if not fallback:
        state["status"] = "failed"
        return False, (
            f"All vendors exceed approved budget of "
            f"{budget.get('currency','USD')} {approved:,.2f}. "
            "Finance approval required."
        )

    fallback["status"]        = "shortlisted"
    state["selected_vendor"]  = fallback
    return True, (
        f"Quote exceeded budget ({approved:,.2f}). "
        f"{_note(current, 'over budget')} "
        f"Promoted '{fallback['name']}' "
        f"(quote={fallback.get('quote_amount',0):,.2f})."
    )


def _recover_no_vendor(
    state:    dict,
    failures: list[dict],
) -> tuple[bool, str]:
    fallback = _best_fallback(
        state.get("vendors", []), set(), state.get("budget")
    )
    if not fallback:
        return False, "No vendors in state at all. Context + Decision agents must re-run."

    fallback["status"]        = "shortlisted"
    state["selected_vendor"]  = fallback
    return True, (
        f"selected_vendor was absent. "
        f"Promoted best available vendor '{fallback['name']}' "
        f"(score={_composite_score(fallback):.3f}) as emergency selection."
    )


_STRATEGIES = {
    "vendor_timeout":   _recover_vendor_timeout,
    "invoice_mismatch": _recover_invoice_mismatch,
    "budget_exceeded":  _recover_budget_exceeded,
    "no_vendor":        _recover_no_vendor,
}

_PRIORITY = [
    "vendor_timeout",
    "invoice_mismatch",
    "budget_exceeded",
    "no_vendor",
    "unknown",
]


# ── Confidence ─────────────────────────────────────────────────────────────────

def _healing_confidence(
    recovered:    bool,
    failure_kind: str,
    retry_count:  int,
    fallback:     dict | None,
) -> tuple[float, str]:
    score   = 0.70 if recovered else 0.10
    reasons = [f"base {'0.70' if recovered else '0.10'}"]

    penalty = min(retry_count * 0.10, 0.30)
    if penalty:
        score -= penalty
        reasons.append(f"-{penalty:.2f} for {retry_count} prior retry(s)")

    if fallback and len(fallback.get("certifications") or []) >= 2:
        score += 0.10
        reasons.append("+0.10 fallback holds ≥2 certifications")

    if failure_kind == "unknown":
        score -= 0.15
        reasons.append("-0.15 failure kind unknown")

    return round(max(0.0, min(1.0, score)), 4), "; ".join(reasons)


# ── Agent entrypoint ───────────────────────────────────────────────────────────

AGENT = "healing-agent"
STEP  = "recovery"


def run_healing_agent(state: dict[str, Any]) -> dict[str, Any]:
    failures   = state.get("failures") or []
    unresolved = [f for f in failures if not f.get("resolved")]

    # Guard: nothing to heal
    if not unresolved:
        state["logs"].append(_log(
            AGENT, STEP, "guard_no_failures",
            "No unresolved failures found. State is healthy.",
            1.0, f"[{AGENT}] Nothing to heal",
        ))
        state["updated_at"] = _utcnow()
        return state

    # Classify and prioritise
    grouped      = _group_failures(unresolved)
    primary_kind = next((k for k in _PRIORITY if k in grouped), "unknown")
    primary      = grouped[primary_kind]

    max_hit       = any(f.get("retry_count", 1) >= MAX_RETRIES for f in primary)
    current_retry = max(f.get("retry_count", 1) for f in primary)

    state["logs"].append(_log(
        AGENT, STEP, "detect_failure",
        f"Detected {len(unresolved)} unresolved failure(s). "
        f"Primary kind: '{primary_kind}' "
        f"({len(primary)} occurrence(s), retry={current_retry}). "
        + ("MAX_RETRIES reached — escalating."
           if max_hit else
           f"{MAX_RETRIES - current_retry} retry(s) remaining."),
        0.95,
        f"[{AGENT}] Failure detected: {primary_kind} "
        f"(retry {current_retry}/{MAX_RETRIES})",
    ))

    # Guard: max retries hit
    if max_hit:
        state["logs"].append(_log(
            AGENT, STEP, "escalate_max_retries",
            f"Kind '{primary_kind}' reached max retry limit ({MAX_RETRIES}). "
            "Escalating to human operator.",
            0.0,
            f"[{AGENT}] Escalated — max retries exceeded",
        ))
        state["status"]           = "failed"
        state["confidence_score"] = 0.0
        state["updated_at"]       = _utcnow()
        return state

    # Apply strategy
    strategy = _STRATEGIES.get(primary_kind)
    if strategy is None:
        recovered, reasoning = False, f"No strategy for kind '{primary_kind}'."
    else:
        recovered, reasoning = strategy(state, primary)

    fallback   = state.get("selected_vendor") if recovered else None
    confidence, conf_reasoning = _healing_confidence(
        recovered, primary_kind, current_retry, fallback
    )

    state["logs"].append(_log(
        AGENT, STEP, "apply_recovery_strategy",
        f"Strategy for '{primary_kind}': {reasoning} "
        f"Confidence: {confidence:.2f} — {conf_reasoning}.",
        confidence,
        f"[{AGENT}] Recovery "
        f"{'SUCCEEDED' if recovered else 'FAILED'} "
        f"(confidence {confidence:.2f})",
    ))

    # Update failure records
    for f in primary:
        f["retry_count"] = f.get("retry_count", 1) + 1
        f["resolved"]    = recovered
        if recovered:
            f["resolved_at"] = _utcnow()
            f["resolved_by"] = AGENT

    # Log fallback promotion
    if recovered and fallback:
        state["logs"].append(_log(
            AGENT, STEP, "promote_fallback_vendor",
            f"Fallback '{fallback['name']}' promoted to selected_vendor "
            f"(score={_composite_score(fallback):.3f}, "
            f"quote={fallback.get('quote_currency','USD')} "
            f"{fallback.get('quote_amount',0):,.2f}, "
            f"delivery={fallback.get('avg_delivery_days','?')} days).",
            confidence,
            f"[{AGENT}] Promoted: {fallback['name']}",
        ))

    # Commit
    state["status"]           = "recovered" if recovered else "failed"
    state["confidence_score"] = confidence
    state["updated_at"]       = _utcnow()

    return state