import uuid
import time
import random
from datetime import datetime, timezone
from typing import Any, Callable

from agents.context_agent      import run_context_agent
from agents.decision_agent     import run_decision_agent
from agents.execution_agent    import run_execution_agent
from agents.verification_agent import run_verification_agent
from agents.healing_agent      import run_healing_agent
from agents.audit_agent        import run_audit_agent


# ── Constants ──────────────────────────────────────────────────────────────────

AGENT       = "orchestrator"
MAX_RETRIES = 3

PIPELINE: list[tuple[str, Callable]] = [
    ("context",      run_context_agent),
    ("decision",     run_decision_agent),
    ("execution",    run_execution_agent),
    ("verification", run_verification_agent),
]


# ── Simulation config ──────────────────────────────────────────────────────────

class SimCfg:
    enabled:               bool       = False
    vendor_timeout:        bool       = False
    vendor_timeout_prob:   float      = 1.0
    invoice_mismatch:      bool       = False
    invoice_mismatch_prob: float      = 1.0
    budget_exceeded:       bool       = False
    budget_exceeded_prob:  float      = 1.0
    seed:                  int | None = None


_DEFAULT_CFG = SimCfg()


# ── Helpers ────────────────────────────────────────────────────────────────────

def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _log(
    step:       str,
    action:     str,
    reasoning:  str,
    confidence: float,
    message:    str | None = None,
) -> dict[str, Any]:
    return {
        "ts":         _utcnow(),
        "step":       step,
        "actor":      AGENT,
        "action":     action,
        "reasoning":  reasoning,
        "confidence": round(max(0.0, min(1.0, confidence)), 4),
        "message":    message or f"[{AGENT}] {action}",
    }


def _append(state: dict, entry: dict) -> None:
    state.setdefault("logs", []).append(entry)
    state["updated_at"] = _utcnow()


def _step_name(agent_name: str) -> str:
    return {
        "context":      "vendor_discovery",
        "decision":     "evaluation",
        "execution":    "order_placed",
        "verification": "invoice_approved",
    }.get(agent_name, agent_name)


def _record_failure(
    state:    dict,
    step:     str,
    error:    str,
    *,
    resolved: bool = False,
    kind:     str  = "unknown",
) -> None:
    record = next(
        (f for f in state.get("failures", [])
         if f["step"] == step and not f["resolved"]),
        None,
    )
    if record:
        record["retry_count"] += 1
        record["resolved"]     = resolved
        if resolved:
            record["resolved_at"] = _utcnow()
            record["resolved_by"] = AGENT
    else:
        state.setdefault("failures", []).append({
            "ts":          _utcnow(),
            "step":        step,
            "error":       error,
            "kind":        kind,
            "retry_count": 1,
            "resolved":    resolved,
            "vendor_id":   (state.get("selected_vendor") or {}).get("vendor_id", ""),
        })


# ── Failure injectors ──────────────────────────────────────────────────────────

class VendorTimeoutError(RuntimeError):
    pass

class InvoiceMismatchError(RuntimeError):
    pass

class BudgetExceededError(RuntimeError):
    pass


def _inject_vendor_timeout(state: dict, rng: random.Random) -> None:
    vendor = state.get("selected_vendor") or {}
    name   = vendor.get("name", "unknown vendor")
    _append(state, _log(
        "order_placed", "sim_inject_vendor_timeout",
        f"[SIMULATION] Injecting vendor timeout for '{name}'.",
        0.0, f"[SIM] Vendor timeout → '{name}'",
    ))
    if state.get("selected_vendor"):
        state["selected_vendor"]["quote_amount"] = None
    raise VendorTimeoutError(
        f"Vendor connection timeout after 30s — '{name}' host unreachable"
    )


def _inject_invoice_mismatch(state: dict, rng: random.Random) -> None:
    po = state.get("purchase_order") or {}
    if not po:
        return
    original = po.get("total_amount", 0)
    inflated = round(original * (1.15 + rng.random() * 0.10), 2)
    _append(state, _log(
        "invoice_approved", "sim_inject_invoice_mismatch",
        f"[SIMULATION] Inflating invoice {original:,.2f} → {inflated:,.2f}.",
        0.0, f"[SIM] Invoice mismatch — {original:,.2f} → {inflated:,.2f}",
    ))
    po["total_amount"] = inflated
    for item in po.get("line_items", []):
        item["unit_price"] = inflated
        item["total"]      = inflated
    po["subtotal"]          = inflated
    state["purchase_order"] = po
    raise InvoiceMismatchError(
        f"Invoice rejected — amount_within_tolerance "
        f"(expected {original:,.2f}, got {inflated:,.2f})"
    )


def _inject_budget_exceeded(state: dict, rng: random.Random) -> None:
    vendor   = state.get("selected_vendor") or {}
    budget   = state.get("budget") or {}
    approved = budget.get("approved", 55_000.0)
    inflated = round(approved * (1.05 + rng.random() * 0.20), 2)
    name     = vendor.get("name", "unknown vendor")
    _append(state, _log(
        "order_placed", "sim_inject_budget_exceeded",
        f"[SIMULATION] Patching '{name}' quote → {inflated:,.2f} "
        f"(approved: {approved:,.2f}).",
        0.0, f"[SIM] Budget exceeded — quote {inflated:,.2f} > {approved:,.2f}",
    ))
    if state.get("selected_vendor"):
        state["selected_vendor"]["quote_amount"] = inflated
    raise BudgetExceededError(
        f"Quote {inflated:,.2f} exceeds approved budget of {approved:,.2f}"
    )


_INJECTORS: dict[str, tuple[str, str, Callable]] = {
    "execution":    ("vendor_timeout",   "vendor_timeout_prob",   _inject_vendor_timeout),
    "verification": ("invoice_mismatch", "invoice_mismatch_prob", _inject_invoice_mismatch),
}
_BUDGET_INJECTOR = ("budget_exceeded", "budget_exceeded_prob", _inject_budget_exceeded)


def _maybe_inject(
    state:      dict,
    agent_name: str,
    attempt:    int,
    cfg:        SimCfg,
    rng:        random.Random,
) -> None:
    if not cfg.enabled or attempt != 1:
        return
    if agent_name == "execution":
        flag, prob_attr, injector = _BUDGET_INJECTOR
        if getattr(cfg, flag) and rng.random() < getattr(cfg, prob_attr):
            injector(state, rng)
            return
    entry = _INJECTORS.get(agent_name)
    if not entry:
        return
    flag, prob_attr, injector = entry
    if getattr(cfg, flag) and rng.random() < getattr(cfg, prob_attr):
        injector(state, rng)


# ── Agent runner ───────────────────────────────────────────────────────────────

def _run_agent(
    fn:         Callable,
    state:      dict,
    name:       str,
    attempt:    int,
    cfg:        SimCfg,
    rng:        random.Random,
) -> tuple[bool, str, float]:
    t0 = time.perf_counter()
    try:
        _maybe_inject(state, name, attempt, cfg, rng)
        fn(state)
        elapsed = (time.perf_counter() - t0) * 1000
        if state.get("status") == "failed":
            return False, f"{name}-agent set status=failed", elapsed
        return True, "", elapsed
    except (VendorTimeoutError, InvoiceMismatchError, BudgetExceededError) as exc:
        return False, str(exc), (time.perf_counter() - t0) * 1000
    except Exception as exc:
        return False, str(exc), (time.perf_counter() - t0) * 1000


# ── Pre / post hooks ───────────────────────────────────────────────────────────

def _pre_agent(state: dict, name: str, attempt: int) -> None:
    _append(state, _log(
        _step_name(name), f"start_{name}_agent",
        f"Starting '{name}' agent (attempt {attempt}/{MAX_RETRIES}). "
        f"Status: {state.get('status')}. "
        f"Confidence: {state.get('confidence_score', 0.0):.2f}.",
        state.get("confidence_score", 0.0),
        f"[{AGENT}] Starting {name}-agent (attempt {attempt})",
    ))


def _post_agent(
    state:      dict,
    name:       str,
    attempt:    int,
    elapsed_ms: float,
    success:    bool,
    error:      str = "",
) -> None:
    _append(state, _log(
        _step_name(name),
        f"{'complete' if success else 'fail'}_{name}_agent",
        f"{name}-agent {'succeeded' if success else 'FAILED'} "
        f"in {elapsed_ms:.1f}ms (attempt {attempt}). "
        + (f"Error: {error}. " if error else "")
        + f"Confidence: {state.get('confidence_score', 0.0):.2f}.",
        state.get("confidence_score", 0.0) if success else 0.0,
        f"[{AGENT}] {name}-agent {'OK' if success else 'FAILED'} ({elapsed_ms:.0f}ms)",
    ))


# ── Error classifier ───────────────────────────────────────────────────────────

def _classify_error(error_msg: str) -> str:
    msg = error_msg.lower()
    if "timeout"  in msg or "unreachable" in msg: return "vendor_timeout"
    if "mismatch" in msg or "rejected"    in msg: return "invoice_mismatch"
    if "exceeds"  in msg or "budget"      in msg: return "budget_exceeded"
    return "unknown"


# ── Healing pass ───────────────────────────────────────────────────────────────

def _attempt_healing(
    state: dict,
    step:  str,
    error: str,
    kind:  str,
) -> bool:
    _record_failure(state, step, error, kind=kind)
    state["status"] = "failed"

    _append(state, _log(
        "recovery", "FAILURE_DETECTED",
        f"FAILURE — step={step}, kind={kind}, error={error[:120]}",
        0.0,
        f"[{AGENT}] FAILURE — step='{step}' kind='{kind}'",
    ))

    _append(state, _log(
        "recovery", "invoke_healing_agent",
        f"Dispatching healing-agent for '{kind}' on step '{step}'.",
        0.0,
        f"[{AGENT}] Invoking healing-agent for '{kind}'",
    ))

    t0 = time.perf_counter()
    try:
        run_healing_agent(state)
    except Exception as exc:
        elapsed = (time.perf_counter() - t0) * 1000
        _append(state, _log(
            "recovery", "HEALING_EXCEPTION",
            f"Healing agent raised after {elapsed:.1f}ms: {exc}.",
            0.0, f"[{AGENT}] Healing exception: {exc}",
        ))
        return False

    elapsed   = (time.perf_counter() - t0) * 1000
    recovered = state.get("status") == "recovered"
    new_vendor = (state.get("selected_vendor") or {}).get("name", "(none)")

    if recovered:
        _record_failure(state, step, error, resolved=True, kind=kind)
        state["status"] = "executing"

    _append(state, _log(
        "recovery",
        "RECOVERY_SUCCEEDED" if recovered else "RECOVERY_FAILED",
        f"Recovery {'SUCCEEDED' if recovered else 'FAILED'} in {elapsed:.1f}ms. "
        f"New vendor: {new_vendor}. "
        f"Confidence: {state.get('confidence_score', 0.0):.2f}.",
        state.get("confidence_score", 0.0) if recovered else 0.0,
        f"[{AGENT}] {'✓ RECOVERED' if recovered else '✗ RECOVERY FAILED'} "
        f"— '{step}' vendor='{new_vendor}' ({elapsed:.0f}ms)",
    ))

    return recovered


# ── Orchestrator ───────────────────────────────────────────────────────────────

def run_orchestrator(
    state: dict[str, Any],
    sim:   SimCfg | None = None,
) -> dict[str, Any]:
    cfg = sim or _DEFAULT_CFG
    rng = random.Random(cfg.seed)

    state.setdefault("logs", [])
    state.setdefault("failures", [])
    state["status"]     = "executing"
    state["updated_at"] = _utcnow()

    sim_banner = (
        f"Simulation ON — "
        f"timeout={cfg.vendor_timeout}, "
        f"mismatch={cfg.invoice_mismatch}, "
        f"budget={cfg.budget_exceeded}"
        if cfg.enabled else "Simulation OFF"
    )

    _append(state, _log(
        "needs_assessment", "orchestrator_start",
        f"Orchestrator starting for {state.get('request_id')}. "
        f"Pipeline: {[n for n, _ in PIPELINE]}. "
        f"Max retries: {MAX_RETRIES}. {sim_banner}.",
        1.0,
        f"[{AGENT}] Pipeline started — {sim_banner}",
    ))

    # ── Main pipeline loop ─────────────────────────────────────────────────────
    for name, fn in PIPELINE:
        step    = _step_name(name)
        success = False

        for attempt in range(1, MAX_RETRIES + 1):
            _pre_agent(state, name, attempt)
            ok, error, elapsed = _run_agent(fn, state, name, attempt, cfg, rng)
            _post_agent(state, name, attempt, elapsed, ok, error)

            if ok:
                success = True
                _append(state, _log(
                    step, "pipeline_step_complete",
                    f"Step '{name}' passed on attempt {attempt}. "
                    f"Confidence: {state.get('confidence_score', 0.0):.2f}.",
                    state.get("confidence_score", 0.0),
                    f"[{AGENT}] ✓ Step '{name}' complete",
                ))
                break

            # ── Failure path ───────────────────────────────────────────────────
            kind = _classify_error(error)

            if attempt < MAX_RETRIES:
                healed = _attempt_healing(state, step, error, kind)
                _append(state, _log(
                    "recovery",
                    "retry_after_recovery" if healed else "retry_without_recovery",
                    f"{'Healing succeeded' if healed else 'Healing failed'}. "
                    f"Retrying '{name}' (attempt {attempt + 1}).",
                    state.get("confidence_score", 0.0) if healed else 0.0,
                    f"[{AGENT}] Retrying '{name}' "
                    f"{'after recovery' if healed else 'without recovery'}",
                ))
            else:
                _record_failure(state, step, error, kind=kind)
                _append(state, _log(
                    step, "PIPELINE_ABORTED",
                    f"Step '{name}' exhausted {MAX_RETRIES} attempts. "
                    f"Last error: '{error}'. Kind: '{kind}'. Aborting.",
                    0.0,
                    f"[{AGENT}] ABORTED — '{name}' failed {MAX_RETRIES}× ({kind})",
                ))
                state["status"]     = "failed"
                state["updated_at"] = _utcnow()
                return state

        if not success:
            state["status"]     = "failed"
            state["updated_at"] = _utcnow()
            return state

    # ── All steps passed — run audit ───────────────────────────────────────────
    _append(state, _log(
        "closed", "pipeline_complete",
        f"All {len(PIPELINE)} steps completed. "
        f"Final confidence: {state.get('confidence_score', 0.0):.2f}. "
        "Invoking audit-agent.",
        state.get("confidence_score", 0.0),
        f"[{AGENT}] Pipeline complete — invoking audit-agent",
    ))

    t0 = time.perf_counter()
    try:
        run_audit_agent(state)
        elapsed = (time.perf_counter() - t0) * 1000
        _append(state, _log(
            "closed", "audit_complete",
            f"Audit sealed "
            f"{len(state.get('audit_report', {}).get('entries', []))} entries "
            f"in {elapsed:.1f}ms. "
            f"Report: {state.get('audit_report', {}).get('report_id')}.",
            1.0,
            f"[{AGENT}] Audit sealed ({elapsed:.0f}ms)",
        ))
    except Exception as exc:
        _append(state, _log(
            "closed", "audit_exception",
            f"Audit agent raised: {exc}. Report incomplete.",
            0.50,
            f"[{AGENT}] Audit error: {exc}",
        ))

    state["status"]     = "completed"
    state["updated_at"] = _utcnow()

    _append(state, _log(
        "closed", "ORCHESTRATOR_COMPLETE",
        f"Workflow {state.get('request_id')} completed. "
        f"Vendor: {(state.get('selected_vendor') or {}).get('name', '(none)')}. "
        f"PO: {state.get('contract_ref')}. "
        f"Confidence: {state.get('confidence_score', 0.0):.2f}. "
        f"Total log entries: {len(state.get('logs', []))}.",
        state.get("confidence_score", 0.0),
        f"[{AGENT}] ✓ COMPLETED — {state.get('request_id')}",
    ))

    return state


# ── State factory ──────────────────────────────────────────────────────────────

def new_procurement_state(
    request_id: str | None = None,
    category:   str        = "industrial_components",
    department: str        = "engineering",
    budget:     float      = 55_000.00,
    currency:   str        = "USD",
) -> dict[str, Any]:
    now = _utcnow()
    rid = request_id or f"req-{uuid.uuid4().hex[:8]}"
    return {
        "request_id":       rid,
        "created_at":       now,
        "updated_at":       now,
        "current_step":     "needs_assessment",
        "status":           "planning",
        "confidence_score": 0.0,
        "selected_vendor":  None,
        "contract_ref":     None,
        "purchase_order":   None,
        "invoice":          None,
        "verification":     None,
        "audit_report":     None,
        "vendors":          [],
        "failures":         [],
        "metadata": {
            "category":     category,
            "department":   department,
            "cost_centre":  "CC-4412",
            "requester_id": "emp-unknown",
        },
        "budget": {
            "approved":  budget,
            "currency":  currency,
            "remaining": budget,
        },
        "logs": [
            {
                "ts":         now,
                "step":       "needs_assessment",
                "actor":      "system",
                "action":     "create_request",
                "reasoning":  f"Procurement request {rid} created.",
                "confidence": 1.0,
                "message":    f"[system] Request {rid} created",
            }
        ],
    }