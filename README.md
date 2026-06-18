# WhatsApp Semantic Search Chrome Extension

A privacy-focused Chrome Extension that enables concept-based and semantic searches on WhatsApp Web using local vector database storage (IndexedDB) and the Google Gemini Embedding API.

Unlike traditional keyword search which requires exact word matches, this extension allows you to search for the *idea* or *logic* of a message. For example, searching for **"lunch"** can find messages containing **"burger"**, **"pizza"**, or **"let's eat"**.

---

## Key Features

*   **Semantic Search**: Query your conversations conceptually rather than through strict keyword matching.
*   **Isolated Database Architecture (Privacy-First)**: All messages and vector embeddings are stored inside the extension's isolated sandbox origin (`chrome-extension://`). No scripts on the WhatsApp Web page (`web.whatsapp.com`) can read, query, or leak your chat history.
*   **Data Retention Control**: Configure automatic expiry of indexed messages (7, 30, or 90 days) or keep them indefinitely. Clear all data or a single chat's data at any time from the panel or settings page.
*   **Coordinate & Layout Independent**: Automatically locates the active conversation header and scrollable window by walking the DOM tree, regardless of whether your chat list is open, hidden, or resized.
*   **Auto-Scroll Chat Indexer**: Programmatically scrolls up your conversation history, scrapes messages in batches, retrieves embeddings, and indexes them in a local vector database.
*   **Auto-Seek Locator**: Clicking the "Locate" button on a search result will automatically scroll the WhatsApp Web conversation pane up or down to find the message, center it, and flash-highlight it with an elegant pulse animation.
*   **Real-time Indexing**: Automatically listens for new incoming and outgoing messages in your active chat and indexes them dynamically in the background.
*   **Flexible Credentials**: Support for the official Google Gemini API (`gemini-embedding-2`), official OpenAI API (`text-embedding-3-small`), or custom proxy servers (like `CLIProxyAPI` or `Gemini-API`).

---

## Installation Guide

To install the extension locally in your Google Chrome browser:

1.  Clone this repository or download the source files.
2.  Open Chrome and navigate to `chrome://extensions/`.
3.  Enable **Developer mode** using the toggle switch in the top-right corner.
4.  Click the **Load unpacked** button in the top-left corner.
5.  Select this project directory.
6.  The **WhatsApp Semantic Search** extension will now be active in your browser.

---

## Configuration

1.  Click the extension icon in your Chrome toolbar (or navigate to `chrome://extensions/` and click *Details -> Extension options*).
2.  Choose your API provider:
    *   **Google Gemini (Recommended)**: Generate a free developer key from [Google AI Studio](https://aistudio.google.com/).
    *   **Official OpenAI**: Enter your OpenAI API key and specify your model (e.g. `text-embedding-3-small`).
    *   **Custom Proxy**: Route requests through a local API manager (e.g., `CLIProxyAPI`) by inputting your proxy endpoint and target model name.
3.  Click **Verify & Save Settings** to run a test embedding check and save your settings.

---

## How to Use

1.  Open **[WhatsApp Web](https://web.whatsapp.com/)** in Chrome.
2.  Open any chat history.
3.  Click the green **magnifying glass** button floating in the bottom-right corner to open the **Semantic Search Panel**.
4.  Click **Scan Chat History** to index the chat.
5.  Type your query in the concept search input field and press **Enter**.
6.  Click **Locate** next to any search result to automatically scroll to and highlight that message in the WhatsApp Web window.
7.  Click the **trash icon** (🗑) next to Scan to clear the indexed data for the active chat at any time.

---

## Privacy & Security Notice

> **What stays on your device**: All indexed message records, metadata, and computed vector embeddings are stored exclusively in the browser's `IndexedDB` at the `chrome-extension://` origin. They are not uploaded to any server and are completely isolated from scripts running on `web.whatsapp.com`.

> **What leaves your device**: To compute vector embeddings, the **plain text of each indexed message** is sent to your configured AI provider (Google Gemini, OpenAI, or a custom proxy) over HTTPS. If you use a custom proxy, ensure it runs over HTTPS on a trusted network — using a plain `http://` endpoint on a public or shared network exposes your message text and API key in transit.

> **API Keys**: Never hard-code an API key into the source files or commit one to a public repository. Always enter your key through the extension options page, where it is stored only in `chrome.storage.local` (local to your browser profile).
