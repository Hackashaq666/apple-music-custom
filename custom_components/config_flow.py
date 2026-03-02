"""Config flow for Apple Music integration."""
from __future__ import annotations

import logging

import aiohttp
import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import CONF_HOST, CONF_PORT, DEFAULT_NAME, DEFAULT_PORT, DOMAIN

_LOGGER = logging.getLogger(__name__)


class AppleMusicConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the config flow for Apple Music."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict | None = None
    ) -> ConfigFlowResult:
        """Handle the initial setup step shown in the UI."""
        errors: dict[str, str] = {}

        if user_input is not None:
            host = user_input[CONF_HOST].strip()
            port = user_input[CONF_PORT]

            # Prevent duplicate entries for the same host:port
            await self.async_set_unique_id(f"{host}:{port}")
            self._abort_if_unique_id_configured()

            # Test the connection before accepting
            error = await self._test_connection(host, port)
            if error:
                errors["base"] = error
            else:
                return self.async_create_entry(
                    title=f"Apple Music ({host})",
                    data={CONF_HOST: host, CONF_PORT: port},
                )

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_HOST): str,
                    vol.Required(CONF_PORT, default=DEFAULT_PORT): int,
                }
            ),
            errors=errors,
        )

    async def _test_connection(self, host: str, port: int) -> str | None:
        """Try to reach the server. Returns an error key or None on success."""
        session = async_get_clientsession(self.hass)
        try:
            async with session.get(
                f"http://{host}:{port}/_ping",
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                if resp.status != 200:
                    return "cannot_connect"
                return None
        except aiohttp.ClientConnectorError:
            return "cannot_connect"
        except aiohttp.InvalidURL:
            return "invalid_host"
        except Exception:  # pylint: disable=broad-except
            _LOGGER.exception("Unexpected error connecting to Apple Music API")
            return "unknown"
