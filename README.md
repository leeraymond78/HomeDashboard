# HomeDashboard

Hong Kong bus and MTR arrival times dashboard. A lightweight PWA that groups routes by location and refreshes ETA data automatically.

## Setup

Edit `config.json` to define route groups and stops (KMB, NWFB/CTB, MTR Bus, and GMB).

## Run locally

Serve the project root with any static file server, for example:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Deploy

Static files are served from the repository root. The included `.nojekyll` file enables GitHub Pages hosting.
