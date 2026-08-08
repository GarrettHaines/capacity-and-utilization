# Capacity & Utilization

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](https://nodejs.org/)

**Audit resource capacity and surface utilization trends across your Dynatrace monitoring environment.**

## Prerequisites

- [Node.js](https://nodejs.org/) 22.12 or later. Node 24 LTS recommended; Node 20 and Node 25 are end-of-life and will not build this project.
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
npm ci
```
`npm ci` installs the exact versions in `package-lock.json`. Use `npm install` only when you intend to change dependencies.

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
