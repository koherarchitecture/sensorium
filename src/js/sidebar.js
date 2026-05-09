// sidebar.js — conversation history sidebar (v0.1.2).
//
// Surfaces the user's prior conversations as a slide-out drawer on
// the left edge of the chat surface. Search input at the top filters
// the visible list by title or content match (server-side substring
// search via the Conversations.search IPC; the result list rebuilds
// in place). Click a row to load it into the chat pane via
// chat.loadConversation.
//
// Architecture:
// - This module owns nothing about persistence; that's the Rust layer's
//   job, surfaced through ipc.js's Conversations wrapper.
// - It listens to chat.onConversationChange so the list refreshes
//   automatically when a new exchange is saved (no polling).
// - All IO is opportunistic: failures log to console without breaking
//   the UI. The sidebar simply shows an empty list if the IPC errors.

import { isTauri, Conversations } from './ipc.js';
import { onConversationChange, loadConversation, currentConversationId } from './chat.js';

const STATE = {
  drawer: null,           // .conversations-drawer
  toggleBtn: null,        // [data-action="toggle-conversations"]
  closeBtn: null,         // .conversations-close
  searchInput: null,      // .conversations-search input
  listEl: null,           // .conversations-list
  emptyEl: null,          // .conversations-empty
  refreshTimer: null,     // debounce handle for refresh()
  searchTimer: null,      // debounce handle for search-on-keystroke
  lastQuery: '',
};

// Public entry point. Wires DOM, registers listeners, primes the list.
export async function init() {
  STATE.drawer = document.querySelector('.conversations-drawer');
  STATE.toggleBtn = document.querySelector('[data-action="toggle-conversations"]');
  STATE.closeBtn = STATE.drawer ? STATE.drawer.querySelector('.conversations-close') : null;
  STATE.searchInput = STATE.drawer ? STATE.drawer.querySelector('.conversations-search input') : null;
  STATE.listEl = STATE.drawer ? STATE.drawer.querySelector('.conversations-list') : null;
  STATE.emptyEl = STATE.drawer ? STATE.drawer.querySelector('.conversations-empty') : null;

  if (!STATE.drawer || !STATE.toggleBtn) {
    // Markup absent — preview HTML may not have it. Bail silently.
    return;
  }

  STATE.toggleBtn.addEventListener('click', () => {
    const open = STATE.drawer.classList.toggle('is-open');
    if (open) {
      // Refresh the list whenever the drawer opens — cheap, ensures
      // the user sees the most current state even if the auto-refresh
      // fired while the drawer was hidden.
      refresh();
      if (STATE.searchInput) {
        try { STATE.searchInput.focus(); } catch (_) {}
      }
    }
  });

  if (STATE.closeBtn) {
    STATE.closeBtn.addEventListener('click', () => {
      STATE.drawer.classList.remove('is-open');
    });
  }

  if (STATE.searchInput) {
    STATE.searchInput.addEventListener('input', () => {
      // Debounce keystrokes so we don't fire an IPC per character.
      clearTimeout(STATE.searchTimer);
      STATE.searchTimer = setTimeout(() => {
        STATE.lastQuery = (STATE.searchInput.value || '').trim();
        refresh();
      }, 180);
    });
  }

  // Refresh the list whenever a new exchange is saved.
  onConversationChange(() => {
    // Debounce a burst of saves (user + assistant pair) into one repaint.
    clearTimeout(STATE.refreshTimer);
    STATE.refreshTimer = setTimeout(refresh, 100);
  });

  // Prime the list at startup so the drawer's first open is instant.
  refresh();
}

// Re-fetch and re-render the conversation list. Honours the active
// search query — if STATE.lastQuery is non-empty, hits override the
// flat list so titles and matching content lines both appear.
async function refresh() {
  if (!STATE.listEl) return;
  if (!isTauri) {
    // Preview mode: show an empty-state hint and bail.
    renderEmpty('Conversation history is available in the desktop app.');
    return;
  }

  try {
    if (STATE.lastQuery) {
      const hits = await Conversations.search(STATE.lastQuery);
      renderHits(hits);
    } else {
      const entries = await Conversations.list();
      renderList(entries);
    }
  } catch (err) {
    console.warn('conversations refresh failed:', err);
    renderEmpty('Couldn’t load conversations.');
  }
}

function renderEmpty(message) {
  if (!STATE.listEl) return;
  STATE.listEl.innerHTML = '';
  if (STATE.emptyEl) {
    STATE.emptyEl.textContent = message;
    STATE.emptyEl.style.display = '';
  }
}

function renderList(entries) {
  if (!STATE.listEl) return;
  STATE.listEl.innerHTML = '';
  if (!entries || entries.length === 0) {
    renderEmpty('No saved conversations yet. Send a message to start one.');
    return;
  }
  if (STATE.emptyEl) STATE.emptyEl.style.display = 'none';

  const activeId = currentConversationId();
  const frag = document.createDocumentFragment();
  for (const entry of entries) {
    frag.appendChild(buildEntryRow(entry, activeId === entry.id));
  }
  STATE.listEl.appendChild(frag);
}

function renderHits(hits) {
  if (!STATE.listEl) return;
  STATE.listEl.innerHTML = '';
  if (!hits || hits.length === 0) {
    renderEmpty('No matches.');
    return;
  }
  if (STATE.emptyEl) STATE.emptyEl.style.display = 'none';

  const activeId = currentConversationId();
  const frag = document.createDocumentFragment();
  for (const hit of hits) {
    frag.appendChild(buildHitRow(hit, activeId === hit.conversation_id));
  }
  STATE.listEl.appendChild(frag);
}

function buildEntryRow(entry, isActive) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'conversation-row' + (isActive ? ' is-active' : '');
  row.dataset.conversationId = entry.id;
  row.innerHTML = `
    <div class="conversation-title"></div>
    <div class="conversation-meta">
      <span class="meta-when"></span>
      <span class="meta-count"></span>
    </div>
  `;
  row.querySelector('.conversation-title').textContent = entry.title;
  row.querySelector('.meta-when').textContent = formatRelativeTime(entry.last_at_iso);
  const exch = entry.exchange_count;
  row.querySelector('.meta-count').textContent =
    exch === 1 ? '1 exchange' : `${exch} exchanges`;
  row.addEventListener('click', () => activateRow(entry.id));
  return row;
}

function buildHitRow(hit, isActive) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'conversation-row conversation-hit' + (isActive ? ' is-active' : '');
  row.dataset.conversationId = hit.conversation_id;
  row.innerHTML = `
    <div class="conversation-title"></div>
    <div class="conversation-snippet"></div>
    <div class="conversation-meta">
      <span class="meta-role"></span>
    </div>
  `;
  row.querySelector('.conversation-title').textContent = hit.conversation_title;
  row.querySelector('.conversation-snippet').textContent = hit.snippet;
  row.querySelector('.meta-role').textContent =
    hit.role === 'title' ? 'title match' : `${hit.role} · #${hit.exchange_index + 1}`;
  row.addEventListener('click', () => activateRow(hit.conversation_id));
  return row;
}

async function activateRow(conversationId) {
  await loadConversation(conversationId);
  // Close the drawer after load so the chat is unobstructed.
  if (STATE.drawer) STATE.drawer.classList.remove('is-open');
  // Mark the active row visually for the next open.
  refreshActiveHighlight(conversationId);
}

function refreshActiveHighlight(activeId) {
  if (!STATE.listEl) return;
  for (const row of STATE.listEl.querySelectorAll('.conversation-row')) {
    if (row.dataset.conversationId === activeId) {
      row.classList.add('is-active');
    } else {
      row.classList.remove('is-active');
    }
  }
}

// Render an ISO timestamp as a short relative-time string. Today => HH:MM.
// Within the last week => weekday name. Otherwise => short date.
function formatRelativeTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const diffMs = now.getTime() - d.getTime();
  const oneDay = 24 * 60 * 60 * 1000;

  if (sameDay) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (diffMs < 7 * oneDay) {
    return d.toLocaleDateString(undefined, { weekday: 'short' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
