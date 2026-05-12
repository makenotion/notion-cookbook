"""
NYC Weather Fetcher
-------------------
Fetches current weather conditions for New York City using the
Open-Meteo API (https://open-meteo.com/) — no API key required.

Usage:
    python3 nyc_weather.py
"""

import json
import urllib.request
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
NYC_LATITUDE = 40.7128
NYC_LONGITUDE = -74.0060

BASE_URL = "https://api.open-meteo.com/v1/forecast"
PARAMS = (
    f"?latitude={NYC_LATITUDE}"
    f"&longitude={NYC_LONGITUDE}"
    "&current=temperature_2m,relative_humidity_2m,apparent_temperature"
    ",precipitation,weather_code,wind_speed_10m,wind_direction_10m"
    "&temperature_unit=fahrenheit"
    "&wind_speed_unit=mph"
    "&precipitation_unit=inch"
    "&timezone=America%2FNew_York"
)

# WMO Weather Code descriptions (subset most likely to appear)
WMO_CODES: dict[int, str] = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Foggy",
    48: "Icy fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    71: "Slight snow",
    73: "Moderate snow",
    75: "Heavy snow",
    80: "Slight showers",
    81: "Moderate showers",
    82: "Violent showers",
    95: "Thunderstorm",
    96: "Thunderstorm w/ hail",
    99: "Thunderstorm w/ heavy hail",
}


def wind_direction_label(degrees: float) -> str:
    """Convert a wind direction in degrees to a compass label."""
    directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    index = round(degrees / 45) % 8
    return directions[index]


def fetch_nyc_weather() -> dict:
    """Fetch current NYC weather data from Open-Meteo and return parsed JSON."""
    url = BASE_URL + PARAMS
    with urllib.request.urlopen(url, timeout=10) as response:
        raw = response.read().decode("utf-8")
    return json.loads(raw)


def format_report(data: dict) -> str:
    """Format the raw API response into a human-readable weather report."""
    current = data["current"]
    units = data["current_units"]

    temp = current["temperature_2m"]
    feels_like = current["apparent_temperature"]
    humidity = current["relative_humidity_2m"]
    precip = current["precipitation"]
    wind_speed = current["wind_speed_10m"]
    wind_dir_deg = current["wind_direction_10m"]
    weather_code = current["weather_code"]
    obs_time = current["time"]

    condition = WMO_CODES.get(weather_code, f"Unknown (code {weather_code})")
    wind_label = wind_direction_label(wind_dir_deg)
    fetched_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    return (
        "┌─────────────────────────────────────────┐\n"
        "│         NYC Current Weather Report       │\n"
        "└─────────────────────────────────────────┘\n"
        f"  Observation time : {obs_time}\n"
        f"  Fetched at       : {fetched_at}\n"
        f"  Condition        : {condition}\n"
        f"  Temperature      : {temp}{units['temperature_2m']}\n"
        f"  Feels like       : {feels_like}{units['apparent_temperature']}\n"
        f"  Humidity         : {humidity}{units['relative_humidity_2m']}\n"
        f"  Precipitation    : {precip}{units['precipitation']}\n"
        f"  Wind             : {wind_speed}{units['wind_speed_10m']} {wind_label} "
        f"({wind_dir_deg}°)\n"
    )


def main() -> None:
    print("Fetching current weather for New York City…\n")
    data = fetch_nyc_weather()
    print(format_report(data))


if __name__ == "__main__":
    main()
