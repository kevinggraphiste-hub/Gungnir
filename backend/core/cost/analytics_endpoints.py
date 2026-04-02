# Analytics & Cost Tracking Endpoints for OpenClaude

These are the analytics endpoints that need to be added to routes.py:

```python
# Analytics & Cost Tracking

@router.get("/analytics/summary")
async def analytics_summary(session: AsyncSession = Depends(get_session)):
    """Get overall cost and usage summary."""
    from backend.core.cost.manager import get_cost_manager
    cost_manager = get_cost_manager()
    return await cost_manager.get_summary(session)


@router.get("/analytics/by-model")
async def analytics_by_model(session: AsyncSession = Depends(get_session)):
    """Get cost breakdown by model."""
    from backend.core.cost.manager import get_cost_manager
    cost_manager = get_cost_manager()
    return {"models": await cost_manager.get_costs_by_model(session)}


@router.get("/analytics/by-day")
async def analytics_by_day(days: int = 30, session: AsyncSession = Depends(get_session)):
    """Get daily costs for the last N days."""
    from backend.core.cost.manager import get_cost_manager
    cost_manager = get_cost_manager()
    return {"daily": await cost_manager.get_daily_costs(session, days)}


@router.get("/analytics/budget")
async def get_budget(session: AsyncSession = Depends(get_session)):
    """Get current budget settings."""
    from backend.core.cost.manager import get_cost_manager
    cost_manager = get_cost_manager()
    budget_settings = await cost_manager.get_budget_settings(session)
    monthly_cost = await cost_manager.get_monthly_cost(session)
    
    return {
        "settings": budget_settings,
        "current_month_cost": monthly_cost,
        "percentage_used": (monthly_cost / budget_settings["monthly_limit"] * 100) if budget_settings.get("monthly_limit") else 0
    }


@router.put("/analytics/budget")
async def update_budget(budget_data: dict, session: AsyncSession = Depends(get_session)):
    """Update budget settings."""
    from backend.core.cost.manager import get_cost_manager
    cost_manager = get_cost_manager()
    result = await cost_manager.update_budget_settings(session, budget_data)
    return result


@router.get("/analytics/conversations")
async def analytics_conversations(limit: int = 100, session: AsyncSession = Depends(get_session)):
    """Get cost breakdown by conversation."""
    from backend.core.cost.manager import get_cost_manager
    cost_manager = get_cost_manager()
    return {"conversations": await cost_manager.get_conversation_costs(session, limit)}


@router.get("/analytics/check-budget")
async def check_budget(session: AsyncSession = Depends(get_session)):
    """Check if budget alerts should be triggered."""
    from backend.core.cost.manager import get_cost_manager
    cost_manager = get_cost_manager()
    alerts = await cost_manager.check_budget_alerts(session)
    should_block, reason = await cost_manager.should_block_requests(session)
    
    return {
        "alerts": alerts,
        "should_block": should_block,
        "block_reason": reason
    }
```

To add these to routes.py:
1. Open backend\api\routes.py
2. Go to the end of the file (around line 2661)
3. Add the endpoints above