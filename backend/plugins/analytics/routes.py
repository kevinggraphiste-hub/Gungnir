"""
Gungnir Plugin — Analytics Routes

17 endpoints for cost tracking, trends, budgets, and exports.
Self-contained — delegates to CostManager, uses core DB session.
Per-user filtering via ?user_id= query param.
"""
import csv
import io
import json as _json
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse, HTMLResponse
from pydantic import BaseModel

from backend.core.db.engine import async_session
from .manager import get_cost_manager

logger = logging.getLogger("gungnir.plugins.analytics")
router = APIRouter()
cm = get_cost_manager()


def _caller_user_id(request: Request) -> Optional[int]:
    """Resolve the authenticated user_id from request.state. Any `user_id`
    query parameter is intentionally ignored to prevent one user from reading
    another user's cost data by spoofing localStorage."""
    uid = getattr(request.state, "user_id", None)
    return int(uid) if uid else None


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
async def get_summary(request: Request):
    uid = _caller_user_id(request)
    try:
        async with async_session() as session:
            return await cm.get_summary(session, uid)
    except Exception as e:
        logger.error(f"Summary endpoint error: {e}")
        return {"total_cost": 0, "total_tokens": 0, "message_count": 0, "avg_cost_per_message": 0}


# ── Breakdowns ────────────────────────────────────────────────────────────────

@router.get("/by-model")
async def get_by_model(request: Request):
    uid = _caller_user_id(request)
    try:
        async with async_session() as session:
            return await cm.get_by_model(session, uid)
    except Exception as e:
        logger.error(f"By-model error: {e}")
        return []


@router.get("/by-provider")
async def get_by_provider(request: Request):
    uid = _caller_user_id(request)
    try:
        async with async_session() as session:
            return await cm.get_by_provider(session, uid)
    except Exception as e:
        logger.error(f"By-provider error: {e}")
        return []


# ── Time series ───────────────────────────────────────────────────────────────

@router.get("/by-day")
async def get_by_day(request: Request, days: int = Query(30, ge=1, le=365)):
    uid = _caller_user_id(request)
    try:
        async with async_session() as session:
            return await cm.get_daily(session, days, uid)
    except Exception as e:
        logger.error(f"By-day error: {e}")
        return []


@router.get("/by-week")
async def get_by_week(request: Request, weeks: int = Query(12, ge=1, le=104)):
    uid = _caller_user_id(request)
    try:
        async with async_session() as session:
            return await cm.get_weekly(session, weeks, uid)
    except Exception as e:
        logger.error(f"By-week error: {e}")
        return []


@router.get("/by-month")
async def get_by_month(request: Request, months: int = Query(12, ge=1, le=60)):
    uid = _caller_user_id(request)
    try:
        async with async_session() as session:
            return await cm.get_monthly(session, months, uid)
    except Exception as e:
        logger.error(f"By-month error: {e}")
        return []


@router.get("/by-year")
async def get_by_year(request: Request):
    uid = _caller_user_id(request)
    try:
        async with async_session() as session:
            return await cm.get_yearly(session, uid)
    except Exception as e:
        logger.error(f"By-year error: {e}")
        return []


# ── Heatmap ───────────────────────────────────────────────────────────────────

@router.get("/heatmap")
async def get_heatmap(request: Request, days: int = Query(90, ge=1, le=365)):
    uid = _caller_user_id(request)
    try:
        async with async_session() as session:
            return await cm.get_heatmap(session, days, uid)
    except Exception as e:
        logger.error(f"Heatmap error: {e}")
        return []


# ── Conversations ─────────────────────────────────────────────────────────────

@router.get("/conversations")
async def get_conversations(request: Request, limit: int = Query(50, ge=1, le=200)):
    uid = _caller_user_id(request)
    try:
        async with async_session() as session:
            return await cm.get_conversations(session, limit, uid)
    except Exception as e:
        logger.error(f"Conversations error: {e}")
        return []


# ── Budget ────────────────────────────────────────────────────────────────────

@router.get("/budget")
async def get_budget(request: Request):
    uid = _caller_user_id(request)
    try:
        async with async_session() as session:
            return await cm.get_budget(session, user_id=uid)
    except Exception as e:
        logger.error(f"Get budget error: {e}")
        return {}


@router.put("/budget")
async def update_budget(data: BudgetUpdate, request: Request):
    uid = _caller_user_id(request)
    try:
        async with async_session() as session:
            return await cm.update_budget(session, data.model_dump(), user_id=uid)
    except Exception as e:
        logger.error(f"Update budget error: {e}")
        return {"success": False, "error": str(e)}


@router.get("/check-budget")
async def check_budget(request: Request):
    uid = _caller_user_id(request)
    try:
        async with async_session() as session:
            return await cm.check_budgets(session, uid)
    except Exception as e:
        logger.error(f"Check budget error: {e}")
        return {"alerts": [], "should_block": False, "block_reason": ""}


# ── Provider budgets ──────────────────────────────────────────────────────────

@router.get("/provider-budgets")
async def get_provider_budgets(request: Request):
    uid = _caller_user_id(request)
    try:
        async with async_session() as session:
            return await cm.get_provider_budgets(session, user_id=uid)
    except Exception as e:
        logger.error(f"Provider budgets error: {e}")
        return []


@router.put("/provider-budgets/{provider}")
async def upsert_provider_budget(provider: str, data: ProviderBudgetUpdate, request: Request):
    uid = _caller_user_id(request)
    try:
        async with async_session() as session:
            return await cm.upsert_provider_budget(
                session, provider, data.monthly_limit, data.weekly_limit, user_id=uid
            )
    except Exception as e:
        logger.error(f"Upsert provider budget error: {e}")
        return {"success": False, "error": str(e)}


@router.delete("/provider-budgets/{provider}")
async def delete_provider_budget(provider: str, request: Request):
    uid = _caller_user_id(request)
    try:
        async with async_session() as session:
            return await cm.delete_provider_budget(session, provider, user_id=uid)
    except Exception as e:
        logger.error(f"Delete provider budget error: {e}")
        return {"success": False, "error": str(e)}


# ── Export ────────────────────────────────────────────────────────────────────

@router.get("/export")
async def export_csv(request: Request):
    """Export the current user's cost records as CSV."""
    uid = _caller_user_id(request)
    try:
        async with async_session() as session:
            records = await cm.get_user_records(session, uid)

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


# ── Helper: gather full export data ──────────────────────────────────────────

async def _gather_export_data(user_id: Optional[int] = None) -> dict:
    """Gather summary, by-model, by-provider, daily and records for export."""
    async with async_session() as session:
        summary = await cm.get_summary(session, user_id)
        by_model = await cm.get_by_model(session, user_id)
        by_provider = await cm.get_by_provider(session, user_id)
        daily = await cm.get_daily(session, 30, user_id)
        records = await cm.get_user_records(session, user_id)
    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "summary": summary,
        "by_model": by_model,
        "by_provider": by_provider,
        "daily_30d": daily,
        "records": [
            {
                "date": str(r.date), "model": r.model,
                "tokens_input": r.tokens_input, "tokens_output": r.tokens_output,
                "cost": round(r.cost, 6), "conversation_id": r.conversation_id or "",
            }
            for r in records
        ],
    }


# ── Export JSON ──────────────────────────────────────────────────────────────

@router.get("/export/json")
async def export_json(request: Request):
    """Export the current user's analytics as structured JSON."""
    uid = _caller_user_id(request)
    try:
        data = await _gather_export_data(uid)
        content = _json.dumps(data, indent=2, ensure_ascii=False)
        return StreamingResponse(
            iter([content]),
            media_type="application/json",
            headers={"Content-Disposition": "attachment; filename=gungnir_analytics.json"},
        )
    except Exception as e:
        logger.error(f"Export JSON error: {e}")
        return {"error": str(e)}


# ── Export Markdown ──────────────────────────────────────────────────────────

@router.get("/export/md")
async def export_markdown(request: Request):
    """Export the current user's analytics as Markdown report."""
    uid = _caller_user_id(request)
    try:
        data = await _gather_export_data(uid)
        s = data["summary"]
        md = f"""# Gungnir Analytics Report
> Generated: {data['generated_at']}

---

## Summary

| Metric | Value |
|--------|-------|
| Total Cost | ${s.get('total_cost', 0):.4f} |
| Total Tokens | {s.get('total_tokens', 0):,} |
| Messages | {s.get('message_count', 0):,} |
| Avg Cost/Message | ${s.get('avg_cost_per_message', 0):.6f} |

## Cost by Provider

| Provider | Cost | Tokens | Messages |
|----------|------|--------|----------|
"""
        for p in data["by_provider"]:
            md += f"| {p['provider']} | ${p['total_cost']:.4f} | {p['total_tokens']:,} | {p['message_count']} |\n"

        md += "\n## Cost by Model\n\n| Model | Cost | Tokens | Messages |\n|-------|------|--------|----------|\n"
        for m in data["by_model"]:
            md += f"| {m['model']} | ${m['total_cost']:.4f} | {m['total_tokens']:,} | {m['message_count']} |\n"

        md += "\n## Daily Trend (30 days)\n\n| Date | Cost | Tokens | Messages |\n|------|------|--------|----------|\n"
        for d in data["daily_30d"]:
            md += f"| {d.get('date', '')} | ${d.get('cost', 0):.4f} | {d.get('tokens', 0):,} | {d.get('messages', 0)} |\n"

        md += f"\n---\n*{len(data['records'])} records total — Gungnir by ScarletWolf*\n"

        return StreamingResponse(
            iter([md]),
            media_type="text/markdown",
            headers={"Content-Disposition": "attachment; filename=gungnir_analytics.md"},
        )
    except Exception as e:
        logger.error(f"Export MD error: {e}")
        return {"error": str(e)}


# ── ScarletWolf HTML template ────────────────────────────────────────────────

_SCARLET_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gungnir Analytics — ScarletWolf</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap');
  :root {{
    --scarlet: #dc2626;
    --scarlet-dark: #991b1b;
    --scarlet-light: #f87171;
    --bg-primary: #0a0a0b;
    --bg-card: #111114;
    --bg-secondary: #18181b;
    --border: #27272a;
    --text-primary: #fafafa;
    --text-secondary: #a1a1aa;
    --text-muted: #71717a;
  }}
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{
    background: var(--bg-primary);
    color: var(--text-primary);
    font-family: 'Inter', -apple-system, sans-serif;
    line-height: 1.6;
    padding: 0;
  }}
  .header {{
    background: linear-gradient(135deg, var(--scarlet-dark), #1a0505);
    padding: 40px;
    border-bottom: 2px solid var(--scarlet);
  }}
  .header h1 {{
    font-size: 32px; font-weight: 800; letter-spacing: -0.5px;
    background: linear-gradient(135deg, #fff, var(--scarlet-light));
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  }}
  .header .subtitle {{
    color: var(--scarlet-light); font-size: 13px; margin-top: 4px; font-weight: 500;
  }}
  .header .date {{
    color: var(--text-muted); font-size: 12px; margin-top: 8px;
    font-family: 'JetBrains Mono', monospace;
  }}
  .content {{ padding: 32px 40px; max-width: 1200px; }}
  .stats-grid {{
    display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px; margin-bottom: 32px;
  }}
  .stat-card {{
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 12px; padding: 20px;
  }}
  .stat-card .value {{
    font-size: 28px; font-weight: 700; color: var(--scarlet);
    font-family: 'JetBrains Mono', monospace;
  }}
  .stat-card .label {{
    font-size: 11px; color: var(--text-muted); text-transform: uppercase;
    letter-spacing: 1px; margin-top: 4px;
  }}
  h2 {{
    font-size: 18px; font-weight: 700; margin: 32px 0 16px 0;
    padding-bottom: 8px; border-bottom: 1px solid var(--border);
    color: var(--text-primary);
  }}
  h2 .accent {{ color: var(--scarlet); }}
  table {{
    width: 100%; border-collapse: collapse; background: var(--bg-card);
    border: 1px solid var(--border); border-radius: 8px; overflow: hidden;
    margin-bottom: 24px; font-size: 13px;
  }}
  thead {{ background: var(--bg-secondary); }}
  th {{
    padding: 10px 16px; text-align: left; font-weight: 600; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted);
    border-bottom: 1px solid var(--border);
  }}
  td {{
    padding: 10px 16px; border-bottom: 1px solid var(--border);
    color: var(--text-secondary);
  }}
  tr:last-child td {{ border-bottom: none; }}
  tr:hover td {{ background: rgba(220, 38, 38, 0.04); }}
  .cost {{ color: var(--scarlet); font-family: 'JetBrains Mono', monospace; font-weight: 600; }}
  .mono {{ font-family: 'JetBrains Mono', monospace; font-size: 12px; }}
  .footer {{
    padding: 24px 40px; border-top: 1px solid var(--border);
    color: var(--text-muted); font-size: 11px;
    display: flex; justify-content: space-between; align-items: center;
  }}
  .footer .brand {{
    display: flex; align-items: center; gap: 8px;
    font-weight: 700; color: var(--scarlet);
  }}
  @media print {{
    body {{ background: #fff; color: #111; }}
    .header {{ background: var(--scarlet) !important; }}
    .stat-card {{ border: 1px solid #ddd; }}
    table {{ border: 1px solid #ddd; }}
    th {{ background: #f5f5f5; color: #333; }}
    td {{ color: #333; }}
  }}
</style>
</head>
<body>

<div class="header">
  <h1>Gungnir Analytics</h1>
  <div class="subtitle">ScarletWolf Intelligence Platform</div>
  <div class="date">{generated_at}</div>
</div>

<div class="content">
  <div class="stats-grid">
    <div class="stat-card">
      <div class="value">${total_cost}</div>
      <div class="label">Total Cost</div>
    </div>
    <div class="stat-card">
      <div class="value">{total_tokens}</div>
      <div class="label">Total Tokens</div>
    </div>
    <div class="stat-card">
      <div class="value">{message_count}</div>
      <div class="label">Messages</div>
    </div>
    <div class="stat-card">
      <div class="value">${avg_cost}</div>
      <div class="label">Avg / Message</div>
    </div>
  </div>

  <h2><span class="accent">//</span> Cost by Provider</h2>
  <table>
    <thead><tr><th>Provider</th><th>Cost</th><th>Tokens</th><th>Messages</th></tr></thead>
    <tbody>{provider_rows}</tbody>
  </table>

  <h2><span class="accent">//</span> Cost by Model</h2>
  <table>
    <thead><tr><th>Model</th><th>Cost</th><th>Tokens</th><th>Messages</th></tr></thead>
    <tbody>{model_rows}</tbody>
  </table>

  <h2><span class="accent">//</span> Daily Trend (30 days)</h2>
  <table>
    <thead><tr><th>Date</th><th>Cost</th><th>Tokens</th><th>Messages</th></tr></thead>
    <tbody>{daily_rows}</tbody>
  </table>
</div>

<div class="footer">
  <div class="brand">🐺 Gungnir by ScarletWolf</div>
  <div>{record_count} records — {generated_at}</div>
</div>

</body>
</html>"""


# ── Export HTML ──────────────────────────────────────────────────────────────

@router.get("/export/html")
async def export_html(request: Request):
    """Export the current user's analytics as styled HTML report."""
    uid = _caller_user_id(request)
    try:
        data = await _gather_export_data(uid)
        s = data["summary"]

        def _row(cells: list) -> str:
            return "<tr>" + "".join(
                f'<td class="{"cost" if i == 1 else "mono" if i > 0 else ""}">{c}</td>'
                for i, c in enumerate(cells)
            ) + "</tr>"

        provider_rows = "\n".join(_row([p["provider"], f"${p['total_cost']:.4f}", f"{p['total_tokens']:,}", p["message_count"]]) for p in data["by_provider"])
        model_rows = "\n".join(_row([m["model"], f"${m['total_cost']:.4f}", f"{m['total_tokens']:,}", m["message_count"]]) for m in data["by_model"])
        daily_rows = "\n".join(_row([d.get("date", ""), f"${d.get('cost', 0):.4f}", f"{d.get('tokens', 0):,}", d.get("messages", 0)]) for d in data["daily_30d"])

        html = _SCARLET_HTML_TEMPLATE.format(
            generated_at=data["generated_at"],
            total_cost=f"{s.get('total_cost', 0):.4f}",
            total_tokens=f"{s.get('total_tokens', 0):,}",
            message_count=f"{s.get('message_count', 0):,}",
            avg_cost=f"{s.get('avg_cost_per_message', 0):.6f}",
            provider_rows=provider_rows,
            model_rows=model_rows,
            daily_rows=daily_rows,
            record_count=len(data["records"]),
        )

        return StreamingResponse(
            iter([html]),
            media_type="text/html",
            headers={"Content-Disposition": "attachment; filename=gungnir_analytics.html"},
        )
    except Exception as e:
        logger.error(f"Export HTML error: {e}")
        return {"error": str(e)}


# ── Export PDF ───────────────────────────────────────────────────────────────

@router.get("/export/pdf")
async def export_pdf(request: Request):
    """Export the current user's analytics as PDF."""
    uid = _caller_user_id(request)
    try:
        data = await _gather_export_data(uid)
        s = data["summary"]

        def _row(cells: list) -> str:
            return "<tr>" + "".join(
                f'<td class="{"cost" if i == 1 else "mono" if i > 0 else ""}">{c}</td>'
                for i, c in enumerate(cells)
            ) + "</tr>"

        provider_rows = "\n".join(_row([p["provider"], f"${p['total_cost']:.4f}", f"{p['total_tokens']:,}", p["message_count"]]) for p in data["by_provider"])
        model_rows = "\n".join(_row([m["model"], f"${m['total_cost']:.4f}", f"{m['total_tokens']:,}", m["message_count"]]) for m in data["by_model"])
        daily_rows = "\n".join(_row([d.get("date", ""), f"${d.get('cost', 0):.4f}", f"{d.get('tokens', 0):,}", d.get("messages", 0)]) for d in data["daily_30d"])

        html = _SCARLET_HTML_TEMPLATE.format(
            generated_at=data["generated_at"],
            total_cost=f"{s.get('total_cost', 0):.4f}",
            total_tokens=f"{s.get('total_tokens', 0):,}",
            message_count=f"{s.get('message_count', 0):,}",
            avg_cost=f"{s.get('avg_cost_per_message', 0):.6f}",
            provider_rows=provider_rows,
            model_rows=model_rows,
            daily_rows=daily_rows,
            record_count=len(data["records"]),
        )

        # Try weasyprint for real PDF
        try:
            from weasyprint import HTML as WeasyHTML
            pdf_bytes = WeasyHTML(string=html).write_pdf()
            return StreamingResponse(
                iter([pdf_bytes]),
                media_type="application/pdf",
                headers={"Content-Disposition": "attachment; filename=gungnir_analytics.pdf"},
            )
        except ImportError:
            logger.warning("weasyprint not installed — falling back to HTML download")
            # Fallback: return HTML with PDF extension hint
            return StreamingResponse(
                iter([html]),
                media_type="text/html",
                headers={"Content-Disposition": "attachment; filename=gungnir_analytics.html"},
            )
    except Exception as e:
        logger.error(f"Export PDF error: {e}")
        return {"error": str(e)}
