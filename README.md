# peertube-plugin-arc-cashier

<div align="center">
  <img src="https://img.shields.io/badge/Build-Passing-brightgreen?style=for-the-badge" alt="Build Status">
  <img src="https://img.shields.io/badge/Version-1.0.9-blue?style=for-the-badge" alt="Version">
  <img src="https://img.shields.io/badge/License-Apache_2.0-green?style=for-the-badge" alt="License">
  <img src="https://img.shields.io/badge/Node->=18-yellow?style=for-the-badge" alt="Node Version">
  <br>
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/PeerTube-F2690D?style=for-the-badge&logo=peertube&logoColor=white" alt="PeerTube">
</div>

*Official PeerTube companion plugin for Arc-Cashier enabling high-fidelity per-second billing.*

> **TL;DR:** Injects the Arc-Cashier paywall directly into the PeerTube player and tracks user watch time via continuous server pings. This enables a seamless per-second billing integration for decentralized video hosting.

---

## 🔗 What is Arc-Cashier?

> [!WARNING]
> **Companion Plugin Only**
> This plugin does not process payments or manage blockchain transactions by itself. It is specifically built as a **companion bridge** for Arc-Cashier.

[**Arc-Cashier**](https://github.com/JaDi03/Arc-Cashier) is an open-source sidecar billing engine that enables Web3 per-second streaming payments (using Circle USDC) for self-hosted platforms. 

To use this PeerTube plugin, you **MUST** have an instance of Arc-Cashier running. The plugin acts as a reporter, sending high-fidelity presence webhooks (`viewer_joined`, `viewer_left`) to your Arc-Cashier backend, which then handles all the actual billing logic and paywall asset delivery.

---

## Table of Contents
- [Key Features](#-key-features)
- [How It Works](#-how-it-works)
- [Packaging & Installation](#-packaging--installation)
- [Project Structure](#-project-structure)
- [Tech Stack](#-tech-stack)
- [License](#-license)

---

## 🌟 Key Features
- **Zero Assumptions Architecture**: Automatically resolves the base URL from the webhook configuration to fetch `paywall.js` and `paywall.css` dynamically from your Arc-Cashier node.
- **High-Fidelity Tracking**: Connects to HTML5 video events (`play`, `pause`, `ended`) and emits reliable periodic pings every 15 seconds to ensure millimeter precision in billing.
- **Secure Webhooks**: Signs all HTTP event requests sent to Arc-Cashier using HMAC SHA-256 via the `X-PeerTube-Signature` header to prevent spoofing.
- **Resilient State Management**: Backend memory timeouts ensure users are correctly marked as disconnected even if their browser crashes or loses internet connection abruptly.
- **SPA Navigation Ready**: Gracefully handles PeerTube's Single Page Application architecture, showing and hiding the paywall correctly as users navigate between the dashboard and the video watch pages.

---

## 🧠 How It Works

This plugin consists of two main pieces: a server-side route for configuration and webhook dispatching, and a client script injected directly into the user's browser.

```mermaid
sequenceDiagram
    participant Browser
    participant PluginServer as PeerTube Plugin
    participant ArcCashier as Arc-Cashier Engine
    
    Browser->>PluginServer: GET /base-url
    PluginServer-->>Browser: { baseUrl: "https://api.your-arc.com" }
    Browser->>ArcCashier: Fetch paywall.js & paywall.css
    
    Note over Browser: User clicks Play
    Browser->>PluginServer: POST /ping { action: "start", userId: "user_xyz" }
    PluginServer->>ArcCashier: POST webhook (viewer_joined) [HMAC Signed]
    
    loop Every 15 seconds
        Browser->>PluginServer: POST /ping { action: "ping" }
        Note over PluginServer: Update expiration timestamp
    end
    
    Note over Browser: User navigates away or clicks Pause
    Browser->>PluginServer: POST /ping { action: "stop" }
    PluginServer->>ArcCashier: POST webhook (viewer_left) [HMAC Signed]
```

---

## 📦 Packaging & Installation

To install this plugin on a production PeerTube instance, you first need to package it into an installable `.tgz` bundle.

### 1. Build and Package
Run these commands on your local machine to compile the TypeScript and generate the tarball:

```bash
git clone https://github.com/JaDi03/peertube-plugin-arc-cashier.git
cd peertube-plugin-arc-cashier
npm install
npm run build
npm pack
```

*The `npm pack` command will generate a file named something like `peertube-plugin-arc-cashier-1.0.9.tgz` in your current directory.*

### 2. Install on PeerTube
1. Log in to your PeerTube instance as an **Administrator**.
2. Navigate to **Administration** -> **Plugins/Themes**.
3. Go to the **Install** tab.
4. Scroll down to the **Install a local plugin** section.
5. Click **Browse...** and select the `.tgz` file you generated in Step 1.
6. Click **Install**.

### 3. Configuration
Once installed, click on the **Settings** button next to the plugin to configure the connection to your Arc-Cashier server:
- **WebhookUrl**: The full API route of your Arc-Cashier instance (e.g., `https://api.yourdomain.com/api/connectors/peertube/webhook`).
- **WebhookSecret**: The cryptographically secure string matching your `.env` configuration in Arc-Cashier (`PEERTUBE_WEBHOOK_SECRET`).

---

## 🏗️ Project Structure

```text
peertube-plugin-arc-cashier/
├── .github/workflows/       # CI pipelines
├── src/
│   ├── client.ts            # Client-side injected logic (Paywall & Pings)
│   └── main.ts              # Server-side routing and Webhook signing
├── dist/                    # Compiled esbuild and tsc distribution files
├── package.json             # Plugin metadata, scopes, and dependencies
└── tsconfig.json            # TypeScript configuration
```

---

## 🛠️ Tech Stack
- **[TypeScript](https://www.typescriptlang.org/)**: Strongly typed programming language.
- **[Node.js](https://nodejs.org/)**: Server environment.
- **[esbuild](https://esbuild.github.io/)**: Blazing fast JS bundler used to output ESM modules for the client.
- **[PeerTube Types](https://github.com/Chocobozzz/PeerTube)**: Official typing definitions for the PeerTube API.

---

## 📄 License
Apache-2.0
