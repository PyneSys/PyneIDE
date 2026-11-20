"""Provider service with a provider hub in the same process.

The hub (``pynecore.core.plugin.hub``) holds the data providers of a workdir's live
runs. The symbol browser's provider service needs the same SDKs and market lists,
so it runs beside the hub instead of loading them a second time: the hub serves its
clients on an event loop in a background thread, the service answers its RPC on
stdin/stdout as usual. Once the hub listens, one ``{"e": "hub", "host", "port"}``
event tells the IDE where. The process ends when stdin closes.
"""

import asyncio
import os
import threading
from pathlib import Path

from pynecore.core.plugin.hub import HUB_ENV, TOKEN_ENV
from pynecore.core.plugin.hub.server import ProviderHub

from .protocol import Emitter
from .provider_service import ProviderService

_HUB_CLOSE_TIMEOUT = 15.0


def serve_with_hub(workdir: Path, emitter: Emitter, port: int) -> int:
    """Run the hub and the provider service until stdin closes.

    :param workdir: Resolved pyne workdir.
    :param emitter: The protocol emitter of the service.
    :param port: Port the hub listens on, 0 for a free one.
    :return: The process exit code.
    :raises RuntimeError: If the hub's token is missing from the environment.
    """
    token = os.environ.get(TOKEN_ENV, "")
    if not token:
        raise RuntimeError(f"the hub's token must be set in {TOKEN_ENV}")
    # This process holds the real providers: it must never look for a hub itself
    os.environ.pop(HUB_ENV, None)

    loop = asyncio.new_event_loop()
    hub = ProviderHub(token, config_dir=workdir / "config")
    listening = threading.Event()
    outcome: dict[str, int | BaseException] = {}

    def run_hub() -> None:
        asyncio.set_event_loop(loop)
        try:
            outcome["port"] = loop.run_until_complete(hub.start(port=port))
        except BaseException as exc:
            outcome["error"] = exc
            listening.set()
            return
        listening.set()
        loop.run_forever()
        loop.run_until_complete(hub.close())

    thread = threading.Thread(target=run_hub, name="pyneide-provider-hub", daemon=True)
    thread.start()
    listening.wait()
    error = outcome.get("error")
    if isinstance(error, BaseException):
        raise error

    emitter.emit({"e": "hub", "host": "127.0.0.1", "port": outcome["port"]})
    try:
        ProviderService(workdir, emitter).serve()
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(_HUB_CLOSE_TIMEOUT)
    return 0
