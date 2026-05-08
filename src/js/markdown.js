// markdown.js — small safe markdown renderer for assistant replies.
//
// Scoped to the patterns LLM output actually uses: headings, bold, italic,
// inline code, fenced code blocks, ordered + unordered lists, and links.
// All HTML is escaped first; the renderer never passes raw HTML through.
// No external dependencies. Streaming-safe — call `renderMarkdown` on the
// raw buffer every chunk; cheap enough.

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// URL-allow filter: only http(s) and mailto links pass through. Anything
// else (javascript:, data:, etc.) becomes a plain text fragment.
function safeHref(url) {
  const trimmed = String(url).trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  return null;
}

// Inline-level transforms applied to a single line of HTML-escaped text.
// Order matters: code spans first, then links, then bold (which uses `**`)
// before italic (which uses `*`) so that `**foo**` doesn't get partially
// matched as italic.
function renderInline(escapedLine) {
  let s = escapedLine;

  // Inline code: `text` — must come before any other inline so that the
  // contents aren't further transformed.
  s = s.replace(/`([^`]+?)`/g, (_, c) => `<code>${c}</code>`);

  // Links: [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    const href = safeHref(url);
    if (!href) return text;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  // Bold: **text** — non-greedy, no inner asterisks.
  s = s.replace(/\*\*([^*]+?)\*\*/g, (_, c) => `<strong>${c}</strong>`);

  // Italic: *text* (single asterisk) — must come after bold. Avoid empty
  // match and don't catch `* ` list-marker leftovers (those were stripped
  // upstream when the line is recognised as a list item).
  s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, (_, pre, c) => `${pre}<em>${c}</em>`);

  // Italic with underscore: _text_ — common alternative.
  s = s.replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, (_, pre, c) => `${pre}<em>${c}</em>`);

  return s;
}

// Block-level renderer: walks lines, handles fenced code blocks, headings,
// ordered + unordered lists, and paragraphs. Single pass, line-based.
export function renderMarkdown(raw) {
  if (raw == null) return '';
  const lines = String(raw).split(/\r?\n/);
  const out = [];

  let i = 0;
  // Buffers for the current open block.
  let para = [];
  let list = null; // { type: 'ul' | 'ol', items: [string, ...] }

  function flushPara() {
    if (para.length === 0) return;
    const content = para.map((l) => renderInline(escapeHtml(l))).join('<br>');
    out.push(`<p>${content}</p>`);
    para = [];
  }
  function flushList() {
    if (!list) return;
    const itemsHtml = list.items.map((item) => `<li>${renderInline(escapeHtml(item))}</li>`).join('');
    out.push(`<${list.type}>${itemsHtml}</${list.type}>`);
    list = null;
  }
  function flushAll() { flushPara(); flushList(); }

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: ``` or ```lang
    const fence = line.match(/^```\s*([\w-]*)\s*$/);
    if (fence) {
      flushAll();
      const lang = fence[1] || '';
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      const langAttr = lang ? ` class="lang-${escapeHtml(lang)}"` : '';
      out.push(`<pre><code${langAttr}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      i++; // skip the closing ```
      continue;
    }

    // Heading: # to ######
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      const text = renderInline(escapeHtml(heading[2]));
      out.push(`<h${level}>${text}</h${level}>`);
      i++;
      continue;
    }

    // Unordered list: - item, * item, + item
    const ulItem = line.match(/^\s*[-*+]\s+(.+?)\s*$/);
    if (ulItem) {
      flushPara();
      if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
      list.items.push(ulItem[1]);
      i++;
      continue;
    }

    // Ordered list: 1. item, 2. item
    const olItem = line.match(/^\s*\d+\.\s+(.+?)\s*$/);
    if (olItem) {
      flushPara();
      if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
      list.items.push(olItem[1]);
      i++;
      continue;
    }

    // Blank line: closes any open block.
    if (/^\s*$/.test(line)) {
      flushAll();
      i++;
      continue;
    }

    // Default: accumulate into the current paragraph.
    flushList();
    para.push(line);
    i++;
  }

  flushAll();
  return out.join('\n');
}
