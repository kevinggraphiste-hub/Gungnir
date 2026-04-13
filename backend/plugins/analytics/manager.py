"""
Gungnir Analytics — Cost Manager

All database queries for analytics. Uses core DB models (read + write).
Self-contained business logic — no core state mutations.
Supports per-user filtering via Conversation.user_id join.
Compatible SQLite (dev) + PostgreSQL (prod).
"""
import logging
from datetime import datetime, timedelta
from typing import Optional, List

from sqlalchemy import select, func, and_, extract, cast, Date, text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.db.models import CostAnalytics, BudgetSettings, ProviderBudget, Conversation
from .calculator import calculate_cost, extract_model_name

logger = logging.getLogger("gungnir.plugins.analytics")


def _user_filter(query, user_id: Optional[int]):
    """Add user_id filter via Conversation join if user_id is provided."""
    if user_id is None:
        return query
    return query.join(Conversation, CostAnalytics.conversation_id == Conversation.id).where(
        Conversation.user_id == user_id
    )


class CostManager:

    async def record_cost(
        self, session: AsyncSession,
        conversation_id: int, model: str,
        tokens_input: int, tokens_output: int,
        message_date: Optional[datetime] = None,
    ) -> float:
        """Record cost for a message. Returns calculated cost."""
        try:
            std_model = extract_model_name(model)
            cost = calculate_cost(std_model, tokens_input, tokens_output)
            record = CostAnalytics(
                date=(message_date or datetime.utcnow()).date(),
                conversation_id=conversation_id,
                model=std_model,
                tokens_input=tokens_input,
                tokens_output=tokens_output,
                cost=cost,
            )
            session.add(record)
            await session.commit()
            return cost
        except Exception as e:
            logger.error(f"Record cost error: {e}")
            await session.rollback()
            return 0.0

    async def get_summary(self, session: AsyncSession, user_id: Optional[int] = None) -> dict:
        try:
            q = select(
                func.sum(CostAnalytics.cost).label("tc"),
                func.sum(CostAnalytics.tokens_input).label("ti"),
                func.sum(CostAnalytics.tokens_output).label("to"),
                func.count().label("mc"),
            )
            q = _user_filter(q, user_id)
            r = await session.execute(q)
            d = r.first()
            tc = float(d.tc or 0)
            mc = int(d.mc or 0)
            return {
                "total_cost": round(tc, 4),
                "total_tokens": int(d.ti or 0) + int(d.to or 0),
                "message_count": mc,
                "avg_cost_per_message": round(tc / mc, 4) if mc else 0.0,
            }
        except Exception as e:
            logger.error(f"Summary error: {e}")
            return {"total_cost": 0, "total_tokens": 0, "message_count": 0, "avg_cost_per_message": 0}

    async def get_by_model(self, session: AsyncSession, user_id: Optional[int] = None) -> List[dict]:
        try:
            q = select(
                CostAnalytics.model,
                func.sum(CostAnalytics.cost).label("tc"),
                func.sum(CostAnalytics.tokens_input + CostAnalytics.tokens_output).label("tt"),
                func.count().label("mc"),
            ).group_by(CostAnalytics.model).order_by(func.sum(CostAnalytics.cost).desc())
            q = _user_filter(q, user_id)
            r = await session.execute(q)
            return [{"model": row.model, "total_cost": round(float(row.tc), 4),
                      "total_tokens": int(row.tt or 0), "message_count": int(row.mc or 0)}
                     for row in r.all()]
        except Exception as e:
            logger.error(f"By model error: {e}")
            return []

    async def get_by_provider(self, session: AsyncSession, user_id: Optional[int] = None) -> List[dict]:
        try:
            models = await self.get_by_model(session, user_id)
            providers: dict = {}
            for m in models:
                p = m["model"].split("/")[0] if "/" in m["model"] else "other"
                if p not in providers:
                    providers[p] = {"provider": p, "total_cost": 0.0, "total_tokens": 0, "message_count": 0}
                providers[p]["total_cost"] = round(providers[p]["total_cost"] + m["total_cost"], 4)
                providers[p]["total_tokens"] += m["total_tokens"]
                providers[p]["message_count"] += m["message_count"]
            return sorted(providers.values(), key=lambda x: x["total_cost"], reverse=True)
        except Exception as e:
            logger.error(f"By provider error: {e}")
            return []

    async def get_daily(self, session: AsyncSession, days: int = 30, user_id: Optional[int] = None) -> List[dict]:
        try:
            since = datetime.utcnow() - timedelta(days=days)
            day_col = cast(CostAnalytics.created_at, Date)
            q = select(
                day_col.label("day"),
                func.sum(CostAnalytics.cost).label("total_cost"),
                func.sum(CostAnalytics.tokens_input + CostAnalytics.tokens_output).label("total_tokens"),
                func.count().label("msg_count"),
            ).where(CostAnalytics.created_at >= since)
            q = _user_filter(q, user_id)
            q = q.group_by(day_col).order_by(day_col)
            r = await session.execute(q)
            return [{"date": str(row.day), "cost": round(float(row.total_cost), 4),
                      "tokens": int(row.total_tokens or 0), "messages": int(row.msg_count or 0)}
                     for row in r.all()]
        except Exception as e:
            logger.error(f"Daily error: {e}")
            return []

    async def get_weekly(self, session: AsyncSession, weeks: int = 12, user_id: Optional[int] = None) -> List[dict]:
        try:
            since = datetime.utcnow() - timedelta(weeks=weeks)
            # extract(year/week) works on both SQLite (via Python) and PostgreSQL
            yr = extract('year', CostAnalytics.created_at)
            wk = extract('week', CostAnalytics.created_at)
            q = select(
                yr.label("yr"), wk.label("wk"),
                func.sum(CostAnalytics.cost).label("total_cost"),
                func.sum(CostAnalytics.tokens_input + CostAnalytics.tokens_output).label("total_tokens"),
                func.count().label("msg_count"),
            ).where(CostAnalytics.created_at >= since)
            q = _user_filter(q, user_id)
            q = q.group_by(yr, wk).order_by(yr, wk)
            r = await session.execute(q)
            return [{"week": f"{int(row.yr)}-W{int(row.wk):02d}", "cost": round(float(row.total_cost), 4),
                      "tokens": int(row.total_tokens or 0), "messages": int(row.msg_count or 0)}
                     for row in r.all()]
        except Exception as e:
            logger.error(f"Weekly error: {e}")
            return []

    async def get_monthly(self, session: AsyncSession, months: int = 12, user_id: Optional[int] = None) -> List[dict]:
        try:
            since = datetime.utcnow() - timedelta(days=months * 31)
            yr = extract('year', CostAnalytics.created_at)
            mo = extract('month', CostAnalytics.created_at)
            q = select(
                yr.label("yr"), mo.label("mo"),
                func.sum(CostAnalytics.cost).label("total_cost"),
                func.sum(CostAnalytics.tokens_input + CostAnalytics.tokens_output).label("total_tokens"),
                func.count().label("msg_count"),
            ).where(CostAnalytics.created_at >= since)
            q = _user_filter(q, user_id)
            q = q.group_by(yr, mo).order_by(yr, mo)
            r = await session.execute(q)
            return [{"month": f"{int(row.yr)}-{int(row.mo):02d}", "cost": round(float(row.total_cost), 4),
                      "tokens": int(row.total_tokens or 0), "messages": int(row.msg_count or 0)}
                     for row in r.all()]
        except Exception as e:
            logger.error(f"Monthly error: {e}")
            return []

    async def get_yearly(self, session: AsyncSession, user_id: Optional[int] = None) -> List[dict]:
        try:
            yr = extract('year', CostAnalytics.created_at)
            q = select(
                yr.label("yr"),
                func.sum(CostAnalytics.cost).label("total_cost"),
                func.sum(CostAnalytics.tokens_input + CostAnalytics.tokens_output).label("total_tokens"),
                func.count().label("msg_count"),
            )
            q = _user_filter(q, user_id)
            q = q.group_by(yr).order_by(yr)
            r = await session.execute(q)
            return [{"year": str(int(row.yr)), "cost": round(float(row.total_cost), 4),
                      "tokens": int(row.total_tokens or 0), "messages": int(row.msg_count or 0)}
                     for row in r.all()]
        except Exception as e:
            logger.error(f"Yearly error: {e}")
            return []

    async def get_heatmap(self, session: AsyncSession, days: int = 90, user_id: Optional[int] = None) -> List[dict]:
        try:
            since = datetime.utcnow() - timedelta(days=days)
            day_col = cast(CostAnalytics.created_at, Date)
            q = select(
                day_col.label("day"),
                func.count().label("msg_count"),
                func.sum(CostAnalytics.cost).label("total_cost"),
            ).where(CostAnalytics.created_at >= since)
            q = _user_filter(q, user_id)
            q = q.group_by(day_col).order_by(day_col)
            r = await session.execute(q)
            return [{"date": str(row.day), "count": int(row.msg_count), "cost": round(float(row.total_cost), 4)}
                     for row in r.all()]
        except Exception as e:
            logger.error(f"Heatmap error: {e}")
            return []

    async def get_conversations(self, session: AsyncSession, limit: int = 50, user_id: Optional[int] = None) -> List[dict]:
        try:
            q = select(
                Conversation.id, Conversation.title,
                func.sum(CostAnalytics.cost).label("tc"),
                func.sum(CostAnalytics.tokens_input + CostAnalytics.tokens_output).label("tt"),
                func.count(CostAnalytics.id).label("mc"),
                func.max(CostAnalytics.created_at).label("last"),
            ).join(CostAnalytics, CostAnalytics.conversation_id == Conversation.id)
            if user_id is not None:
                q = q.where(Conversation.user_id == user_id)
            q = q.group_by(Conversation.id, Conversation.title).order_by(func.max(CostAnalytics.created_at).desc()).limit(limit)
            r = await session.execute(q)
            return [{"conversation_id": row.id, "title": row.title,
                      "total_cost": round(float(row.tc), 4), "total_tokens": int(row.tt or 0),
                      "message_count": int(row.mc or 0),
                      "last_message": str(row.last) if row.last else None}
                     for row in r.all()]
        except Exception as e:
            logger.error(f"Conversations error: {e}")
            return []

    # ── Budget ─────────────────────────────────────────────────────────────

    async def _monthly_cost(self, session: AsyncSession, user_id: Optional[int] = None) -> float:
        now = datetime.utcnow()
        q = select(func.sum(CostAnalytics.cost)).where(and_(
            extract('year', CostAnalytics.created_at) == now.year,
            extract('month', CostAnalytics.created_at) == now.month,
        ))
        q = _user_filter(q, user_id)
        r = await session.execute(q)
        return float(r.scalar() or 0.0)

    async def _weekly_cost(self, session: AsyncSession, user_id: Optional[int] = None) -> float:
        # Début de la semaine courante (lundi)
        now = datetime.utcnow()
        week_start = now - timedelta(days=now.weekday())
        week_start = week_start.replace(hour=0, minute=0, second=0, microsecond=0)
        q = select(func.sum(CostAnalytics.cost)).where(
            CostAnalytics.created_at >= week_start
        )
        q = _user_filter(q, user_id)
        r = await session.execute(q)
        return float(r.scalar() or 0.0)

    async def _provider_cost(self, session: AsyncSession, provider: str, period: str = "month", user_id: Optional[int] = None) -> float:
        now = datetime.utcnow()
        if period == "week":
            week_start = now - timedelta(days=now.weekday())
            week_start = week_start.replace(hour=0, minute=0, second=0, microsecond=0)
            base_where = and_(
                CostAnalytics.model.like(f"{provider}/%"),
                CostAnalytics.created_at >= week_start,
            )
        else:
            base_where = and_(
                CostAnalytics.model.like(f"{provider}/%"),
                extract('year', CostAnalytics.created_at) == now.year,
                extract('month', CostAnalytics.created_at) == now.month,
            )
        q = select(func.sum(CostAnalytics.cost)).where(base_where)
        q = _user_filter(q, user_id)
        r = await session.execute(q)
        return float(r.scalar() or 0.0)

    async def get_budget(self, session: AsyncSession) -> dict:
        try:
            r = await session.execute(
                select(BudgetSettings).order_by(BudgetSettings.updated_at.desc()).limit(1)
            )
            s = r.scalar_one_or_none()
            if not s:
                return {"monthly_limit": None, "weekly_limit": None,
                        "alert_80": True, "alert_90": True, "alert_100": True,
                        "block_on_limit": False}
            return {
                "monthly_limit": float(s.monthly_limit) if s.monthly_limit else None,
                "weekly_limit": float(s.weekly_limit) if s.weekly_limit else None,
                "alert_80": s.alert_80, "alert_90": s.alert_90, "alert_100": s.alert_100,
                "block_on_limit": s.block_on_limit,
            }
        except Exception as e:
            logger.error(f"Get budget error: {e}")
            return {"monthly_limit": None, "weekly_limit": None,
                    "alert_80": True, "alert_90": True, "alert_100": True,
                    "block_on_limit": False}

    async def update_budget(self, session: AsyncSession, settings: dict) -> dict:
        try:
            bs = BudgetSettings(
                monthly_limit=float(settings["monthly_limit"]) if settings.get("monthly_limit") else None,
                weekly_limit=float(settings["weekly_limit"]) if settings.get("weekly_limit") else None,
                alert_80=settings.get("alert_80", True),
                alert_90=settings.get("alert_90", True),
                alert_100=settings.get("alert_100", True),
                block_on_limit=settings.get("block_on_limit", False),
            )
            session.add(bs)
            await session.commit()
            return {"success": True}
        except Exception as e:
            logger.error(f"Update budget error: {e}")
            await session.rollback()
            return {"success": False, "error": str(e)}

    async def get_provider_budgets(self, session: AsyncSession) -> List[dict]:
        try:
            r = await session.execute(select(ProviderBudget).order_by(ProviderBudget.provider))
            return [{"id": pb.id, "provider": pb.provider,
                      "monthly_limit": float(pb.monthly_limit) if pb.monthly_limit else None,
                      "weekly_limit": float(pb.weekly_limit) if pb.weekly_limit else None}
                     for pb in r.scalars().all()]
        except Exception as e:
            logger.error(f"Provider budgets error: {e}")
            return []

    async def upsert_provider_budget(self, session: AsyncSession,
                                      provider: str, monthly: float = None,
                                      weekly: float = None) -> dict:
        try:
            r = await session.execute(select(ProviderBudget).where(ProviderBudget.provider == provider))
            pb = r.scalar_one_or_none()
            if pb:
                pb.monthly_limit = monthly
                pb.weekly_limit = weekly
            else:
                pb = ProviderBudget(provider=provider, monthly_limit=monthly, weekly_limit=weekly)
                session.add(pb)
            await session.commit()
            return {"success": True}
        except Exception as e:
            await session.rollback()
            return {"success": False, "error": str(e)}

    async def delete_provider_budget(self, session: AsyncSession, provider: str) -> dict:
        try:
            r = await session.execute(select(ProviderBudget).where(ProviderBudget.provider == provider))
            pb = r.scalar_one_or_none()
            if pb:
                await session.delete(pb)
                await session.commit()
            return {"success": True}
        except Exception as e:
            await session.rollback()
            return {"success": False, "error": str(e)}

    async def check_budgets(self, session: AsyncSession, user_id: Optional[int] = None) -> dict:
        """Check all budgets — returns alerts and block status."""
        alerts = []
        should_block = False
        block_reason = ""

        budget = await self.get_budget(session)
        mc = await self._monthly_cost(session, user_id)
        wc = await self._weekly_cost(session, user_id)

        for label, cost, limit in [
            ("Global mensuel", mc, budget.get("monthly_limit")),
            ("Global hebdo", wc, budget.get("weekly_limit")),
        ]:
            if not limit:
                continue
            pct = (cost / limit) * 100
            if pct >= 100:
                alerts.append({"level": 100, "scope": label, "percent": round(pct, 1),
                               "cost": round(cost, 4), "limit": limit})
                if budget.get("block_on_limit"):
                    should_block = True
                    block_reason = f"{label}: ${cost:.4f} / ${limit:.2f}"
            elif pct >= 80:
                alerts.append({"level": 80, "scope": label, "percent": round(pct, 1),
                               "cost": round(cost, 4), "limit": limit})

        for pb in await self.get_provider_budgets(session):
            for suffix, period, key in [("mensuel", "month", "monthly_limit"),
                                         ("hebdo", "week", "weekly_limit")]:
                limit = pb.get(key)
                if not limit:
                    continue
                cost = await self._provider_cost(session, pb["provider"], period, user_id)
                pct = (cost / limit) * 100
                scope = f"{pb['provider']} {suffix}"
                if pct >= 100:
                    alerts.append({"level": 100, "scope": scope, "percent": round(pct, 1),
                                   "cost": round(cost, 4), "limit": limit})
                    should_block = True
                    block_reason = block_reason or f"{scope}: ${cost:.4f} / ${limit:.2f}"
                elif pct >= 80:
                    alerts.append({"level": 80, "scope": scope, "percent": round(pct, 1),
                                   "cost": round(cost, 4), "limit": limit})

        return {"alerts": alerts, "should_block": should_block, "block_reason": block_reason}

    async def get_user_records(self, session: AsyncSession, user_id: Optional[int] = None) -> list:
        """Get all cost records filtered by user for export."""
        from sqlalchemy import select as sel
        q = sel(CostAnalytics).order_by(CostAnalytics.created_at.desc())
        q = _user_filter(q, user_id)
        r = await session.execute(q)
        return r.scalars().all()


# Singleton
_instance: Optional[CostManager] = None

def get_cost_manager() -> CostManager:
    global _instance
    if _instance is None:
        _instance = CostManager()
    return _instance
