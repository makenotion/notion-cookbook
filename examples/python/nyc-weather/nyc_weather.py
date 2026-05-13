#!/usr/bin/env python3
"""Fetch the latest National Weather Service forecast for New York City.

This example intentionally uses only Python's standard library. It resolves
NYC's latitude/longitude through the weather.gov points API, follows the
returned forecast URL, and prints the next forecast period.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

NYC_LATITUDE = 40.7128
NYC_LONGITUDE = -74.0060
NWS_API_BASE = "https://api.weather.gov"
DEFAULT_USER_AGENT = (
    "notion-cookbook-nyc-weather-example/1.0 "
    "(https://github.com/makenotion/notion-cookbook)"
)


class WeatherError(RuntimeError):
    """Raised when the weather forecast cannot be fetched or parsed."""


def fetch_json(url: str, user_agent: str) -> dict[str, Any]:
    """Fetch JSON from a URL with headers required by the weather.gov API."""
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/geo+json, application/json",
            "User-Agent": user_agent,
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise WeatherError(f"HTTP {error.code} while fetching {url}: {detail}") from error
    except urllib.error.URLError as error:
        raise WeatherError(f"Network error while fetching {url}: {error.reason}") from error
    except json.JSONDecodeError as error:
        raise WeatherError(f"Invalid JSON returned by {url}: {error}") from error


def get_nyc_forecast(user_agent: str) -> dict[str, Any]:
    """Return the next forecast period for New York City."""
    point_url = f"{NWS_API_BASE}/points/{NYC_LATITUDE},{NYC_LONGITUDE}"
    point_data = fetch_json(point_url, user_agent)

    try:
        forecast_url = point_data["properties"]["forecast"]
    except KeyError as error:
        raise WeatherError("Could not find forecast URL in weather.gov point data") from error

    forecast_data = fetch_json(forecast_url, user_agent)

    try:
        periods = forecast_data["properties"]["periods"]
        forecast = periods[0]
    except (KeyError, IndexError) as error:
        raise WeatherError("Could not find forecast periods in weather.gov data") from error

    return {
        "location": "New York City, NY",
        "period": forecast.get("name"),
        "temperature": forecast.get("temperature"),
        "temperatureUnit": forecast.get("temperatureUnit"),
        "windSpeed": forecast.get("windSpeed"),
        "windDirection": forecast.get("windDirection"),
        "shortForecast": forecast.get("shortForecast"),
        "detailedForecast": forecast.get("detailedForecast"),
    }


def format_forecast(forecast: dict[str, Any]) -> str:
    """Return a human-readable forecast summary."""
    temperature = forecast.get("temperature")
    unit = forecast.get("temperatureUnit") or ""
    temp_text = f"{temperature}°{unit}" if temperature is not None else "temperature unavailable"

    return "\n".join(
        [
            f"Weather for {forecast['location']} ({forecast.get('period')})",
            f"Forecast: {forecast.get('shortForecast', 'unavailable')}",
            f"Temperature: {temp_text}",
            f"Wind: {forecast.get('windSpeed', 'unavailable')} {forecast.get('windDirection', '')}".strip(),
            f"Details: {forecast.get('detailedForecast', 'unavailable')}",
        ]
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch the NYC weather forecast.")
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print the forecast as JSON instead of formatted text.",
    )
    parser.add_argument(
        "--user-agent",
        default=os.environ.get("NWS_USER_AGENT", DEFAULT_USER_AGENT),
        help="User-Agent header to send to weather.gov. Defaults to NWS_USER_AGENT or an example value.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    try:
        forecast = get_nyc_forecast(args.user_agent)
    except WeatherError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(forecast, indent=2))
    else:
        print(format_forecast(forecast))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
