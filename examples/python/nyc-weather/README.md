# NYC weather Python example

Fetch the latest National Weather Service forecast for New York City using only Python's standard library.

## Run

```bash
python3 nyc_weather.py
```

To print JSON:

```bash
python3 nyc_weather.py --json
```

The script uses the public [weather.gov API](https://www.weather.gov/documentation/services-web-api). The API asks clients to send a descriptive `User-Agent`; you can override the example default with:

```bash
NWS_USER_AGENT="your-app-name (you@example.com)" python3 nyc_weather.py
```
