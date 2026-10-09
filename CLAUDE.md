# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A Manifest V3 browser extension (Chrome/Brave/Edge, Safari via `xcrun safari-web-extension-converter`) that opens a keyboard-driven command palette on Notion pages for jumping to parent pages, headings, and subpages. There is no build step, package manager, linter, or test suite: the three files (`manifest.json`, `content.js`, `styles.css`) are loaded as-is.

## Development workflow

- Load the repo folder via `chrome://extensions` (or `brave://extensions`) → Developer mode → Load unpacked.
- After editing, click the reload icon on the extension card, then refresh the Notion tab (content scripts only inject on page load).
- Testing is manual on a live Notion page. Matches are `www.notion.so`, `app.notion.so`, `app.notion.com` (see `manifest.json`).
- Changing `manifest.json` means Safari users must re-run the converter; JS/CSS changes only need an Xcode rebuild.

## Architecture (`content.js`)

Everything lives in one IIFE with module-level state (`overlay`, `selectedIndex`, `allItems`, `sectionRanges`, `rawSections`). Flow:

1. A capture-phase `keydown` listener (`onKeyDown`) toggles the overlay and, while open, handles all navigation keys. It uses `stopPropagation` so Notion doesn't see the keys. Left/Right arrows only intercept when the selected item is a parent/subpage respectively; otherwise they pass through to the search input.
2. `open()` scrapes Notion's DOM into three sections (`scrapeParentPages`, `scrapeHeaders`, `scrapeSubpages`), stores them in `rawSections`, and builds the overlay (`#nbn-overlay`, all classes prefixed `nbn-`).
3. `renderList(filter)` rebuilds the flat `allItems` list from `rawSections` on every keystroke and recomputes `sectionRanges` (used by PageUp/PageDown). With no filter, the default selection is the last parent (the closest ancestor).
4. `navigate(item)` always closes the overlay first, then: headers → `scrollIntoView`; `<a>` elements → `.click()` (lets Notion's SPA router handle it); items with only an `href` → `window.location.href` (full reload; used for database rows, where the href is built from `data-block-id`); fallback → synthetic mouse events.

### Notion DOM coupling

The scrapers depend on Notion's undocumented DOM, which is the most likely thing to break:

- Breadcrumbs: `.shadow-cursor-breadcrumb` (fallback `[class*="breadcrumb"]`). Items with an `svg` child are treated as controls and skipped; the last item is dropped as the current page.
- Content root: `.notion-page-content`.
- Subpages: `.notion-page-block` (skipping any whose class contains "header").
- Headings: `h1`–`h4` plus `[class*="header-block"]` selectors. Note the level mapping in `scrapeHeaders` is offset (`H2`→1, `H3`→2, `H4`→3, other elements fall back to class-name hints).

## Gotchas

- The uncommitted working tree changes the trigger key: `content.js` currently listens for a bare **F1** (`onKeyDown`, top of file), while `README.md`, the manifest `description`, and the troubleshooting section still say **Ctrl+B**. Keep them consistent when changing the shortcut.
- `README.md` says the repo folder is `notion-breadcrumb-nav` in install instructions, but the repo directory is `notion-breadcrumbs`.
