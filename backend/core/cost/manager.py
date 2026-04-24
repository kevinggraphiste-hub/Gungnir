from datetime import datetime, timedelta
from typing import Optional, List
from sqlalchemy import select, func, and_, extract, cast, Date
from sqlalchemy.ext.asyncio import AsyncSession
from backend.core.db.models import CostAnalytics, BudgetSettings, ProviderBudget, Conversation
from backend.core.cost.calculator import calculate_cost, extract_model_from_response
import logging

logger = logging.getLogger(__name__)


def _user_scope(query, user_id: Optional[int]):
    """Add a user_id filter to a CostAnalytics query. None = no scope (legacy admin)."""
    if user_id is None:
        return query
    return query.where(CostAnalytics.user_id == int(user_id))


class CostManager:
    """Per-user cost tracking and budget enforcement.

    Every query accepts a ``user_id`` argument (Optional[int]). Passing None
    returns data across all users — reserved for admin dashboards only. Chat
    and scheduler call sites must always pass the authenticated user_id.
    """

    def __init__(self):
        pass

    async def _resolve_pricing(self, model: str) -> tuple[str, float, float] | None:
        """Try to resolve model ID + prices from the live OpenRouter catalog.

        Returns (canonical_id, input_$_per_1M, output_$_per_1M) or None if the
        catalog is unreachable or the model isn't listed. This is the single
        source of truth for every OpenRouter-routed call : the model keeps its
        real ID (no lumping) and the price is the current one, no hardcoding.
        """
        if not model:
            return None
        try:
            from backend.plugins.model_guide.routes import _fetch_openrouter_models
            catalog = await _fetch_openrouter_models()
        except Exception:
            return None
        if not catalog:
            return None
        name = model.lower()
        # Direct match by ID (e.g. "xiaomi/mimo-v2-omni")
        entry = catalog.get(model) or catalog.get(name)
        if entry is None:
            # Match suffix : provider retourne parfois juste "gpt-4o-mini"
            for mid, info in catalog.items():
                if mid.lower() == name or mid.lower().endswith("/" + name):
                    entry = info
                    model = mid
                    break
        if entry is None:
            return None
        return (model, float(entry.get("input_1m", 0)), float(entry.get("output_1m", 0)))

    async def record_message_cost(
        self,
        session: AsyncSession,
        conversation_id: int,
        model: str,
        tokens_input: int,
        tokens_output: int,
        message_date: Optional[datetime] = None,
        user_id: Optional[int] = None,
    ) -> float:
        """Record cost for a message and return the calculated cost."""
        try:
            # 1) Source dynamique : catalogue OpenRouter (identité + prix réels)
            dyn = await self._resolve_pricing(model)
            if dyn is not None:
                standardized_model, in_p, out_p = dyn
                cost = (tokens_input / 1_000_000) * in_p + (tokens_output / 1_000_000) * out_p
            else:
                # 2) Fallback : liste statique MODEL_PRICING (modèles hors catalogue)
                standardized_model = extract_model_from_response(model)
                cost = calculate_cost(standardized_model, tokens_input, tokens_output)

            record_date = message_date.date() if message_date else datetime.utcnow().date()

            # If user_id wasn't passed explicitly, resolve it from the conversation
            resolved_user_id = user_id
            if resolved_user_id is None and conversation_id is not None:
                conv = await session.get(Conversation, conversation_id)
                if conv and conv.user_id is not None:
                    resolved_user_id = conv.user_id

            analytics_record = CostAnalytics(
                user_id=resolved_user_id,
                date=record_date,
                conversation_id=conversation_id,
                model=standardized_model,
                tokens_input=tokens_input,
                tokens_output=tokens_output,
                cost=cost,
            )

            session.add(analytics_record)
            await session.commit()

            return cost

        except Exception as e:
            logger.error(f"Error recording cost: {e}")
            await session.rollback()
            return 0.0

    async def record_image_cost(
        self,
        session: AsyncSession,
        conversation_id: int | None,
        model: str,
        n: int = 1,
        size: str = "1024x1024",
        quality: str | None = None,
        user_id: Optional[int] = None,
    ) -> float:
        """Enregistre le coût d'une génération d'image dans CostAnalytics.

        Les images n'ont pas de tokens (au sens texte), on utilise le helper
        `get_image_cost` qui applique les tarifs par image + multiplicateurs
        de taille/quality. tokens_input/output sont à 0 — la colonne `cost` et
        `model` permettent de filtrer/agréger côté analytics.
        """
        from backend.core.cost.calculator import get_image_cost
        try:
            cost = get_image_cost(model, n=n, size=size, quality=quality)
            resolved_user_id = user_id
            if resolved_user_id is None and conversation_id is not None:
                conv = await session.get(Conversation, conversation_id)
                if conv and conv.user_id is not None:
                    resolved_user_id = conv.user_id
            record = CostAnalytics(
                user_id=resolved_user_id,
                date=datetime.utcnow().date(),
                conversation_id=conversation_id,
                model=model,
                tokens_input=0,
                tokens_output=0,
                cost=cost,
            )
            session.add(record)
            await session.commit()
            return cost
        except Exception as e:
            logger.error(f"Error recording image cost: {e}")
            try:
                await session.rollback()
            except Exception:
                pass
            return 0.0

    async def get_summary(self, session: AsyncSession, user_id: Optional[int] = None) -> dict:
        """Get cost and usage summary scoped to a user (or global if None)."""
        try:
            q = select(
                func.sum(CostAnalytics.cost).label("total_cost"),
                func.sum(CostAnalytics.tokens_input).label("total_input_tokens"),
                func.sum(CostAnalytics.tokens_output).label("total_output_tokens"),
                func.count().label("message_count"),
            )
            result = await session.execute(_user_scope(q, user_id))
            data = result.first()

            total_cost = float(data.total_cost or 0.0)
            total_tokens = int(data.total_input_tokens or 0) + int(data.total_output_tokens or 0)
            message_count = int(data.message_count or 0)

            avg_cost_per_message = total_cost / message_count if message_count > 0 else 0.0

            return {
                "total_cost": round(total_cost, 4),
                "total_tokens": total_tokens,
                "message_count": message_count,
                "avg_cost_per_message": round(avg_cost_per_message, 4),
            }
        except Exception as e:
            logger.error(f"Error getting summary: {e}")
            return {
                "total_cost": 0.0,
                "total_tokens": 0,
                "message_count": 0,
                "avg_cost_per_message": 0.0,
            }

    async def get_costs_by_model(self, session: AsyncSession, user_id: Optional[int] = None) -> List[dict]:
        """Get cost breakdown by model for a user."""
        try:
            q = (
                select(
                    CostAnalytics.model,
                    func.sum(CostAnalytics.cost).label("total_cost"),
                    func.sum(CostAnalytics.tokens_input + CostAnalytics.tokens_output).label("total_tokens"),
                    func.count().label("message_count"),
                )
                .group_by(CostAnalytics.model)
                .order_by(func.sum(CostAnalytics.cost).desc())
            )
            result = await session.execute(_user_scope(q, user_id))

            return [
                {
                    "model": row.model,
                    "total_cost": round(float(row.total_cost), 4),
                    "total_tokens": int(row.total_tokens or 0),
                    "message_count": int(row.message_count or 0),
                }
                for row in result.all()
            ]
        except Exception as e:
            logger.error(f"Error getting costs by model: {e}")
            return []

    async def get_daily_costs(self, session: AsyncSession, days: int = 30, user_id: Optional[int] = None) -> List[dict]:
        """Get daily costs for the last N days (per user)."""
        try:
            since = datetime.utcnow() - timedelta(days=days)
            day_col = cast(CostAnalytics.created_at, Date)
            q = (
                select(
                    day_col.label("date"),
                    func.sum(CostAnalytics.cost).label("daily_cost"),
                    func.sum(CostAnalytics.tokens_input + CostAnalytics.tokens_output).label("daily_tokens"),
                )
                .where(CostAnalytics.created_at >= since)
                .group_by(day_col)
                .order_by(day_col)
            )
            result = await session.execute(_user_scope(q, user_id))

            return [
                {
                    "date": str(row.date),
                    "cost": round(float(row.daily_cost), 4),
                    "tokens": int(row.daily_tokens or 0),
                }
                for row in result.all()
            ]
        except Exception as e:
            logger.error(f"Error getting daily costs: {e}")
            return []

    async def get_monthly_cost(
        self,
        session: AsyncSession,
        year: Optional[int] = None,
        month: Optional[int] = None,
        user_id: Optional[int] = None,
    ) -> float:
        """Get total cost for a specific month (per user)."""
        try:
            now = datetime.utcnow()
            year = year or now.year
            month = month or now.month

            q = select(func.sum(CostAnalytics.cost)).where(
                and_(
                    extract("year", CostAnalytics.created_at) == year,
                    extract("month", CostAnalytics.created_at) == month,
                )
            )
            result = await session.execute(_user_scope(q, user_id))

            total = result.scalar() or 0.0
            return float(total)

        except Exception as e:
            logger.error(f"Error getting monthly cost: {e}")
            return 0.0

    async def check_budget_alerts(self, session: AsyncSession, user_id: Optional[int] = None) -> List[dict]:
        """Check if budget alerts should be triggered for a user."""
        try:
            budget = await self.get_budget_settings(session, user_id=user_id)

            if not budget.get("monthly_limit"):
                return []

            monthly_cost = await self.get_monthly_cost(session, user_id=user_id)
            limit = budget["monthly_limit"]

            alerts = []
            percentage = (monthly_cost / limit) * 100 if limit > 0 else 0

            if percentage >= 100 and budget.get("alert_100", True):
                alerts.append({
                    "level": 100,
                    "message": f"Budget limit reached! ${monthly_cost:.2f} / ${limit:.2f} ({percentage:.1f}%)",
                    "should_block": budget.get("block_on_limit", False),
                })
            elif percentage >= 90 and budget.get("alert_90", True):
                alerts.append({
                    "level": 90,
                    "message": f"Budget 90% reached: ${monthly_cost:.2f} / ${limit:.2f} ({percentage:.1f}%)",
                    "should_block": False,
                })
            elif percentage >= 80 and budget.get("alert_80", True):
                alerts.append({
                    "level": 80,
                    "message": f"Budget 80% reached: ${monthly_cost:.2f} / ${limit:.2f} ({percentage:.1f}%)",
                    "should_block": False,
                })

            return alerts

        except Exception as e:
            logger.error(f"Error checking budget alerts: {e}")
            return []

    async def should_block_requests(self, session: AsyncSession, user_id: Optional[int] = None) -> tuple[bool, str]:
        """Check if new requests should be blocked for a user due to budget limit."""
        try:
            budget = await self.get_budget_settings(session, user_id=user_id)

            if not budget.get("monthly_limit") or not budget.get("block_on_limit", False):
                return False, ""

            monthly_cost = await self.get_monthly_cost(session, user_id=user_id)
            limit = budget["monthly_limit"]

            if monthly_cost >= limit:
                return True, f"Monthly budget limit reached: ${monthly_cost:.2f} / ${limit:.2f}"

            return False, ""

        except Exception as e:
            logger.error(f"Error checking request blocking: {e}")
            return False, ""

    async def get_budget_settings(self, session: AsyncSession, user_id: Optional[int] = None) -> dict:
        """Get the budget settings row for a user (most recent if multiple)."""
        default = {
            "monthly_limit": None,
            "weekly_limit": None,
            "alert_80": True,
            "alert_90": True,
            "alert_100": True,
            "block_on_limit": False,
        }
        try:
            q = select(BudgetSettings).order_by(BudgetSettings.updated_at.desc()).limit(1)
            if user_id is not None:
                q = q.where(BudgetSettings.user_id == int(user_id))
            result = await session.execute(q)
            settings = result.scalar_one_or_none()

            if not settings:
                return default

            return {
                "monthly_limit": float(settings.monthly_limit) if settings.monthly_limit else None,
                "weekly_limit": float(settings.weekly_limit) if settings.weekly_limit else None,
                "alert_80": settings.alert_80,
                "alert_90": settings.alert_90,
                "alert_100": settings.alert_100,
                "block_on_limit": settings.block_on_limit,
            }

        except Exception as e:
            logger.error(f"Error getting budget settings: {e}")
            return default

    async def update_budget_settings(self, session: AsyncSession, settings: dict, user_id: Optional[int] = None) -> dict:
        """Upsert the budget settings row for a user."""
        try:
            if user_id is None:
                # No scope provided — keep legacy single-row append behaviour
                budget_settings = BudgetSettings(
                    user_id=None,
                    monthly_limit=float(settings.get("monthly_limit")) if settings.get("monthly_limit") else None,
                    weekly_limit=float(settings.get("weekly_limit")) if settings.get("weekly_limit") else None,
                    alert_80=settings.get("alert_80", True),
                    alert_90=settings.get("alert_90", True),
                    alert_100=settings.get("alert_100", True),
                    block_on_limit=settings.get("block_on_limit", False),
                )
                session.add(budget_settings)
                await session.commit()
                return {"success": True, "settings": settings}

            uid = int(user_id)
            # Update existing row for this user, or create a new one
            result = await session.execute(
                select(BudgetSettings).where(BudgetSettings.user_id == uid).order_by(BudgetSettings.id.desc()).limit(1)
            )
            row = result.scalar_one_or_none()
            if row is None:
                row = BudgetSettings(user_id=uid)
                session.add(row)

            row.monthly_limit = float(settings.get("monthly_limit")) if settings.get("monthly_limit") else None
            row.weekly_limit = float(settings.get("weekly_limit")) if settings.get("weekly_limit") else None
            row.alert_80 = settings.get("alert_80", True)
            row.alert_90 = settings.get("alert_90", True)
            row.alert_100 = settings.get("alert_100", True)
            row.block_on_limit = settings.get("block_on_limit", False)
            await session.commit()

            return {
                "success": True,
                "settings": {
                    "monthly_limit": row.monthly_limit,
                    "weekly_limit": row.weekly_limit,
                    "alert_80": row.alert_80,
                    "alert_90": row.alert_90,
                    "alert_100": row.alert_100,
                    "block_on_limit": row.block_on_limit,
                },
            }

        except Exception as e:
            logger.error(f"Error updating budget settings: {e}")
            await session.rollback()
            return {"success": False, "error": str(e)}

    async def get_conversation_costs(self, session: AsyncSession, limit: int = 100, user_id: Optional[int] = None) -> List[dict]:
        """Get cost breakdown by conversation for a user."""
        try:
            q = (
                select(
                    Conversation.id,
                    Conversation.title,
                    func.sum(CostAnalytics.cost).label("total_cost"),
                    func.sum(CostAnalytics.tokens_input + CostAnalytics.tokens_output).label("total_tokens"),
                    func.count(CostAnalytics.id).label("message_count"),
                    func.max(CostAnalytics.created_at).label("last_message"),
                )
                .join(CostAnalytics, CostAnalytics.conversation_id == Conversation.id)
                .group_by(Conversation.id, Conversation.title)
                .order_by(func.max(CostAnalytics.created_at).desc())
                .limit(limit)
            )
            if user_id is not None:
                q = q.where(Conversation.user_id == int(user_id))
            result = await session.execute(q)

            return [
                {
                    "conversation_id": row.id,
                    "title": row.title,
                    "total_cost": round(float(row.total_cost), 4),
                    "total_tokens": int(row.total_tokens or 0),
                    "message_count": int(row.message_count or 0),
                    "last_message": str(row.last_message) if row.last_message else None,
                }
                for row in result.all()
            ]
        except Exception as e:
            logger.error(f"Error getting conversation costs: {e}")
            return []

    async def get_costs_by_provider(self, session: AsyncSession, user_id: Optional[int] = None) -> List[dict]:
        """Get cost breakdown by provider (extracted from model name)."""
        try:
            models = await self.get_costs_by_model(session, user_id=user_id)
            providers: dict = {}
            for m in models:
                provider = m["model"].split("/")[0] if "/" in m["model"] else "other"
                if provider not in providers:
                    providers[provider] = {
                        "provider": provider,
                        "total_cost": 0.0,
                        "total_tokens": 0,
                        "message_count": 0,
                    }
                providers[provider]["total_cost"] = round(providers[provider]["total_cost"] + m["total_cost"], 4)
                providers[provider]["total_tokens"] += m["total_tokens"]
                providers[provider]["message_count"] += m["message_count"]
            return sorted(providers.values(), key=lambda x: x["total_cost"], reverse=True)
        except Exception as e:
            logger.error(f"Error getting costs by provider: {e}")
            return []

    async def get_weekly_costs(self, session: AsyncSession, weeks: int = 12, user_id: Optional[int] = None) -> List[dict]:
        """Get weekly costs for the last N weeks (per user)."""
        try:
            since = datetime.utcnow() - timedelta(weeks=weeks)
            yr = extract("year", CostAnalytics.created_at)
            wk = extract("week", CostAnalytics.created_at)
            q = (
                select(
                    yr.label("yr"),
                    wk.label("wk"),
                    func.sum(CostAnalytics.cost).label("weekly_cost"),
                    func.sum(CostAnalytics.tokens_input + CostAnalytics.tokens_output).label("weekly_tokens"),
                    func.count().label("message_count"),
                )
                .where(CostAnalytics.created_at >= since)
                .group_by(yr, wk)
                .order_by(yr, wk)
            )
            result = await session.execute(_user_scope(q, user_id))
            return [
                {
                    "week": f"{int(row.yr)}-W{int(row.wk):02d}",
                    "cost": round(float(row.weekly_cost), 4),
                    "tokens": int(row.weekly_tokens or 0),
                    "messages": int(row.message_count or 0),
                }
                for row in result.all()
            ]
        except Exception as e:
            logger.error(f"Error getting weekly costs: {e}")
            return []

    async def get_monthly_costs(self, session: AsyncSession, months: int = 12, user_id: Optional[int] = None) -> List[dict]:
        """Get monthly costs for the last N months (per user)."""
        try:
            since = datetime.utcnow() - timedelta(days=months * 31)
            yr = extract("year", CostAnalytics.created_at)
            mo = extract("month", CostAnalytics.created_at)
            q = (
                select(
                    yr.label("yr"),
                    mo.label("mo"),
                    func.sum(CostAnalytics.cost).label("monthly_cost"),
                    func.sum(CostAnalytics.tokens_input + CostAnalytics.tokens_output).label("monthly_tokens"),
                    func.count().label("message_count"),
                )
                .where(CostAnalytics.created_at >= since)
                .group_by(yr, mo)
                .order_by(yr, mo)
            )
            result = await session.execute(_user_scope(q, user_id))
            return [
                {
                    "month": f"{int(row.yr)}-{int(row.mo):02d}",
                    "cost": round(float(row.monthly_cost), 4),
                    "tokens": int(row.monthly_tokens or 0),
                    "messages": int(row.message_count or 0),
                }
                for row in result.all()
            ]
        except Exception as e:
            logger.error(f"Error getting monthly costs: {e}")
            return []

    async def get_yearly_costs(self, session: AsyncSession, user_id: Optional[int] = None) -> List[dict]:
        """Get yearly cost breakdown (per user)."""
        try:
            yr = extract("year", CostAnalytics.created_at)
            q = (
                select(
                    yr.label("yr"),
                    func.sum(CostAnalytics.cost).label("yearly_cost"),
                    func.sum(CostAnalytics.tokens_input + CostAnalytics.tokens_output).label("yearly_tokens"),
                    func.count().label("message_count"),
                )
                .group_by(yr)
                .order_by(yr)
            )
            result = await session.execute(_user_scope(q, user_id))
            return [
                {
                    "year": str(int(row.yr)),
                    "cost": round(float(row.yearly_cost), 4),
                    "tokens": int(row.yearly_tokens or 0),
                    "messages": int(row.message_count or 0),
                }
                for row in result.all()
            ]
        except Exception as e:
            logger.error(f"Error getting yearly costs: {e}")
            return []

    async def get_heatmap_data(self, session: AsyncSession, days: int = 90, user_id: Optional[int] = None) -> List[dict]:
        """Get activity heatmap data per user."""
        try:
            since = datetime.utcnow() - timedelta(days=days)
            day_col = cast(CostAnalytics.created_at, Date)
            q = (
                select(
                    day_col.label("date"),
                    func.count().label("count"),
                    func.sum(CostAnalytics.cost).label("cost"),
                )
                .where(CostAnalytics.created_at >= since)
                .group_by(day_col)
                .order_by(day_col)
            )
            result = await session.execute(_user_scope(q, user_id))
            return [
                {"date": str(row.date), "count": int(row.count), "cost": round(float(row.cost), 4)}
                for row in result.all()
            ]
        except Exception as e:
            logger.error(f"Error getting heatmap data: {e}")
            return []

    async def get_weekly_budget_cost(self, session: AsyncSession, user_id: Optional[int] = None) -> float:
        """Get total cost for the current week (Monday to Sunday) per user."""
        try:
            now = datetime.utcnow()
            week_start = now - timedelta(days=now.weekday())
            week_start = week_start.replace(hour=0, minute=0, second=0, microsecond=0)
            q = select(func.sum(CostAnalytics.cost)).where(CostAnalytics.created_at >= week_start)
            result = await session.execute(_user_scope(q, user_id))
            return float(result.scalar() or 0.0)
        except Exception as e:
            logger.error(f"Error getting weekly cost: {e}")
            return 0.0

    async def get_provider_budgets(self, session: AsyncSession, user_id: Optional[int] = None) -> List[dict]:
        """Get provider-specific budget rows for a user."""
        try:
            q = select(ProviderBudget).order_by(ProviderBudget.provider)
            if user_id is not None:
                q = q.where(ProviderBudget.user_id == int(user_id))
            result = await session.execute(q)
            return [
                {
                    "id": pb.id,
                    "provider": pb.provider,
                    "monthly_limit": float(pb.monthly_limit) if pb.monthly_limit else None,
                    "weekly_limit": float(pb.weekly_limit) if pb.weekly_limit else None,
                    "block_on_limit": bool(pb.block_on_limit),
                }
                for pb in result.scalars().all()
            ]
        except Exception as e:
            logger.error(f"Error getting provider budgets: {e}")
            return []

    async def upsert_provider_budget(
        self,
        session: AsyncSession,
        provider: str,
        monthly_limit: float = None,
        weekly_limit: float = None,
        user_id: Optional[int] = None,
        block_on_limit: Optional[bool] = None,
    ) -> dict:
        """Create or update a provider budget for a user."""
        try:
            q = select(ProviderBudget).where(ProviderBudget.provider == provider)
            if user_id is not None:
                q = q.where(ProviderBudget.user_id == int(user_id))
            result = await session.execute(q)
            pb = result.scalar_one_or_none()
            if pb:
                pb.monthly_limit = monthly_limit
                pb.weekly_limit = weekly_limit
                if block_on_limit is not None:
                    pb.block_on_limit = bool(block_on_limit)
            else:
                pb = ProviderBudget(
                    user_id=int(user_id) if user_id is not None else None,
                    provider=provider,
                    monthly_limit=monthly_limit,
                    weekly_limit=weekly_limit,
                    block_on_limit=bool(block_on_limit) if block_on_limit is not None else False,
                )
                session.add(pb)
            await session.commit()
            return {"success": True, "provider": provider}
        except Exception as e:
            logger.error(f"Error upserting provider budget: {e}")
            await session.rollback()
            return {"success": False, "error": str(e)}

    async def delete_provider_budget(self, session: AsyncSession, provider: str, user_id: Optional[int] = None) -> dict:
        """Delete a provider budget for a user."""
        try:
            q = select(ProviderBudget).where(ProviderBudget.provider == provider)
            if user_id is not None:
                q = q.where(ProviderBudget.user_id == int(user_id))
            result = await session.execute(q)
            pb = result.scalar_one_or_none()
            if pb:
                await session.delete(pb)
                await session.commit()
            return {"success": True}
        except Exception as e:
            logger.error(f"Error deleting provider budget: {e}")
            await session.rollback()
            return {"success": False, "error": str(e)}

    async def get_provider_cost(
        self,
        session: AsyncSession,
        provider: str,
        period: str = "month",
        user_id: Optional[int] = None,
    ) -> float:
        """Get total cost for a provider in the current week or month (per user)."""
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
                    extract("year", CostAnalytics.created_at) == now.year,
                    extract("month", CostAnalytics.created_at) == now.month,
                )
            q = select(func.sum(CostAnalytics.cost)).where(where_clause)
            result = await session.execute(_user_scope(q, user_id))
            return float(result.scalar() or 0.0)
        except Exception as e:
            logger.error(f"Error getting provider cost: {e}")
            return 0.0

    async def check_all_budgets(self, session: AsyncSession, user_id: Optional[int] = None) -> dict:
        """Check global + per-provider budgets for a user. Returns alerts and block status."""
        alerts = []
        should_block = False
        block_reason = ""

        # Global budget (for this user)
        budget = await self.get_budget_settings(session, user_id=user_id)
        monthly_cost = await self.get_monthly_cost(session, user_id=user_id)
        weekly_cost = await self.get_weekly_budget_cost(session, user_id=user_id)

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

        # Provider budgets (for this user)
        provider_budgets = await self.get_provider_budgets(session, user_id=user_id)
        for pb in provider_budgets:
            for label_suffix, period_key, limit_key in [
                ("mensuel", "month", "monthly_limit"),
                ("hebdo", "week", "weekly_limit"),
            ]:
                limit = pb.get(limit_key)
                if not limit:
                    continue
                cost = await self.get_provider_cost(session, pb["provider"], period_key, user_id=user_id)
                pct = (cost / limit) * 100
                scope = f"{pb['provider']} {label_suffix}"
                if pct >= 100:
                    alerts.append({"level": 100, "scope": scope, "percent": round(pct, 1), "cost": round(cost, 4), "limit": limit})
                    if pb.get("block_on_limit"):
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
