# HomeDashboard

**Live demo:** https://leeraymond78.github.io/HomeDashboard/

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

This repo deploys with GitHub Actions (`.github/workflows/deploy.yml`).

1. Open **Settings → Pages** on GitHub.
2. Set **Build and deployment → Source** to **GitHub Actions** (not "Deploy from a branch").
3. Push to `main`. On the first run, approve the `github-pages` environment if prompted.

Static files are served from the repository root. The included `.nojekyll` file disables Jekyll processing.
