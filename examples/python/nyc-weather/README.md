# Example: NYC Weather Fetcher (Python)

## About

A self-contained Python script that fetches **current weather conditions for
New York City** using the [Open-Meteo](https://open-meteo.com/) API — no API
key, no third-party libraries required.

Reported fields:

| Field | Unit |
| --- | --- |
| Temperature | °F |
| Feels-like temperature | °F |
| Relative humidity | % |
| Precipitation | inches |
| Wind speed & direction | mph + compass |
| Sky condition (WMO code) | text label |

## Requirements

- Python 3.9 or later (uses only the standard library)

## Running Locally

```zsh
# Clone this repository locally
git clone https://github.com/makenotion/notion-cookbook.git

# Switch into this project
cd notion-cookbook/examples/python/nyc-weather

# Run the script
python3 nyc_weather.py
```

## Example Output

```
Fetching current weather for New York City…

┌─────────────────────────────────────────┐
│         NYC Current Weather Report       │
└─────────────────────────────────────────┘
  Observation time : 2025-05-01T14:00
  Fetched at       : 2025-05-01 18:05 UTC
  Condition        : Partly cloudy
  Temperature      : 62.1°F
  Feels like       : 59.8°F
  Humidity         : 54%
  Precipitation    : 0.00inch
  Wind             : 11.2mph NE (45°)
```

## Data Source

Weather data is provided by [Open-Meteo](https://open-meteo.com/), which offers
a free, open-source weather API under the
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) license.
