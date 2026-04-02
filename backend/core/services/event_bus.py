"""
Gungnir — Plugin Event Bus

Allows plugins to subscribe to core events without coupling.
Example: analytics plugin subscribes to 'chat.post_send' to record costs.
"""
import asyncio
import logging
from typing import Callable, Any

logger = logging.getLogger("gungnir.events")


class EventBus:
    def __init__(self):
        self._handlers: dict[str, list[Callable]] = {}

    def on(self, event: str, handler: Callable):
        """Register a handler for an event."""
        if event not in self._handlers:
            self._handlers[event] = []
        self._handlers[event].append(handler)
        logger.debug(f"Handler registered for event '{event}': {handler.__qualname__}")

    def off(self, event: str, handler: Callable):
        """Remove a handler."""
        if event in self._handlers:
            self._handlers[event] = [h for h in self._handlers[event] if h != handler]

    async def emit(self, event: str, **kwargs: Any):
        """Emit an event. All handlers run concurrently, errors are logged but don't propagate."""
        handlers = self._handlers.get(event, [])
        if not handlers:
            return

        results = await asyncio.gather(
            *[self._safe_call(h, event, **kwargs) for h in handlers],
            return_exceptions=True,
        )
        for r in results:
            if isinstance(r, Exception):
                logger.error(f"Event '{event}' handler error: {r}")

    async def _safe_call(self, handler: Callable, event: str, **kwargs):
        try:
            result = handler(**kwargs)
            if asyncio.iscoroutine(result):
                return await result
            return result
        except Exception as e:
            logger.error(f"Event '{event}' handler {handler.__qualname__} failed: {e}")
            raise


# Singleton
event_bus = EventBus()
