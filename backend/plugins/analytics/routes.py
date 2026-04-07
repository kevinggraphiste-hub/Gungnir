"""
Gungnir Plugin — Analytics Routes

17 endpoints for cost tracking, trends, budgets, and exports.
Self-contained — delegates to CostManager, uses core DB session.
Per-user filtering via ?user_id= query param.
"""
import csv
import io
import logging
from typing import Optional

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend.core.db.engine import async_session
from .manager import get_cost_manager

logger = logging.getLogger("gungnir.plugins.analytics")
router = APIRouter()
cm = get_cost_manager()


# ── Pydantic models ──────────────────────────────────────────────────────────

class BudgetUpdate(BaseModel):
    monthly_limit: Optional[float] = None
    weekly_limit: Optional[float] = None
    alert_80: bool = True
    alert_90: bool = True
    alert_100: bool = True
    block_on_limit: bool = False


class ProviderBudgetUpdate(BaseModel):
    monthly_limit: Optional[float] = None
    weekly_limit: Optional[float] = None


# ── Health ────────────────────────────────────────────────────────────────────

@router.get("/health")
async def analytics_health():
    return {"plugin": "analytics", "status": "ok", "version": "2.0.0"}


# ── Summary ───────────────────────────────────────────────────────────────────

@router.get("/summary")
async def get_summary(user_id: Optional[int] = Query(None)):
    try:
        async with async_session() as session:
            return await cm.get_summary(session, user_id)
    except Exception as e:
        logger.error(f"Summary endpoint error: {e}")
        return {"total_cost": 0, "total_tokens": 0, "message_count": 0, "avg_cost_per_message": 0}


# ── Breakdowns ────────────────────────────────────────────────────────────────

@router.get("/by-model")
async def get_by_model(user_id: Optional[int] = Query(None)):
    try:
        async with async_session() as session:
            return await cm.get_by_model(session, user_id)
    except Exception as e:
        logger.error(f"By-model error: {e}")
        return []


@router.get("/by-provider")
async def get_by_provider(user_id: Optional[int] = Query(None)):
    try:
        async with async_session() as session:
            return await cm.get_by_provider(session, user_id)
    except Exception as e:
        logger.error(f"By-provider error: {e}")
        return []


# ── Time series ───────────────────────────────────────────────────────────────

@router.get("/by-day")
async def get_by_day(days: int = Query(30, ge=1, le=365), user_id: Optional[int] = Query(None)):
    try:
        async with async_session() as session:
            return await cm.get_daily(session, days, user_id)
    except Exception as e:
        logger.error(f"By-day error: {e}")
        return []


@router.get("/by-week")
async def get_by_week(weeks: int = Query(12, ge=1, le=104), user_id: Optional[int] = Query(None)):
    try:
        async with async_session() as session:
            return await cm.get_weekly(session, weeks, user_id)
    except Exception as e:
        logger.error(f"By-week error: {e}")
        return []


@router.get("/by-month")
async def get_by_month(months: int = Query(12, ge=1, le=60), user_id: Optional[int] = Query(None)):
    try:
        async with async_session() as session:
            return await cm.get_monthly(session, months, user_id)
    except Exception as e:
        logger.error(f"By-month error: {e}")
        return []


@router.get("/by-year")
async def get_by_year(user_id: Optional[int] = Query(None)):
    try:
        async with async_session() as session:
            return await cm.get_yearly(session, user_id)
    except Exception as e:
        logger.error(f"By-year error: {e}")
        return []


# ── Heatmap ───────────────────────────────────────────────────────────────────

@router.get("/heatmap")
async def get_heatmap(days: int = Query(90, ge=1, le=365), user_id: Optional[int] = Query(None)):
    try:
        async with async_session() as session:
            return await cm.get_heatmap(session, days, user_id)
    except Exception as e:
        logger.error(f"Heatmap error: {e}")
        return []


# ── Conversations ─────────────────────────────────────────────────────────────

@router.get("/conversations")
async def get_conversations(limit: int = Query(50, ge=1, le=200), user_id: Optional[int] = Query(None)):
    try:
        async with async_session() as session:
            return await cm.get_conversations(session, limit, user_id)
    except Exception as e:
        logger.error(f"Conversations error: {e}")
        return []


# ── Budget ────────────────────────────────────────────────────────────────────

@router.get("/budget")
async def get_budget():
    try:
        async with async_session() as session:
            return await cm.get_budget(session)
    except Exception as e:
        logger.error(f"Get budget error: {e}")
        return {}


@router.put("/budget")
async def update_budget(data: BudgetUpdate):
    try:
        async with async_session() as session:
            return await cm.update_budget(session, data.model_dump())
    except Exception as e:
        logger.error(f"Update budget error: {e}")
        return {"success": False, "error": str(e)}


@router.get("/check-budget")
async def check_budget(user_id: Optional[int] = Query(None)):
    try:
        async with async_session() as session:
            return await cm.check_budgets(session, user_id)
    except Exception as e:
        logger.error(f"Check budget error: {e}")
        return {"alerts": [], "should_block": False, "block_reason": ""}


# ── Provider budgets ──────────────────────────────────────────────────────────

@router.get("/provider-budgets")
async def get_provider_budgets():
    try:
        async with async_session() as session:
            return await cm.get_provider_budgets(session)
    except Exception as e:
        logger.error(f"Provider budgets error: {e}")
        return []


@router.put("/provider-budgets/{provider}")
async def upsert_provider_budget(provider: str, data: ProviderBudgetUpdate):
    try:
        async with async_session() as session:
            return await cm.upsert_provider_budget(
                session, provider, data.monthly_limit, data.weekly_limit
            )
    except Exception as e:
        logger.error(f"Upsert provider budget error: {e}")
        return {"success": False, "error": str(e)}


@router.delete("/provider-budgets/{provider}")
async def delete_provider_budget(provider: str):
    try:
        async with async_session() as session:
            return await cm.delete_provider_budget(session, provider)
    except Exception as e:
        logger.error(f"Delete provider budget error: {e}")
        return {"success": False, "error": str(e)}


# ── Export ────────────────────────────────────────────────────────────────────

@router.get("/export")
async def export_csv(user_id: Optional[int] = Query(None)):
    """Export cost records as CSV, filtered by user."""
    try:
        async with async_session() as session:
            records = await cm.get_user_records(session, user_id)

        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["date", "model", "tokens_input", "tokens_output", "cost", "conversation_id"])
        for rec in records:
            writer.writerow([
                str(rec.date), rec.model, rec.tokens_input,
                rec.tokens_output, round(rec.cost, 6), rec.conversation_id or "",
            ])
        buf.seek(0)
        return StreamingResponse(
            iter([buf.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=gungnir_analytics.csv"},
        )
    except Exception as e:
        logger.error(f"Export error: {e}")
        return {"error": str(e)}
