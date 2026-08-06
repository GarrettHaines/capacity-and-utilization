# Capacity & Utilization

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

**Audit resource capacity and surface utilization trends across your Dynatrace monitoring environment.**

## Prerequisites

- [Node.js](https://nodejs.org/) 20 or later
- npm (bundled with Node.js)
- A Dynatrace SaaS environment with permission to deploy apps

## Setup

### 1. Clone the repository
```
git clone https://github.com/GarrettHaines/capacity-and-utilization.git
cd capacity-and-utilization
```

### 2. Install dependencies
```
npm install
```

### 3. Configure your Dynatrace environment URL
Copy the example config and fill in your tenant URL.

macOS / Linux:
```
cp app.config.local.example.json app.config.local.json
```
Windows (Command Prompt):
```
copy app.config.local.example.json app.config.local.json
```
Windows (PowerShell):
```
Copy-Item app.config.local.example.json app.config.local.json
```
Then edit `app.config.local.json`:
```json
{
  "environmentUrl": "https://YOUR-ENVIRONMENT.apps.dynatrace.com/"
}
```
This file is gitignored, so your tenant URL stays out of version control. `app.config.js` reads from it at build time.

### 4. Deploy
```
npm run deploy
```
An authentication window will open in your browser to sign in to your Dynatrace environment. Once authenticated, the application is deployed directly to your tenant.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
