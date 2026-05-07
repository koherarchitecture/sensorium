// chat.js — chat pane state machine.
//
// Sends user messages through `send_chat_message` and renders streamed
// chunks emitted by the Rust core on the `chat-chunk` event. v0.1 holds
// the conversation history in renderer state and replays it on each
// send (the IPC stub takes a single content string + model — history
// shape is to be agreed on the Rust side; see BUILD-STATUS Open
// Questions). Until the runner is wired, this module gracefully
// surfaces errors without breaking the UI.

import { isTauri, Chat } from './ipc.js';

const STATE = {
  history: [],          // array of { role, content }
  streaming: false,
  unlisten: null,       // chat-chunk event unlisten fn
  currentAssistantEl: null,
  inputEl: null,        // cached reference for focusInput()
};

let _activeModel = 'anthropic/claude-sonnet-4.6';

export async function init({ model } = {}) {
  if (model) _activeModel = model;

  const composer = document.querySelector('.composer');
  const input = composer ? composer.querySelector('textarea, input[type="text"]') : null;
  const send = composer ? composer.querySelector('[data-action="send"], button[type="submit"]') : null;
  STATE.inputEl = input;

  // Enter to send (Shift+Enter for newline).
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = (input.value || '').trim();
        if (text) sendMessage(text).then(() => { input.value = ''; });
      }
    });
  }

  if (send) {
    send.addEventListener('click', () => {
      if (!input) return;
      const text = (input.value || '').trim();
      if (text) sendMessage(text).then(() => { input.value = ''; });
    });
  }

  // Wire chat-chunk event listener.
  if (isTauri) {
    try {
      STATE.unlisten = await Chat.onChunk((event) => {
        const chunk = event && event.payload ? event.payload : event;
        appendChunkToCurrent(chunk);
      });
    } catch (_) { /* listener unavailable; non-fatal */ }
  }

  // Land the caret in the composer when the wizard is not active.
  // app.js will call focusInput() again after wizard.onComplete to
  // shift focus from the wizard's last input back to the composer.
  if (input && document.body.getAttribute('data-first-run') !== 'true') {
    input.focus();
  }
}

export function setModel(model) {
  _activeModel = model;
}

/// Place the caret in the composer textarea. Safe to call multiple times.
export function focusInput() {
  if (STATE.inputEl) {
    try { STATE.inputEl.focus(); } catch (_) {}
  }
}

export async function sendMessage(content) {
  if (STATE.streaming) return;
  STATE.streaming = true;

  STATE.history.push({ role: 'user', content });
  appendUserMessage(content);
  beginAssistantMessage();

  try {
    if (isTauri) {
      // The IPC handler takes (model, messages) — the full transcript
      // including the new user turn we just pushed. Chunks arrive via
      // the chat-chunk event. The returned string is the final
      // assembled text for archival.
      const finalText = await Chat.send(_activeModel, STATE.history);
      // If the listener missed chunks (or this build returns the full
      // text in one go), settle the assistant bubble with finalText.
      if (STATE.currentAssistantEl) {
        const body = STATE.currentAssistantEl.querySelector('.exchange-body') || STATE.currentAssistantEl;
        if (!body.textContent || body.textContent.length < (finalText || '').length) {
          body.textContent = finalText || '';
        }
      }
      STATE.history.push({ role: 'assistant', content: finalText || '' });
    } else {
      // Preview: synthetic echo so the chat feels alive.
      await new Promise((r) => setTimeout(r, 250));
      const reply = `(preview) Echo: ${content}`;
      if (STATE.currentAssistantEl) {
        const body = STATE.currentAssistantEl.querySelector('.exchange-body') || STATE.currentAssistantEl;
        body.textContent = reply;
      }
      STATE.history.push({ role: 'assistant', content: reply });
    }
  } catch (err) {
    if (STATE.currentAssistantEl) {
      const body = STATE.currentAssistantEl.querySelector('.exchange-body') || STATE.currentAssistantEl;
      const msg = (err && err.message) ? err.message : String(err);
      body.textContent = `[chat error] ${msg}`;
    }
  } finally {
    if (STATE.currentAssistantEl) {
      STATE.currentAssistantEl.classList.remove('streaming');
    }
    STATE.streaming = false;
    STATE.currentAssistantEl = null;
  }
}

function appendUserMessage(text) {
  const scroll = document.querySelector('.chat-scroll');
  if (!scroll) return;
  const article = document.createElement('article');
  article.className = 'exchange user';
  article.innerHTML = `
    <header class="exchange-meta">you</header>
    <div class="exchange-body"></div>
  `;
  article.querySelector('.exchange-body').textContent = text;
  scroll.appendChild(article);
  scroll.scrollTop = scroll.scrollHeight;
}

function beginAssistantMessage() {
  const scroll = document.querySelector('.chat-scroll');
  if (!scroll) return;
  const article = document.createElement('article');
  // The `streaming` class drives the blinking ▍ caret-indicator on the
  // last paragraph. Removed in sendMessage's finally block once the
  // response settles so the caret doesn't keep blinking after the
  // model finishes.
  article.className = 'exchange model streaming';
  article.innerHTML = `
    <header class="exchange-meta">${escapeHtml(_activeModel)}</header>
    <div class="exchange-body"></div>
  `;
  scroll.appendChild(article);
  scroll.scrollTop = scroll.scrollHeight;
  STATE.currentAssistantEl = article;
}

function appendChunkToCurrent(chunk) {
  if (!STATE.currentAssistantEl) return;
  const body = STATE.currentAssistantEl.querySelector('.exchange-body') || STATE.currentAssistantEl;
  // Chunks may be { delta: "text" } or just a string — accept both.
  let text = '';
  if (typeof chunk === 'string') text = chunk;
  else if (chunk && typeof chunk.delta === 'string') text = chunk.delta;
  else if (chunk && typeof chunk.content === 'string') text = chunk.content;
  if (text) body.textContent += text;

  const scroll = document.querySelector('.chat-scroll');
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
