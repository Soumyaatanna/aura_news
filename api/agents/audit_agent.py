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


# ── Helpers ────────────────────────────────────────────────────────────────────

def _confidence_band(score: float) -> str:
    if score >= 0.90: return "certain"
    if score >= 0.70: return "high"
    if score >= 0.45: return "medium"
    if score >= 0.20: return "low"
    return "critical"


def _infer_outcome(action: str) -> str:
    a = action.lower()
    if any(k in a for k in ("fail", "abort", "reject", "guard_fail", "escalat")):
        return "failure"
    if any(k in a for k in ("warn", "synthetic", "mismatch_detected")):
        return "warning"
    if any(k in a for k in ("skip", "nothing_to")):
        return "skipped"
    return "success"


_VALID_STEPS = {
    "needs_assessment", "budget_approval", "vendor_discovery",
    "rfq_issued", "proposals_received", "evaluation", "negotiation",
    "order_placed", "delivery_confirmed", "invoice_approved",
    "payment_released", "recovery", "closed",
}

_VALID_AGENTS = {
    "system", "context-agent", "decision-agent", "execution-agent",
    "verification-agent", "healing-agent", "audit-agent", "orchestrator",
}


# ── Audit entry builder ────────────────────────────────────────────────────────

def _build_entry(request_id: str, raw: dict) -> dict[str, Any]:
    confidence = round(max(0.0, min(1.0, float(raw.get("confidence", 0.0)))), 4)
    action     = raw.get("action", "unknown")
    agent      = raw.get("actor", "system")
    step       = raw.get("step", "needs_assessment")

    # Normalise agent name
    if agent not in _VALID_AGENTS:
        candidate = f"{agent}-agent" if not agent.endswith("-agent") else agent
        agent     = candidate if candidate in _VALID_AGENTS else "system"

    # Normalise step
    if step not in _VALID_STEPS:
        step = "needs_assessment"

    return {
        "audit_id":        str(uuid.uuid4()),
        "request_id":      request_id,
        "ts":              raw.get("ts", _utcnow()),
        "step":            step,
        "agent":           agent,
        "action":          action,
        "reasoning":       raw.get("reasoning", raw.get("message", "")),
        "confidence":      confidence,
        "confidence_band": _confidence_band(confidence),
        "outcome":         _infer_outcome(action),
        "message":         raw.get("message", f"[{agent}] {action}"),
        "immutable":       True,
        "schema_version":  "1.0.0",
    }


# ── Summary builder ────────────────────────────────────────────────────────────

def _build_summary(state: dict, entries: list[dict]) -> dict[str, Any]:
    selected = state.get("selected_vendor") or {}
    po       = state.get("purchase_order")  or {}

    return {
        "total_entries":    len(entries),
        "agents_involved":  sorted({e["agent"] for e in entries}),
        "steps_completed":  list(dict.fromkeys(e["step"] for e in entries)),
        "failure_count":    sum(1 for e in entries if e["outcome"] == "failure"),
        "recovery_count":   sum(
            1 for e in entries
            if e["agent"] == "healing-agent" and e["outcome"] == "success"
        ),
        "final_confidence": round(float(state.get("confidence_score", 0.0)), 4),
        "selected_vendor":  selected.get("name"),
        "po_number":        po.get("po_number") or state.get("contract_ref"),
        "total_amount":     po.get("total_amount"),
        "currency":         po.get("currency"),
    }


# ── Agent entrypoint ───────────────────────────────────────────────────────────

AGENT     = "audit-agent"
STEP      = "closed"
NEXT_STEP = "closed"


def run_audit_agent(state: dict[str, Any]) -> dict[str, Any]:
    request_id = state.get("request_id", "req-unknown")
    raw_logs   = state.get("logs") or []

    # ── Convert raw logs → structured audit entries ────────────────────────────
    entries           = []
    conversion_errors = []

    for raw in raw_logs:
        try:
            entries.append(_build_entry(request_id, raw))
        except Exception as exc:
            conversion_errors.append(str(exc))

    state["logs"].append(_log(
        AGENT, STEP, "convert_log_entries",
        f"Converted {len(entries)}/{len(raw_logs)} raw log entries. "
        + (f"{len(conversion_errors)} error(s): {conversion_errors}."
           if conversion_errors else "No conversion errors."),
        1.0 if not conversion_errors else 0.75,
        f"[{AGENT}] Converted {len(entries)} entries",
    ))
    entries.append(_build_entry(request_id, state["logs"][-1]))

    # ── Validate entries ───────────────────────────────────────────────────────
    required = {
        "audit_id", "request_id", "ts", "step", "agent",
        "action", "reasoning", "confidence", "outcome", "message",
    }
    invalid = [
        (i, sorted(required - e.keys()))
        for i, e in enumerate(entries)
        if required - e.keys()
    ]

    state["logs"].append(_log(
        AGENT, STEP, "validate_audit_entries",
        f"Validated {len(entries)} entries. "
        + (f"{len(invalid)} invalid: {invalid}." if invalid
           else "All entries valid."),
        1.0 if not invalid else 0.60,
        f"[{AGENT}] Validation: "
        f"{len(entries) - len(invalid)}/{len(entries)} passed",
    ))
    entries.append(_build_entry(request_id, state["logs"][-1]))

    # ── Build summary ──────────────────────────────────────────────────────────
    summary = _build_summary(state, entries)

    state["logs"].append(_log(
        AGENT, STEP, "build_audit_summary",
        f"Summary — entries: {summary['total_entries']}, "
        f"agents: {summary['agents_involved']}, "
        f"steps: {summary['steps_completed']}, "
        f"failures: {summary['failure_count']}, "
        f"recoveries: {summary['recovery_count']}, "
        f"confidence: {summary['final_confidence']:.2f}, "
        f"vendor: {summary['selected_vendor']}, "
        f"PO: {summary['po_number']}, "
        f"amount: {summary.get('currency','USD')} "
        f"{summary.get('total_amount') or 0:,.2f}.",
        float(state.get("confidence_score", 0.0)),
        f"[{AGENT}] Summary built",
    ))
    entries.append(_build_entry(request_id, state["logs"][-1]))

    # ── Assemble final report ──────────────────────────────────────────────────
    report: dict[str, Any] = {
        "report_id":       str(uuid.uuid4()),
        "request_id":      request_id,
        "generated_at":    _utcnow(),
        "workflow_status": state.get("status", "completed"),
        "summary":         summary,
        "entries":         entries,
        "schema_version":  "1.0.0",
    }

    state["logs"].append(_log(
        AGENT, STEP, "finalise_audit_report",
        f"Report {report['report_id']} finalised for {request_id}. "
        f"{len(entries)} immutable entries sealed. "
        "Ready for compliance archive.",
        1.0,
        f"[{AGENT}] Report finalised: {report['report_id']}",
    ))
    entries.append(_build_entry(request_id, state["logs"][-1]))
    report["summary"]["total_entries"] = len(entries)

    # ── Commit ─────────────────────────────────────────────────────────────────
    state["audit_report"]  = report
    state["current_step"]  = NEXT_STEP
    state["status"]        = "completed"
    state["updated_at"]    = _utcnow()

    return state