// ==UserScript==
// @name         KOMCA work importer/editor into MusicBrainz
// @namespace    https://github.com/meze4044/KOMCA-MusicBrainz-Importer
// @downloadURL  https://github.com/meze4044/KOMCA-MusicBrainz-Importer/raw/main/komca-mb-importer.user.js
// @version      2026.09.29
// @description  One click imports KOMCA works into MusicBrainz (name, iswc, type, KOMCA id, credits, edit note), and allows searching MB by KOMCA ids
// @author       meze
// @licence      CC-BY-NC-SA-4.0; https://creativecommons.org/licenses/by-nc-sa/4.0/
// @licence      GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
// @since        2026-09-28
// @match        https://www.komca.or.kr/srch2/srch_01.jsp*
// @match        https://komca.or.kr/srch2/srch_01.jsp*
// @match        https://www.komca.or.kr/foreign2/eng/S01.jsp*
// @match        https://komca.or.kr/foreign2/eng/S01.jsp*
// @match        https://www.komca.or.kr/foreign2/jap/S01.jsp*
// @match        https://komca.or.kr/foreign2/jap/S01.jsp*
// @match        https://m.komca.or.kr/foreign2/jap/S01.jsp*
// @include      https://m.komca.or.kr:8700/foreign2/jap/S01.jsp*
// @match        https://musicbrainz.org/artist/*
// @match        https://beta.musicbrainz.org/artist/*
// @match        https://musicbrainz.org/work/*
// @match        https://beta.musicbrainz.org/work/*
// @grant        GM_info
// @exclude      *.org/work/*/*edits*
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const MB_ORIGIN = "https://musicbrainz.org";
  const IMPORTER_VERSION = typeof GM_info !== "undefined" && GM_info.script?.version ? GM_info.script.version : "dev";
  const NO_KOMCA_CREATOR_ID = "Z9999900";
  const ROLES = { A: { name: "lyricist", type: "165" }, C: { name: "composer", type: "168" } };
  const WORK_TYPE_SONG = "17";
  const LANGUAGE_NO_LYRICS = "486";
  const WORK_ATTRIBUTE_KOMCA_ID = "11";

  function parseHeading(text) {
    const match = text.trim().match(/^(?:\[[^\]]+\]\s*)?(.+?)\s+-\s+(\d+)$/);
    if (!match) throw new Error("Could not read the KOMCA work title and ID.");
    return { title: match[1].trim(), workId: match[2] };
  }

  function isRightsHolderTable(table) {
    const caption = table.querySelector("caption")?.textContent.trim() || "";
    if (/권리자 목록|rights?\s+holder/i.test(caption)) return true;
    const headers = [...table.querySelectorAll("thead th, tr:first-child th")].map((cell) => cell.textContent.trim().toLowerCase());
    const headerText = headers.join(" ");
    return (
      (headerText.includes("분류") && headerText.includes("저작자명")) ||
      (headerText.includes("分類") && (headerText.includes("著作者名") || headerText.includes("権利出版者"))) ||
      (/\b(category|classification)\b/.test(headerText) && /\b(writers?|publishers?|creator|author)\b/.test(headerText))
    );
  }

  function findWorkHeading(container) {
    const preferred = container.querySelector(".works_info .tit2");
    if (preferred) return preferred;
    return [...container.querySelectorAll("h1, h2, h3, h4, .tit2, .title, strong, p")].find((item) =>
      /-\s*\d+\s*$/.test(item.firstChild?.textContent || item.textContent || ""),
    ) || null;
  }

  function findRightsHolderTable(container) {
    return [...container.querySelectorAll("table")].find((item) => isRightsHolderTable(item)) || null;
  }

  function getKomcaResultContainers() {
    const preferred = [...document.querySelectorAll(".result_list .result_article, .result_article")];
    if (preferred.length) return preferred;
    const containers = new Set();
    for (const table of [...document.querySelectorAll("table")].filter((item) => isRightsHolderTable(item))) {
      containers.add(table.closest("article, li, .result, .work, .works, .board_view, .view, div") || table.parentElement || table);
    }
    return [...containers];
  }

  function parseRightsRows(rows) {
    const credits = [];
    const invalid = [];
    for (const cells of rows) {
      const role = String(cells[0] || "").trim().toUpperCase();
      if (!Object.hasOwn(ROLES, role)) continue; // AR, CA, and all other roles are out of scope.
      const creator = String(cells[1] || "").trim().match(/^(.*?)\s*\(([A-Z]?\d+)\)$/);
      if (!creator || !creator[1].trim()) {
        invalid.push({ role, text: String(cells[1] || "") });
        continue;
      }
      credits.push({ role, relationship: ROLES[role].name, name: creator[1].trim(), creatorId: creator[2] });
    }
    if (invalid.length) throw new Error(`Could not parse ${invalid.length} A/C credit row(s). No relationships were prepared.`);
    if (!credits.length) throw new Error("No A/C songwriting credits found in this result.");
    return credits;
  }

  function canonicalSourceUrl(workId, sourceUrl = "") {
    if (!/^\d+$/.test(workId)) throw new Error("KOMCA work ID must contain digits only.");
    let origin = "https://www.komca.or.kr";
    let path = "/srch2/srch_01.jsp";
    try {
      const source = new URL(sourceUrl);
      if (/^\/foreign2\/(?:eng|jap)\/S01\.jsp$/i.test(source.pathname)) {
        origin = source.hostname === "komca.or.kr" ? "https://www.komca.or.kr" : source.origin;
        path = source.pathname;
      }
    } catch {
      // Use the Korean search URL when there is no usable source page URL.
    }
    const url = new URL(path, origin);
    url.searchParams.set("S_PROD_TTL", workId);
    url.searchParams.set("S_PROD_TTL_GB", "3");
    url.searchParams.set("SLCT_SORT_FLDS", "basic");
    url.searchParams.set("PAGE_INIT", "1");
    url.searchParams.set("S_PAGENUMBER", "1");
    return url.toString();
  }

  function titleSearchUrl(title) {
    const url = new URL("/srch2/srch_01.jsp", "https://www.komca.or.kr");
    url.searchParams.set("S_PROD_TTL", title);
    url.searchParams.set("S_PROD_TTL_GB", "1");
    url.searchParams.set("SLCT_SORT_FLDS", "basic");
    url.searchParams.set("PAGE_INIT", "1");
    url.searchParams.set("S_PAGENUMBER", "1");
    return url.toString();
  }

  function musicBrainzAnnotationSearchUrl(creatorId) {
    const url = new URL("/search", MB_ORIGIN);
    url.searchParams.set("query", creatorId);
    url.searchParams.set("type", "annotation");
    url.searchParams.set("method", "indexed");
    return url.toString();
  }

  function komcaCreatorPopupUrl(creatorId) {
    if (!/^[A-Z]?\d+$/i.test(creatorId)) throw new Error("KOMCA creator ID must contain an optional letter followed by digits.");
    const url = new URL("/srch2/srch_01_popup_mem_right.jsp", "https://www.komca.or.kr");
    url.searchParams.set("S_MB_CD", creatorId);
    return url.toString();
  }

  function parseIswc(text) {
    const match = text.match(/\bISWC\s*[:：]\s*([A-Z][A-Z0-9.\-\s]{3,25}\d)/i);
    return match ? match[1].replace(/\s+/g, "") : "";
  }

  function readResult(article, sourceUrl = typeof location === "undefined" ? "" : location.href) {
    const heading = findWorkHeading(article);
    const table = findRightsHolderTable(article);
    if (!heading || !table) throw new Error("This result has no recognized KOMCA title or rights-holder table.");
    const work = parseHeading(heading.firstChild?.textContent || "");
    const rows = [...table.querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll(":scope > td")].map((cell) => cell.textContent.trim()),
    );
    return { ...work, iswc: parseIswc(article.textContent || ""), credits: parseRightsRows(rows), sourceUrl: canonicalSourceUrl(work.workId, sourceUrl) };
  }

  function workHasLyrics(work) {
    return work.credits.some((credit) => credit.role === "A");
  }

  function buildEditNote(work) {
    const identifiers = [`KOMCA ID '''${work.workId}'''`];
    if (work.iswc) identifiers.push(`ISWC '''${work.iswc}'''`);
    return [
      `${work.title} (${identifiers.join(" / ")})`,
      `※ '''KOMCA work importer''' (${IMPORTER_VERSION})`,
      work.sourceUrl,
    ].join("\n");
  }

  function buildMusicBrainzUrl(work) {
    const url = new URL("/work/create", MB_ORIGIN);
    const hasLyrics = workHasLyrics(work);
    url.searchParams.set("edit-work.name", work.title);
    if (hasLyrics) url.searchParams.set("edit-work.type_id", WORK_TYPE_SONG);
    else url.searchParams.set("edit-work.languages.0", LANGUAGE_NO_LYRICS);
    url.searchParams.set("edit-work.attributes.0.type_id", WORK_ATTRIBUTE_KOMCA_ID);
    url.searchParams.set("edit-work.attributes.0.value", work.workId);
    if (work.iswc) url.searchParams.set("edit-work.iswcs.0", work.iswc);
    work.credits.forEach((credit, index) => {
      url.searchParams.set(`rels.${index}.type`, ROLES[credit.role].type);
      url.searchParams.set(`rels.${index}.target`, credit.name);
      url.searchParams.set(`rels.${index}.backward`, "1");
    });
    const editNote = buildEditNote(work);
    url.searchParams.set("edit_note", editNote);
    const hash = new URLSearchParams({
      "komca-work-id": work.workId,
      "komca-source": work.sourceUrl,
      "komca-edit-note": editNote,
    });
    if (work.iswc) hash.set("komca-iswc", work.iswc);
    if (hasLyrics) hash.set("komca-work-type", WORK_TYPE_SONG);
    else hash.set("komca-no-lyrics", LANGUAGE_NO_LYRICS);
    // The fragment is a fallback for filling MusicBrainz fields after navigation.
    url.hash = hash.toString();
    return { url: url.toString(), editNote };
  }

  if (typeof document === "undefined" && typeof module === "object" && module.exports) {
    module.exports = { parseHeading, parseRightsRows, canonicalSourceUrl,
      parseIswc,
      titleSearchUrl, musicBrainzAnnotationSearchUrl, komcaCreatorPopupUrl, workHasLyrics, buildEditNote, buildMusicBrainzUrl };
    return;
  }

  function createLink(text, href, title) {
    const link = document.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (title) link.title = title;
    link.textContent = text;
    return link;
  }

  function linkKomcaCreatorIds(article) {
    const table = findRightsHolderTable(article);
    if (!table) return;
    for (const row of table.querySelectorAll("tbody tr")) {
      const creditCell = row.querySelectorAll(":scope > td")[1];
      if (!creditCell || creditCell.querySelector(".komca-mb-creator-id")) continue;
      const match = creditCell.textContent.trim().match(/^(.*)\(([A-Z]?\d+)\)$/);
      if (!match) continue;
      const [, name, creatorId] = match;
      if (creatorId === NO_KOMCA_CREATOR_ID) continue;
      creditCell.replaceChildren(
        document.createTextNode(`${name}(`),
        createLink(
          creatorId,
          musicBrainzAnnotationSearchUrl(creatorId),
          `Search MusicBrainz annotations for KOMCA ID: ${creatorId}`,
        ),
        document.createTextNode(")"),
      );
      creditCell.querySelector("a")?.classList.add("komca-mb-creator-id");
    }
  }

  function getMusicBrainzExternalLinksList() {
    let list = document.querySelector("div#sidebar > ul.external_links");
    if (list) {
      const empty = [...list.querySelectorAll("li")].find((item) => /has no url relationships/i.test(item.textContent || ""));
      if (empty) empty.remove();
      return list;
    }
    const sidebar = document.querySelector("div#sidebar");
    if (!sidebar) return null;
    const heading = document.createElement("h2");
    heading.textContent = "External links";
    list = document.createElement("ul");
    list.className = "external_links";
    const lastUpdate = sidebar.querySelector("p.lastupdate");
    if (lastUpdate) {
      sidebar.insertBefore(heading, lastUpdate);
      sidebar.insertBefore(list, lastUpdate);
    } else {
      sidebar.appendChild(heading);
      sidebar.appendChild(list);
    }
    return list;
  }

  function appendMusicBrainzExternalLink(key, text, href, title) {
    const list = getMusicBrainzExternalLinksList();
    if (!list) return;
    const exists = [...list.querySelectorAll("li[data-komca-mb], a[href]")].some((item) =>
      item.dataset?.komcaMb === key || item.href === href,
    );
    if (exists) return;
    const item = document.createElement("li");
    item.className = "komca-mb-link no-favicon";
    item.dataset.komcaMb = key;
    item.appendChild(createLink(text, href, title));
    list.appendChild(item);
  }

  function readMusicBrainzKomcaIds() {
    const ids = new Set();
    const script = document.querySelector("h2.work-attributes + script[type='application/json']");
    if (script?.textContent) {
      try {
        const data = JSON.parse(script.textContent);
        for (const attribute of data.attributes || []) {
          if (String(attribute.typeID) === WORK_ATTRIBUTE_KOMCA_ID && /^\d+$/.test(String(attribute.value || ""))) {
            ids.add(String(attribute.value));
          }
        }
      } catch {
        // Fall back to visible sidebar parsing below.
      }
    }
    const terms = [...document.querySelectorAll("div#sidebar dl.work-attributes dt")];
    for (const term of terms) {
      if (!/KOMCA ID/i.test(term.textContent || "")) continue;
      const value = term.nextElementSibling?.textContent?.trim() || "";
      if (/^\d+$/.test(value)) ids.add(value);
    }
    return [...ids];
  }

  function linkVisibleMusicBrainzKomcaIds(ids) {
    if (!ids.length) return;
    const values = new Set(ids);
    const terms = [...document.querySelectorAll("div#sidebar dl.work-attributes dt")];
    for (const term of terms) {
      if (!/KOMCA ID/i.test(term.textContent || "")) continue;
      const valueNode = term.nextElementSibling;
      const value = valueNode?.textContent?.trim() || "";
      if (!valueNode || !values.has(value) || valueNode.querySelector("a")) continue;
      valueNode.replaceChildren(createLink(value, canonicalSourceUrl(value), `Open KOMCA work ${value}`));
    }
  }

  function revealHiddenMusicBrainzKomcaIds(ids) {
    const list = document.querySelector("div#sidebar dl.work-attributes");
    if (!list || !ids.length) return;
    const visibleValues = new Set(
      [...list.querySelectorAll("dt")].flatMap((term) => {
        if (!/KOMCA ID/i.test(term.textContent || "")) return [];
        const value = term.nextElementSibling?.textContent?.trim() || "";
        return /^\d+$/.test(value) ? [value] : [];
      }),
    );
    const anchor = [...list.querySelectorAll("dt")].find((term) => /KOMCA ID/i.test(term.textContent || "")) ||
      [...list.querySelectorAll("dt")].find((term) => /JASRAC ID|ASCAP ID|GEMA ID|SGAE ID|SOCAN ID/i.test(term.textContent || ""));
    for (const workId of ids) {
      if (visibleValues.has(workId) || list.querySelector(`dd[data-komca-mb-revealed="${workId}"]`)) continue;
      const term = document.createElement("dt");
      term.dataset.komcaMbRevealed = workId;
      term.textContent = "KOMCA ID:";
      const value = document.createElement("dd");
      value.dataset.komcaMbRevealed = workId;
      value.className = "work-attribute";
      value.appendChild(createLink(workId, canonicalSourceUrl(workId), `Open KOMCA work ${workId}`));
      if (anchor?.nextElementSibling) {
        const afterAnchorValue = anchor.nextElementSibling.nextSibling;
        list.insertBefore(term, afterAnchorValue);
        list.insertBefore(value, afterAnchorValue);
      } else {
        list.appendChild(term);
        list.appendChild(value);
      }
    }
  }

  function getMusicBrainzAnnotationContainers() {
    const containers = new Set(document.querySelectorAll(".annotation, .annotation-body, #annotation"));
    for (const heading of document.querySelectorAll("h2, h3")) {
      if (!/^Annotation$/i.test((heading.textContent || "").trim())) continue;
      let sibling = heading.nextElementSibling;
      while (sibling && !/^H[23]$/i.test(sibling.tagName)) {
        if (/KOMCA\s+ID/i.test(sibling.textContent || "")) containers.add(sibling);
        sibling = sibling.nextElementSibling;
      }
    }
    return [...containers].filter((container) => /KOMCA\s+ID/i.test(container.textContent || ""));
  }

  function linkTextNodeKomcaCreatorIds(node) {
    const text = node.nodeValue;
    const matches = [...text.matchAll(/\b(KOMCA\s+ID\s*[:：]\s*)([A-Z]?\d{4,})\b/gi)];
    if (!matches.length) return false;

    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of matches) {
      const [fullText, label, creatorId] = match;
      const start = match.index;
      if (start > offset) fragment.appendChild(document.createTextNode(text.slice(offset, start)));
      fragment.appendChild(document.createTextNode(label));
      fragment.appendChild(createLink(creatorId, komcaCreatorPopupUrl(creatorId), `Open KOMCA creator ${creatorId}`));
      offset = start + fullText.length;
    }
    if (offset < text.length) fragment.appendChild(document.createTextNode(text.slice(offset)));
    node.replaceWith(fragment);
    return true;
  }

  function linkMusicBrainzAnnotationKomcaCreatorIds() {
    for (const container of getMusicBrainzAnnotationContainers()) {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent || parent.closest("a, script, style, textarea, input, select")) return NodeFilter.FILTER_REJECT;
          return /\bKOMCA\s+ID\s*[:：]\s*[A-Z]?\d{4,}\b/i.test(node.nodeValue || "")
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      });
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach(linkTextNodeKomcaCreatorIds);
    }
  }

  function enhanceMusicBrainzWorkPage() {
    if (!location.pathname.match(/^\/work\/[0-9a-f-]{36}\/?$/i)) return;
    const komcaIds = readMusicBrainzKomcaIds();
    revealHiddenMusicBrainzKomcaIds(komcaIds);
    linkVisibleMusicBrainzKomcaIds(komcaIds);
    for (const workId of komcaIds) {
      appendMusicBrainzExternalLink(
        `komca-id-${workId}`,
        `KOMCA - ${workId}`,
        canonicalSourceUrl(workId),
        `Open KOMCA work ${workId}`,
      );
    }
    const title = document.querySelector("h1 a, h1")?.textContent?.trim();
    if (title) {
      appendMusicBrainzExternalLink(
        "komca-title-search",
        `KOMCA - ${title}`,
        titleSearchUrl(title),
        `Search KOMCA for ${title}`,
      );
    }
  }

  function enhanceMusicBrainzArtistPage() {
    if (!location.pathname.match(/^\/artist\/[0-9a-f-]{36}\/?$/i)) return;
    linkMusicBrainzAnnotationKomcaCreatorIds();
  }

  if (/^(?:beta\.)?musicbrainz\.org$/.test(location.hostname)) {
    const seedParams = new URLSearchParams(location.hash.slice(1));
    const source = seedParams.get("komca-source");
    if (!source) {
      enhanceMusicBrainzWorkPage();
      enhanceMusicBrainzArtistPage();
      return;
    }
    const note = seedParams.get("komca-edit-note") || `KOMCA: ${source}`;
    const FILL_OK = "#cfc";
    const FILL_NEW = "gold";
    const setFieldValue = (selectors, value) => {
      if (!value) return true;
      const field = document.querySelector(selectors);
      if (!field) return false;
      if (field.value === value) return true;
      const proto = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(field, value); else field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    };
    const markFilled = (field, color) => {
      if (field) field.style.setProperty("background", color);
    };
    const setTextInputValue = (field, value, color = FILL_NEW) => {
      if (!field || !value) return false;
      if (field.value === value) {
        markFilled(field, FILL_OK);
        return true;
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(field, value); else field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      if (field.value === value) markFilled(field, color);
      return field.value === value;
    };
    const setSelectValue = (field, value, textPattern = null, color = FILL_NEW) => {
      if (!field || !value) return false;
      const option = [...field.options].find((item) => item.value === value) ||
        (textPattern ? [...field.options].find((item) => textPattern.test(item.textContent || "")) : null);
      if (!option) return false;
      if (field.value === option.value) {
        markFilled(field, FILL_OK);
        return true;
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      if (setter) setter.call(field, option.value); else field.value = option.value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      if (field.value === option.value) markFilled(field, color);
      return field.value === option.value;
    };
    const findAddControl = (container, textPattern) => {
      if (!container) return null;
      const preferred = container.querySelector("button.add-item, input.add-item, a.add-item");
      if (preferred) return preferred;
      return [...container.querySelectorAll("button, input[type='button'], a")].find((item) =>
        textPattern.test(item.textContent || item.value || item.getAttribute("title") || ""),
      ) || null;
    };
    const clickAddControl = (container, textPattern) => {
      const control = findAddControl(container, textPattern);
      if (!control) return false;
      control.click();
      return true;
    };
    const fieldContainerByText = (pattern) => {
      const labels = [...document.querySelectorAll("label, legend, dt, th, td, h2, h3, span")].filter((item) =>
        pattern.test(item.textContent || ""),
      );
      for (const label of labels) {
        const fieldId = label.getAttribute("for");
        if (fieldId) {
          const field = document.getElementById(fieldId);
          if (field) return field.closest("tr, dl, fieldset, div, p") || field.parentElement;
        }
        const container = label.closest("tr, dl, fieldset, div, p") || label.parentElement;
        if (container) return container;
      }
      return null;
    };
    const fieldRow = (field) => field.closest("tr, .text-list-row, .form-row, .row, li, div") || field.parentElement;
    const getLyricsLanguageSelects = () => {
      const direct = [...document.querySelectorAll(
        'select[name^="edit-work.languages"], select[name*="lyrics"][name*="language"], select[name*="languages"]',
      )];
      if (direct.length) return direct;
      const container = fieldContainerByText(/lyrics\s+languages?/i);
      return container ? [...container.querySelectorAll("select")] : [];
    };
    const setNoLyricsLanguage = (value) => {
      const textPattern = /^\s*\[no lyrics\]\s*$/i;
      const selects = getLyricsLanguageSelects();
      const matched = selects.find((field) => field.value === value ||
        [...field.options].some((option) => option.value === field.value && textPattern.test(option.textContent || "")));
      if (matched) {
        markFilled(matched, FILL_OK);
        return true;
      }
      const blank = selects.find((field) => !field.value || field.selectedIndex === 0);
      if (blank) return setSelectValue(blank, value, textPattern);
      const container = fieldContainerByText(/lyrics\s+languages?/i);
      if (clickAddControl(container, /add\s+language/i)) {
        const nextBlank = getLyricsLanguageSelects().find((field) => !field.value || field.selectedIndex === 0);
        return nextBlank ? setSelectValue(nextBlank, value, textPattern) : false;
      }
      return true;
    };
    const getIswcInputs = () => [...document.querySelectorAll(
      'input.value[name^="edit-work.iswcs."], input[name^="edit-work.iswcs."], input[name*="iswcs"]',
    )].filter((field) => field.type !== "hidden");
    const setUniqueIswc = (iswc) => {
      if (!iswc) return true;
      const inputs = getIswcInputs();
      const matched = inputs.find((field) => field.value.trim() === iswc);
      if (matched) {
        markFilled(matched, FILL_OK);
        return true;
      }
      const blank = inputs.find((field) => !field.value.trim());
      if (blank) return setTextInputValue(blank, iswc);
      const container = fieldContainerByText(/\bISWCs?\b/i) || inputs[0]?.closest(".form-row-text-list, fieldset, div");
      if (clickAddControl(container, /add\s+ISWC/i)) {
        const nextBlank = getIswcInputs().find((field) => !field.value.trim());
        return nextBlank ? setTextInputValue(nextBlank, iswc) : false;
      }
      return false;
    };
    const getWorkAttributeRows = () => {
      const typeFields = [...document.querySelectorAll(
        'select[name^="edit-work.attributes."][name$=".type_id"], select[name*="attributes"][name*="type"]',
      )];
      return typeFields.map((type) => {
        const row = fieldRow(type);
        const value = row?.querySelector('input[name^="edit-work.attributes."][name$=".value"], input[name*="attributes"][name*="value"], input[type="text"]');
        return { row, type, value };
      }).filter((item) => item.type && item.value);
    };
    const setKomcaAttribute = (workId) => {
      if (!workId) return true;
      const rows = getWorkAttributeRows();
      const matched = rows.find(({ type, value }) => type.value === WORK_ATTRIBUTE_KOMCA_ID && value.value.trim() === workId);
      if (matched) {
        markFilled(matched.type, FILL_OK);
        markFilled(matched.value, FILL_OK);
        return true;
      }
      const blank = rows.find(({ type, value }) =>
        (!type.value || type.value === WORK_ATTRIBUTE_KOMCA_ID || type.selectedIndex === 0) && !value.value.trim(),
      );
      if (blank) {
        const typeFilled = setSelectValue(blank.type, WORK_ATTRIBUTE_KOMCA_ID);
        const valueFilled = setTextInputValue(blank.value, workId);
        return typeFilled && valueFilled;
      }
      const table = document.querySelector("table#work-attributes");
      const container = table?.closest("fieldset, div") || fieldContainerByText(/work\s+attributes?/i);
      if (clickAddControl(container, /add\s+work\s+attribute/i)) {
        const nextBlank = getWorkAttributeRows().find(({ type, value }) =>
          (!type.value || type.value === WORK_ATTRIBUTE_KOMCA_ID || type.selectedIndex === 0) && !value.value.trim(),
        );
        if (!nextBlank) return false;
        const typeFilled = setSelectValue(nextBlank.type, WORK_ATTRIBUTE_KOMCA_ID);
        const valueFilled = setTextInputValue(nextBlank.value, workId);
        return typeFilled && valueFilled;
      }
      return false;
    };
    const fillFields = () => {
      let filled = true;
      const field = document.querySelector('textarea[name="edit_note"], textarea#edit-note-text, textarea.edit-note');
      if (field && !field.value.trim()) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        if (setter) setter.call(field, note); else field.value = note;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (!field) {
        filled = false;
      }
      filled = setFieldValue(
        'select[name="edit-work.type_id"], input[name="edit-work.type_id"]',
        seedParams.get("komca-work-type"),
      ) && filled;
      if (seedParams.has("komca-no-lyrics")) {
        filled = setNoLyricsLanguage(seedParams.get("komca-no-lyrics")) && filled;
      }
      filled = setKomcaAttribute(seedParams.get("komca-work-id")) && filled;
      if (seedParams.has("komca-iswc")) {
        filled = setUniqueIswc(seedParams.get("komca-iswc")) && filled;
      }
      return filled;
    };
    if (!fillFields()) {
      const observer = new MutationObserver(() => { if (fillFields()) observer.disconnect(); });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 15000);
    }
    return;
  }

  const style = document.createElement("style");
  style.textContent = `
    .komca-mb-import { margin-left:10px; padding:4px 9px; border:1px solid #175cd3; border-radius:4px;
      background:#175cd3; color:#fff; cursor:pointer; font:13px system-ui,sans-serif; }
    .komca-mb-import:disabled { opacity:.7; cursor:default; }
    .komca-mb-creator-id { color:#175cd3; font-weight:600; text-decoration:underline; text-underline-offset:2px; }
    .komca-mb-creator-id:hover { color:#0f3f9e; }
  `;
  document.head.appendChild(style);

  const articles = getKomcaResultContainers();
  if (!articles.length) return;

  articles.forEach((article) => {
    linkKomcaCreatorIds(article);
    const heading = findWorkHeading(article);
    if (!heading) return;
    const openImport = async (button) => {
      try {
        button.disabled = true;
        button.textContent = "Opening MB...";
        const work = readResult(article, location.href);
        const seed = buildMusicBrainzUrl(work);
        window.open(seed.url, "_blank", "noopener");
        button.disabled = false;
        button.textContent = button.dataset.label;
      } catch (error) {
        button.disabled = false;
        button.textContent = button.dataset.label;
        alert(error.message);
      }
    };
    const button = document.createElement("button");
    button.className = "komca-mb-import";
    button.type = "button";
    button.textContent = "Import into MB";
    button.dataset.label = button.textContent;
    heading.appendChild(button);
    button.addEventListener("click", () => { void openImport(button); });

  });
})();
