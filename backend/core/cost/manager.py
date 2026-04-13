from datetime import datetime, timedelta
from typing import Optional, List
from sqlalchemy import select, func, and_, extract, cast, Date
from sqlalchemy.ext.asyncio import AsyncSession
from backend.core.db.models import CostAnalytics, BudgetSettings, ProviderBudget, Message, Conversation
from backend.core.cost.calculator import calculate_cost, extract_model_from_response
import logging

logger = logging.getLogger(__name__)

class CostManager:
    def __init__(self):
        pass

    async def record_message_cost(
        self,
        session: AsyncSession,
        conversation_id: int,
        model: str,
        tokens_input: int,
        tokens_output: int,
        message_date: Optional[datetime] = None
    ) -> float:
        """Record cost for a message and return the calculated cost."""
        try:
            standardized_model = extract_model_from_response(model)
            cost = calculate_cost(standardized_model, tokens_input, tokens_output)
            
            record_date = message_date.date() if message_date else datetime.utcnow().date()
            
            analytics_record = CostAnalytics(
                date=record_date,
                conversation_id=conversation_id,
                model=standardized_model,
                tokens_input=tokens_input,
                tokens_output=tokens_output,
                cost=cost
            )
            
            session.add(analytics_record)
            await session.commit()
            
            return cost
            
        except Exception as e:
            logger.error(f"Error recording cost: {e}")
            await session.rollback()
            return 0.0

    async def get_summary(self, session: AsyncSession) -> dict:
        """Get overall cost and usage summary."""
        try:
            result = await session.execute(
                select(
                    func.sum(CostAnalytics.cost).label("total_cost"),
                    func.sum(CostAnalytics.tokens_input).label("total_input_tokens"),
                    func.sum(CostAnalytics.tokens_output).label("total_output_tokens"),
                    func.count().label("message_count")
                )
            )
            data = result.first()
            
            total_cost = float(data.total_cost or 0.0)
            total_tokens = int(data.total_input_tokens or 0) + int(data.total_output_tokens or 0)
            message_count = int(data.message_count or 0)
            
            avg_cost_per_message = total_cost / message_count if message_count > 0 else 0.0
            
            return {
                "total_cost": round(total_cost, 4),
                "total_tokens": total_tokens,
                "message_count": message_count,
                "avg_cost_per_message": round(avg_cost_per_message, 4)
            }
        except Exception as e:
            logger.error(f"Error getting summary: {e}")
            return {
                "total_cost": 0.0,
                "total_tokens": 0,
                "message_count": 0,
                "avg_cost_per_message": 0.0
            }

    async def get_costs_by_model(self, session: AsyncSession) -> List[dict]:
        """Get cost breakdown by model."""
        try:
            result = await session.execute(
                select(
                    CostAnalytics.model,
                    func.sum(CostAnalytics.cost).label("total_cost"),
                    func.sum(CostAnalytics.tokens_input + CostAnalytics.tokens_output).label("total_tokens"),
                    func.count().label("message_count")
                )
                .group_by(CostAnalytics.model)
                .order_by(func.sum(CostAnalytics.cost).desc())
            )
            
            return [
                {
                    "model": row.model,
                    "total_cost": round(float(row.total_cost), 4),
                    "total_tokens": int(row.total_tokens or 0),
                    "message_count": int(row.message_count or 0)
                }
                for row in result.all()
            ]
        except Exception as e:
            logger.error(f"Error getting costs by model: {e}")
            return []

    async def get_daily_costs(self, session: AsyncSession, days: int = 30) -> List[dict]:
        """Get daily costs for the last N days."""
        try:
            since = datetime.utcnow() - timedelta(days=days)
            day_col = cast(CostAnalytics.created_at, Date)
            result = await session.execute(
                select(
                    day_col.label("date"),
                    func.sum(CostAnalytics.cost).label("daily_cost"),
                    func.sum(CostAnalytics.tokens_input + CostAnalytics.tokens_output).label("daily_tokens")
                )
                .where(CostAnalytics.created_at >= since)
                .group_by(day_col)
                .order_by(day_col)
            )

            return [
                {
                    "date": str(row.date),
                    "cost": round(float(row.daily_cost), 4),
                    "tokens": int(row.daily_tokens or 0)
                }
                for row in result.all()
            ]
        except Exception as e:
            logger.error(f"Error getting daily costs: {e}")
            return []

    async def get_monthly_cost(self, session: AsyncSession, year: Optional[int] = None, month: Optional[int] = None) -> float:
        """Get total cost for a specific month."""
        try:
            now = datetime.utcnow()
            year = year or now.year
            month = month or now.month
            
            result = await session.execute(
                select(func.sum(CostAnalytics.cost))
                .where(
                    and_(
                        extract('year', CostAnalytics.created_at) == year,
                        extract('month', CostAnalytics.created_at) == month
                    )
                )
            )
            
            total = result.scalar() or 0.0
            return float(total)
            
        except Exception as e:
            logger.error(f"Error getting monthly cost: {e}")
            return 0.0

    async def check_budget_alerts(self, session: AsyncSession) -> List[dict]:
        """Check if budget alerts should be triggered."""
        try:
            budget = await self.get_budget_settings(session)
            
            if not budget.get("monthly_limit"):
                return []
            
            monthly_cost = await self.get_monthly_cost(session)
            limit = budget["monthly_limit"]
            
            alerts = []
            percentage = (monthly_cost / limit) * 100 if limit > 0 else 0
            
            if percentage >= 100 and budget.get("alert_100", True):
                alerts.append({
                    "level": 100,
                    "message": f"Budget limit reached! ${monthly_cost:.2f} / ${limit:.2f} ({percentage:.1f}%)",
                    "should_block": budget.get("block_on_limit", False)
                })
            elif percentage >= 90 and budget.get("alert_90", True):
                alerts.append({
                    "level": 90,
                    "message": f"Budget 90% reached: ${monthly_cost:.2f} / ${limit:.2f} ({percentage:.1f}%)",
                    "should_block": False
                })
            elif percentage >= 80 and budget.get("alert_80", True):
                alerts.append({
                    "level": 80,
                    "message": f"Budget 80% reached: ${monthly_cost:.2f} / ${limit:.2f} ({percentage:.1f}%)",
                    "should_block": False
                })
            
            return alerts
            
        except Exception as e:
            logger.error(f"Error checking budget alerts: {e}")
            return []

    async def should_block_requests(self, session: AsyncSession) -> tuple[bool, str]:
        """Check if new requests should be blocked due to budget limit."""
        try:
            budget = await self.get_budget_settings(session)
            
            if not budget.get("monthly_limit") or not budget.get("block_on_limit", False):
                return False, ""
            
            monthly_cost = await self.get_monthly_cost(session)
            limit = budget["monthly_limit"]
            
            if monthly_cost >= limit:
                return True, f"Monthly budget limit reached: ${monthly_cost:.2f} / ${limit:.2f}"
            
            return False, ""
            
        except Exception as e:
            logger.error(f"Error checking request blocking: {e}")
            return False, ""

    async def get_budget_settings(self, session: AsyncSession) -> dict:
        """Get current budget settings."""
        try:
            result = await session.execute(
                select(BudgetSettings).order_by(BudgetSettings.updated_at.desc()).limit(1)
            )
            settings = result.scalar_one_or_none()
            
            if not settings:
                return {
                    "monthly_limit": None,
                    "weekly_limit": None,
                    "alert_80": True,
                    "alert_90": True,
                    "alert_100": True,
                    "block_on_limit": False
                }

            return {
                "monthly_limit": float(settings.monthly_limit) if settings.monthly_limit else None,
                "weekly_limit": float(settings.weekly_limit) if hasattr(settings, 'weekly_limit') and settings.weekly_limit else None,
                "alert_80": settings.alert_80,
                "alert_90": settings.alert_90,
                "alert_100": settings.alert_100,
                "block_on_limit": settings.block_on_limit
            }
            
        except Exception as e:
            logger.error(f"Error getting budget settings: {e}")
            return {
                "monthly_limit": None,
                "alert_80": True,
                "alert_90": True,
                "alert_100": True,
                "block_on_limit": False
            }

    async def update_budget_settings(self, session: AsyncSession, settings: dict) -> dict:
        """Update budget settings."""
        try:
            budget_settings = BudgetSettings(
                monthly_limit=float(settings.get("monthly_limit")) if settings.get("monthly_limit") else None,
                weekly_limit=float(settings.get("weekly_limit")) if settings.get("weekly_limit") else None,
                alert_80=settings.get("alert_80", True),
                alert_90=settings.get("alert_90", True),
                alert_100=settings.get("alert_100", True),
                block_on_limit=settings.get("block_on_limit", False)
            )
            
            session.add(budget_settings)
            await session.commit()
            
            return {
                "success": True,
                "settings": {
                    "monthly_limit": budget_settings.monthly_limit,
                    "weekly_limit": budget_settings.weekly_limit,
                    "alert_80": budget_settings.alert_80,
                    "alert_90": budget_settings.alert_90,
                    "alert_100": budget_settings.alert_100,
                    "block_on_limit": budget_settings.block_on_limit
                }
            }
            
        except Exception as e:
            logger.error(f"Error updating budget settings: {e}")
            await session.rollback()
            return {"success": False, "error": str(e)}

    async def get_conversation_costs(self, session: AsyncSession, limit: int = 100) -> List[dict]:
        """Get cost breakdown by conversation."""
        try:
            result = await session.execute(
                select(
                    Conversation.id,
                    Conversation.title,
                    func.sum(CostAnalytics.cost).label("total_cost"),
                    func.sum(CostAnalytics.tokens_input + CostAnalytics.tokens_output).label("total_tokens"),
                    func.count(CostAnalytics.id).label("message_count"),
                    func.max(CostAnalytics.created_at).label("last_message")
                )
                .join(CostAnalytics, CostAnalytics.conversation_id == Conversation.id)
                .group_by(Conversation.id, Conversation.title)
                .order_by(func.max(CostAnalytics.created_at).desc())
                .limit(limit)
            )
            
            return [
                {
                    "conversation_id": row.id,
                    "title": row.title,
                    "total_cost": round(float(row.total_cost), 4),
                    "total_tokens": int(row.total_tokens or 0),
                    "message_count": int(row.message_count or 0),
                    "last_message": str(row.last_message) if row.last_message else None
                }
                for row in result.all()
            ]
        except Exception as e:
            logger.error(f"Error getting conversation costs: {e}")
            return []


    async def get_costs_by_provider(self, session: AsyncSession) -> List[dict]:
        """Get cost breakdown by provider (extracted from model name)."""
        try:
            models = await self.get_costs_by_model(session)
            providers: dict = {}
            for m in models:
                provider = m["model"].split("/")[0] if "/" in m["model"] else "other"
                if provider not in providers:
                    providers[provider] = {"provider": provider, "total_cost": 0.0, "total_tokens": 0, "message_count": 0}
                providers[provider]["total_cost"] = round(providers[provider]["total_cost"] + m["total_cost"], 4)
                providers[provider]["total_tokens"] += m["total_tokens"]
                providers[provider]["message_count"] += m["message_count"]
            return sorted(providers.values(), key=lambda x: x["total_cost"], reverse=True)
        except Exception as e:
            logger.error(f"Error getting costs by provider: {e}")
            return []

    async def get_weekly_costs(self, session: AsyncSession, weeks: int = 12) -> List[dict]:
        """Get weekly costs for the last N weeks."""
        try:
            since = datetime.utcnow() - timedelta(weeks=weeks)
            yr = extract('year', CostAnalytics.created_at)
            wk = extract('week', CostAnalytics.created_at)
            result = await session.execute(
                select(
                    yr.label("yr"), wk.label("wk"),
                    func.sum(CostAnalytics.cost).label("weekly_cost"),
                    func.sum(CostAnalytics.tokens_input + CostAnalytics.tokens_output).label("weekly_tokens"),
                    func.count().label("message_count")
                )
                .where(CostAnalytics.created_at >= since)
                .group_by(yr, wk)
                .order_by(yr, wk)
            )
            return [
                {"week": f"{int(row.yr)}-W{int(row.wk):02d}", "cost": round(float(row.weekly_cost), 4), "tokens": int(row.weekly_tokens or 0), "messages": int(row.message_count or 0)}
                for row in result.all()
            ]
        except Exception as e:
            logger.error(f"Error getting weekly costs: {e}")
            return []

    async def get_monthly_costs(self, session: AsyncSession, months: int = 12) -> List[dict]:
        """Get monthly costs for the last N months."""
        try:
            since = datetime.utcnow() - timedelta(days=months * 31)
            yr = extract('year', CostAnalytics.created_at)
            mo = extract('month', CostAnalytics.created_at)
            result = await session.execute(
                select(
                    yr.label("yr"), mo.label("mo"),
                    func.sum(CostAnalytics.cost).label("monthly_cost"),
                    func.sum(CostAnalytics.tokens_input + CostAnalytics.tokens_output).label("monthly_tokens"),
                    func.count().label("message_count")
                )
                .where(CostAnalytics.created_at >= since)
                .group_by(yr, mo)
                .order_by(yr, mo)
            )
            return [
                {"month": f"{int(row.yr)}-{int(row.mo):02d}", "cost": round(float(row.monthly_cost), 4), "tokens": int(row.monthly_tokens or 0), "messages": int(row.message_count or 0)}
                for row in result.all()
            ]
        except Exception as e:
            logger.error(f"Error getting monthly costs: {e}")
            return []

    async def get_yearly_costs(self, session: AsyncSession) -> List[dict]:
        """Get yearly cost breakdown."""
        try:
            yr = extract('year', CostAnalytics.created_at)
            result = await session.execute(
                select(
                    yr.label("yr"),
                    func.sum(CostAnalytics.cost).label("yearly_cost"),
                    func.sum(CostAnalytics.tokens_input + CostAnalytics.tokens_output).label("yearly_tokens"),
                    func.count().label("message_count")
                )
                .group_by(yr)
                .order_by(yr)
            )
            return [
                {"year": str(int(row.yr)), "cost": round(float(row.yearly_cost), 4), "tokens": int(row.yearly_tokens or 0), "messages": int(row.message_count or 0)}
                for row in result.all()
            ]
        except Exception as e:
            logger.error(f"Error getting yearly costs: {e}")
            return []

    async def get_heatmap_data(self, session: AsyncSession, days: int = 90) -> List[dict]:
        """Get activity heatmap data (messages per day with hour distribution)."""
        try:
            since = datetime.utcnow() - timedelta(days=days)
            day_col = cast(CostAnalytics.created_at, Date)
            result = await session.execute(
                select(
                    day_col.label("date"),
                    func.count().label("count"),
                    func.sum(CostAnalytics.cost).label("cost")
                )
                .where(CostAnalytics.created_at >= since)
                .group_by(day_col)
                .order_by(day_col)
            )
            return [
                {"date": str(row.date), "count": int(row.count), "cost": round(float(row.cost), 4)}
                for row in result.all()
            ]
        except Exception as e:
            logger.error(f"Error getting heatmap data: {e}")
            return []

    async def get_weekly_budget_cost(self, session: AsyncSession) -> float:
        """Get total cost for the current week (Monday to Sunday)."""
        try:
            now = datetime.utcnow()
            week_start = now - timedelta(days=now.weekday())
            week_start = week_start.replace(hour=0, minute=0, second=0, microsecond=0)
            result = await session.execute(
                select(func.sum(CostAnalytics.cost))
                .where(CostAnalytics.created_at >= week_start)
            )
            return float(result.scalar() or 0.0)
        except Exception as e:
            logger.error(f"Error getting weekly cost: {e}")
            return 0.0


    async def get_provider_budgets(self, session: AsyncSession) -> List[dict]:
        """Get all provider-specific budget settings."""
        try:
            result = await session.execute(select(ProviderBudget).order_by(ProviderBudget.provider))
            return [
                {
                    "id": pb.id,
                    "provider": pb.provider,
                    "monthly_limit": float(pb.monthly_limit) if pb.monthly_limit else None,
                    "weekly_limit": float(pb.weekly_limit) if pb.weekly_limit else None,
                }
                for pb in result.scalars().all()
            ]
        except Exception as e:
            logger.error(f"Error getting provider budgets: {e}")
            return []

    async def upsert_provider_budget(self, session: AsyncSession, provider: str, monthly_limit: float = None, weekly_limit: float = None) -> dict:
        """Create or update a provider budget."""
        try:
            result = await session.execute(select(ProviderBudget).where(ProviderBudget.provider == provider))
            pb = result.scalar_one_or_none()
            if pb:
                pb.monthly_limit = monthly_limit
                pb.weekly_limit = weekly_limit
            else:
                pb = ProviderBudget(provider=provider, monthly_limit=monthly_limit, weekly_limit=weekly_limit)
                session.add(pb)
            await session.commit()
            return {"success": True, "provider": provider}
        except Exception as e:
            logger.error(f"Error upserting provider budget: {e}")
            await session.rollback()
            return {"success": False, "error": str(e)}

    async def delete_provider_budget(self, session: AsyncSession, provider: str) -> dict:
        """Delete a provider budget."""
        try:
            result = await session.execute(select(ProviderBudget).where(ProviderBudget.provider == provider))
            pb = result.scalar_one_or_none()
            if pb:
                await session.delete(pb)
                await session.commit()
            return {"success": True}
        except Exception as e:
            logger.error(f"Error deleting provider budget: {e}")
            await session.rollback()
            return {"success": False, "error": str(e)}

    async def get_provider_cost(self, session: AsyncSession, provider: str, period: str = "month") -> float:
        """Get total cost for a provider in the current week or month."""
        try:
            now = datetime.utcnow()
            if period == "week":
                week_start = now - timedelta(days=now.weekday())
                week_start = week_start.replace(hour=0, minute=0, second=0, microsecond=0)
                where_clause = and_(
                    CostAnalytics.model.like(f"{provider}/%"),
                    CostAnalytics.created_at >= week_start,
                )
            else:
                where_clause = and_(
                    CostAnalytics.model.like(f"{provider}/%"),
                    extract('year', CostAnalytics.created_at) == now.year,
                    extract('month', CostAnalytics.created_at) == now.month,
                )
            result = await session.execute(select(func.sum(CostAnalytics.cost)).where(where_clause))
            return float(result.scalar() or 0.0)
        except Exception as e:
            logger.error(f"Error getting provider cost: {e}")
            return 0.0

    async def check_all_budgets(self, session: AsyncSession) -> dict:
        """Check global + per-provider budgets. Returns alerts and block status."""
        alerts = []
        should_block = False
        block_reason = ""

        # Global budget
        budget = await self.get_budget_settings(session)
        monthly_cost = await self.get_monthly_cost(session)
        weekly_cost = await self.get_weekly_budget_cost(session)

        for label, cost, limit in [
            ("Global mensuel", monthly_cost, budget.get("monthly_limit")),
            ("Global hebdo", weekly_cost, budget.get("weekly_limit")),
        ]:
            if not limit:
                continue
            pct = (cost / limit) * 100
            if pct >= 100:
                alerts.append({"level": 100, "scope": label, "percent": round(pct, 1), "cost": round(cost, 4), "limit": limit})
                if budget.get("block_on_limit"):
                    should_block = True
                    block_reason = f"{label}: ${cost:.4f} / ${limit:.2f}"
            elif pct >= 80:
                alerts.append({"level": 80, "scope": label, "percent": round(pct, 1), "cost": round(cost, 4), "limit": limit})

        # Provider budgets
        provider_budgets = await self.get_provider_budgets(session)
        for pb in provider_budgets:
            for label_suffix, period_key, limit_key in [("mensuel", "month", "monthly_limit"), ("hebdo", "week", "weekly_limit")]:
                limit = pb.get(limit_key)
                if not limit:
                    continue
                cost = await self.get_provider_cost(session, pb["provider"], period_key)
                pct = (cost / limit) * 100
                scope = f"{pb['provider']} {label_suffix}"
                if pct >= 100:
                    alerts.append({"level": 100, "scope": scope, "percent": round(pct, 1), "cost": round(cost, 4), "limit": limit})
                    should_block = True
                    block_reason = block_reason or f"{scope}: ${cost:.4f} / ${limit:.2f}"
                elif pct >= 80:
                    alerts.append({"level": 80, "scope": scope, "percent": round(pct, 1), "cost": round(cost, 4), "limit": limit})

        return {"alerts": alerts, "should_block": should_block, "block_reason": block_reason}


_cost_manager_instance = None

def get_cost_manager():
    global _cost_manager_instance
    if _cost_manager_instance is None:
        _cost_manager_instance = CostManager()
    return _cost_manager_instance