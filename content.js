(function () {
  "use strict";

  let overlay = null;
  let selectedIndex = 0;
  let allItems = [];
  let sectionRanges = []; // [{start, end, label}, ...]
  let rawSections = []; // scraped data before filtering

  document.addEventListener("keydown", onKeyDown, true);

  function getBreadcrumbText() {
    var bc = document.querySelector(".shadow-cursor-breadcrumb");
    return bc ? bc.textContent.trim() : "";
  }

  function onKeyDown(e) {
    if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === "F1") {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      toggle();
      return;
    }

    if (!overlay) return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      moveSelection(1);
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      moveSelection(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      activateSelection();
    } else if (e.key === "ArrowLeft") {
      var selItem = allItems[selectedIndex];
      if (selItem && selItem.type === "parent") {
        e.preventDefault();
        e.stopPropagation();
        activateSelection();
      }
      // Otherwise let the event through (cursor movement in search input).
    } else if (e.key === "ArrowRight") {
      var selItem = allItems[selectedIndex];
      if (selItem && selItem.type === "subpage") {
        e.preventDefault();
        e.stopPropagation();
        activateSelection();
      }
    } else if (e.key === "PageDown") {
      e.preventDefault();
      e.stopPropagation();
      jumpSection(1);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      e.stopPropagation();
      jumpSection(-1);
    }
  }

  // ── Scraping ─────────────────────────────────────────────────────────

  function scrapeParentPages() {
    // Notion renders breadcrumbs inside .shadow-cursor-breadcrumb.
    // Parent pages are <a role="link" href="...">, the current page is
    // <div role="button">, and separators are SVGs.
    const container =
      document.querySelector(".shadow-cursor-breadcrumb") ||
      document.querySelector('[class*="breadcrumb"]');
    if (!container) return [];

    const items = [];
    const seen = new Set();

    // Collect all interactive elements: links and buttons.
    const candidates = container.querySelectorAll(
      'a[href], [role="link"], [role="button"]'
    );

    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 8) continue;

      // Skip badge/control buttons (Private, Share, etc.) — they contain
      // SVG icons, unlike actual breadcrumb page items which are text-only.
      if (el.querySelector("svg")) continue;

      const title = cleanText(el);
      if (!title) continue;
      if (seen.has(title)) continue;
      seen.add(title);

      const link =
        el.tagName === "A"
          ? el
          : el.querySelector("a[href]") || el.closest("a[href]");
      const href = link ? link.getAttribute("href") : null;

      items.push({ type: "parent", title, href, element: link || el });
    }

    // Drop the last item — it's the current page.
    return items.slice(0, -1);
  }

  function scrapeHeaders() {
    const content =
      document.querySelector(".notion-page-content") ||
      document.querySelector('[class*="page-content"]');
    if (!content) return [];

    const items = [];

    // Notion renders headings as h1/h2/h3 inside header blocks, or
    // uses classes like notion-header-block, notion-sub_header-block, etc.
    const headings = content.querySelectorAll(
      "h1, h2, h3, h4, " +
        '[class*="header-block"] [contenteditable], ' +
        '[class*="header_block"] [contenteditable], ' +
        '[data-block-id] h1, [data-block-id] h2, [data-block-id] h3'
    );

    const seen = new Set();
    for (const h of headings) {
      const title = h.textContent.trim();
      if (!title || seen.has(title)) continue;
      seen.add(title);

      // Determine heading level.
      let level = 1;
      const tag = h.tagName;
      if (tag === "H2") level = 1;
      else if (tag === "H3") level = 2;
      else if (tag === "H4") level = 3;
      else {
        // Check parent block class for level hints.
        const block = h.closest('[class*="header"]');
        if (block) {
          const cls = block.className;
          if (cls.includes("sub_sub_header") || cls.includes("sub-sub-header"))
            level = 3;
          else if (cls.includes("sub_header") || cls.includes("sub-header"))
            level = 2;
          else level = 1;
        }
      }

      // Find the block element to scroll to (the data-block-id parent).
      const block = h.closest("[data-block-id]") || h;
      items.push({ type: "header", title, level, element: block });
    }

    return items;
  }

  function scrapeSubpages() {
    const content =
      document.querySelector(".notion-page-content") ||
      document.querySelector('[class*="page-content"]');
    if (!content) return [];

    const items = [];
    const seen = new Set();

    // Notion renders subpages specifically as .notion-page-block elements.
    // These are distinct from header blocks (.notion-header-block etc.)
    // and other block types.
    // Besides subpages, pick up full-page databases, inline databases,
    // aliases ("link to page" blocks) and inline @-mentions of pages.
    const pageBlocks = content.querySelectorAll(
      ".notion-page-block, .notion-alias-block, " +
        ".notion-collection_view_page-block, .notion-collection_view-block, " +
        "a.notion-page-mention-token"
    );

    for (const block of pageBlocks) {
      // Skip blocks that are also header blocks (safety check).
      if (block.className.includes("header")) continue;

      const isMention = block.classList.contains("notion-page-mention-token");
      // Mentions inside database rows/cells are row data, not navigation.
      if (isMention && block.closest(".notion-collection_view-block")) continue;

      const isInlineDb = block.classList.contains("notion-collection_view-block");
      const isAlias = isMention || block.classList.contains("notion-alias-block");

      const isRow = block.classList.contains("notion-collection-item");
      const rowTitle = isRow ? collectionItemTitle(block) : null;

      // Database rows: only trust a link that wraps the title (list/board
      // views); other links in a row belong to properties (URLs, relations).
      const link = isMention
        ? block
        : isRow
        ? rowTitle && rowTitle.closest("a[href]")
        : block.querySelector("a[href]");
      const title = isInlineDb
        ? inlineDbTitle(block)
        : isMention
        ? cleanText(block.querySelector(".notion-page-mention-token__title") || block)
        : isRow
        ? rowTitle ? textWithoutIcon(rowTitle) : cleanText(block)
        : cleanText(block);
      if (!title || seen.has(title)) continue;
      seen.add(title);

      // Get href from <a> tag, or construct it from the block's data-block-id.
      // Database/table rows don't have <a> tags but do have block IDs that
      // can be used to navigate directly: /block-id-without-dashes, or
      // /p/block-id-without-dashes on app.notion.com (where /<id> is a 404).
      // Aliases are the exception: their own block ID points at the alias,
      // not its target, so they only navigate via a real link.
      var href = link ? link.getAttribute("href") : null;
      if (!href && !isAlias) {
        const blockId = block.getAttribute("data-block-id");
        if (blockId) {
          const prefix = location.pathname.startsWith("/p/") ? "/p/" : "/";
          href = prefix + blockId.replace(/-/g, "");
        }
      }

      // Link-less aliases fall back to scrolling to the block.
      items.push({
        type: !href && !link ? "header" : "subpage",
        kind: isInlineDb ? "database" : isAlias ? "alias" : "page",
        title,
        level: 1,
        href,
        element: link || block,
      });
    }

    return items;
  }

  // Inline databases render the title in a dedicated element, with the rows
  // and view tabs as noise around it; avoid concatenating all of that text.
  function inlineDbTitle(block) {
    const t =
      block.querySelector('[class*="collection-view-title"]') ||
      block.querySelector('[placeholder="Untitled"]') ||
      block.querySelector('[class*="collection_view-title"]');
    return t ? cleanText(t) : "";
  }

  // Database rows contain every visible property; find just the title.
  // List/board/gallery views render it as an editable leaf; table views put
  // it in the cell that holds the row's page icon.
  function collectionItemTitle(row) {
    return (
      row.querySelector("[data-content-editable-leaf]") ||
      (row.querySelector(".notion-record-icon") &&
        row.querySelector(".notion-record-icon").closest(".notion-table-view-cell")) ||
      null
    );
  }

  function textWithoutIcon(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(".notion-record-icon").forEach((i) => i.remove());
    return cleanText(clone);
  }

  function cleanText(el) {
    let text = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      text += walker.currentNode.textContent;
    }
    return text.replace(/\s+/g, " ").trim();
  }

  // ── Navigation ───────────────────────────────────────────────────────

  function navigate(item) {
    if (item.type === "header") {
      close();
      item.element.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    // Always close before page navigation.
    close();

    // Prefer clicking <a> elements — Notion's SPA router intercepts these
    // for instant client-side navigation (preserves script state).
    var el = item.element;
    if (el && el.tagName === "A") {
      el.click();
      return;
    }

    // For items without a clickable <a> (e.g. database rows), navigate by
    // URL. This causes a full page reload but is the only reliable method.
    if (item.href) {
      var url = item.href.startsWith("http")
        ? item.href
        : window.location.origin + item.href;
      window.location.href = url;
      return;
    }

    // Last resort: simulate click.
    if (el) {
      var rect = el.getBoundingClientRect();
      var opts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
    }
  }

  // ── Overlay ──────────────────────────────────────────────────────────

  function toggle() {
    overlay ? close() : open();
  }

  function open() {
    const parents = scrapeParentPages();
    const headers = scrapeHeaders();
    const subpages = scrapeSubpages();

    rawSections = [];
    if (parents.length) rawSections.push({ label: "Parent pages", items: parents });
    if (headers.length) rawSections.push({ label: "On this page", items: headers });
    if (subpages.length) rawSections.push({ label: "Subpages", items: subpages });

    if (!rawSections.length) return;

    const el = document.createElement("div");
    el.id = "nbn-overlay";
    el.innerHTML =
      '<div class="nbn-backdrop"></div>' +
      '<div class="nbn-modal">' +
      '<div class="nbn-search-wrap">' +
      '<input class="nbn-search" type="text" placeholder="Filter..." spellcheck="false">' +
      "</div>" +
      '<div class="nbn-list"></div>' +
      '<div class="nbn-hints">' +
      '<span class="nbn-hint"><kbd>&uarr;</kbd><kbd>&darr;</kbd> navigate</span>' +
      '<span class="nbn-hint"><kbd>&crarr;</kbd> open</span>' +
      '<span class="nbn-hint"><kbd>&larr;</kbd> parent</span>' +
      '<span class="nbn-hint"><kbd>&rarr;</kbd> subpage</span>' +
      '<span class="nbn-hint"><kbd>PgUp</kbd><kbd>PgDn</kbd> section</span>' +
      '<span class="nbn-hint"><kbd>Esc</kbd> close</span>' +
      "</div>" +
      "</div>";

    el.querySelector(".nbn-backdrop").addEventListener("click", close);

    var input = el.querySelector(".nbn-search");
    input.addEventListener("input", function () {
      renderList(input.value.trim());
    });

    document.body.appendChild(el);
    overlay = el;
    input.focus();

    renderList("");
  }

  function renderList(filter) {
    if (!overlay) return;

    allItems = [];
    sectionRanges = [];

    var lowerFilter = filter.toLowerCase();
    var html = "";
    var globalIdx = 0;
    var firstParentEnd = -1;

    for (var s = 0; s < rawSections.length; s++) {
      var section = rawSections[s];
      var filtered = lowerFilter
        ? section.items.filter(function (it) {
            return it.title.toLowerCase().includes(lowerFilter);
          })
        : section.items;

      if (!filtered.length) continue;

      var start = globalIdx;
      html += '<div class="nbn-section-label">' + section.label + "</div>";

      for (var i = 0; i < filtered.length; i++) {
        var item = filtered[i];
        allItems.push(item);
        var icon = itemIcon(item);
        var indent =
          item.type === "header"
            ? ' style="padding-left:' + (16 + (item.level - 1) * 16) + 'px"'
            : "";
        html +=
          '<div class="nbn-item" data-index="' + globalIdx + '"' + indent + ">" +
          '<span class="nbn-item-icon">' + icon + "</span>" +
          '<span class="nbn-item-title">' + escapeHtml(item.title) + "</span>" +
          "</div>";
        globalIdx++;
      }

      sectionRanges.push({ start: start, end: globalIdx - 1, label: section.label });
      if (section.label === "Parent pages") firstParentEnd = globalIdx - 1;
    }

    if (!allItems.length) {
      html = '<div class="nbn-empty">No matches</div>';
    }

    var list = overlay.querySelector(".nbn-list");
    list.innerHTML = html;

    // Default selection: closest parent (last in parent section), or first item.
    if (!filter && firstParentEnd >= 0) {
      selectedIndex = firstParentEnd;
    } else {
      selectedIndex = 0;
    }

    // Attach click/hover handlers to new items.
    list.querySelectorAll(".nbn-item").forEach(function (node) {
      node.addEventListener("click", function () {
        activateIndex(parseInt(node.dataset.index));
      });
      node.addEventListener("mouseenter", function () {
        selectedIndex = parseInt(node.dataset.index);
        updateSelection();
      });
    });

    updateSelection();
    scrollSelectedIntoView();
  }

  function close() {
    if (overlay) {
      overlay.remove();
      overlay = null;
      selectedIndex = 0;
      allItems = [];
      sectionRanges = [];
      rawSections = [];
    }
  }

  function moveSelection(delta) {
    if (!overlay) return;
    const count = allItems.length;
    selectedIndex = (selectedIndex + delta + count) % count;
    updateSelection();
    scrollSelectedIntoView();
  }

  function updateSelection() {
    if (!overlay) return;
    overlay.querySelectorAll(".nbn-item").forEach((el) => {
      el.classList.toggle(
        "nbn-selected",
        parseInt(el.dataset.index) === selectedIndex
      );
    });
  }

  function jumpSection(delta) {
    if (!overlay || !sectionRanges.length) return;
    // Find which section the current selection is in.
    var curSection = 0;
    for (var i = 0; i < sectionRanges.length; i++) {
      if (selectedIndex >= sectionRanges[i].start && selectedIndex <= sectionRanges[i].end) {
        curSection = i;
        break;
      }
    }
    var next = curSection + delta;
    if (next < 0) next = sectionRanges.length - 1;
    if (next >= sectionRanges.length) next = 0;
    selectedIndex = sectionRanges[next].start;
    updateSelection();
    scrollSelectedIntoView();
  }

  function scrollSelectedIntoView() {
    if (!overlay) return;
    const sel = overlay.querySelector(".nbn-item.nbn-selected");
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  function activateSelection() {
    activateIndex(selectedIndex);
  }

  function activateIndex(index) {
    const item = allItems[index];
    if (!item) return;
    navigate(item);
  }

  function itemIcon(item) {
    if (item.type === "parent") return "&#8592;";   // ←
    if (item.type === "header") return "&#167;";    // §
    if (item.type === "subpage" || item.kind) {
      if (item.kind === "database") return "&#9638;"; // ▦
      if (item.kind === "alias") return "&#8599;";    // ↗
      return "&#8594;";                               // →
    }
    return "";
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }
})();
