#!/usr/bin/env python3
"""Fetch and print the current weather forecast for New York City.

Uses the public National Weather Service API; no API key is required.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

NYC_LAT = 40.7128
NYC_LON = -74.0060
USER_AGENT = "notion-cookbook-weather-script/1.0 (https://github.com/makenotion/notion-cookbook)"


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/geo+json, application/json",
            "User-Agent": USER_AGENT,
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def get_nyc_weather() -> str:
    points_url = f"https://api.weather.gov/points/{NYC_LAT},{NYC_LON}"
    points = fetch_json(points_url)
    forecast_url = points["properties"]["forecast"]
    forecast = fetch_json(forecast_url)
    current_period = forecast["properties"]["periods"][0]

    return (
        "NYC weather forecast\n"
        f"Period: {current_period['name']}\n"
        f"Temperature: {current_period['temperature']}°{current_period['temperatureUnit']}\n"
        f"Wind: {current_period['windSpeed']} {current_period['windDirection']}\n"
        f"Forecast: {current_period['detailedForecast']}"
    )


def main() -> int:
    try:
        print(get_nyc_weather())
    except (KeyError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        print(f"Unable to fetch NYC weather: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
