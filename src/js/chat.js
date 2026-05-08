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
import { renderMarkdown } from './markdown.js';

const STATE = {
  history: [],          // array of { role, content }
  streaming: false,
  unlisten: null,       // chat-chunk event unlisten fn
  currentAssistantEl: null,
  currentAssistantBuffer: '',  // raw markdown buffer for the streaming reply
  inputEl: null,        // cached reference for focusInput()
  sendEl: null,         // cached send button — disabled while streaming
  newChatEl: null,      // "+ New chat" pill — visibility tracks history
  exchangeNum: 0,       // running counter for the meta `.num` label
};

let _activeModel = 'anthropic/claude-sonnet-4.6';

export async function init({ model } = {}) {
  if (model) _activeModel = model;

  const composer = document.querySelector('.composer');
  const input = composer ? composer.querySelector('textarea, input[type="text"]') : null;
  const send = composer ? composer.querySelector('[data-action="send"], button[type="submit"]') : null;
  STATE.inputEl = input;
  STATE.sendEl = send;

  // Submit handler — clears the input immediately so the user gets visible
  // feedback that Send fired, before awaiting the model response. The
  // pending state is signalled by the disabled send button + textarea.
  function submit() {
    if (!input || STATE.streaming) return;
    const text = (input.value || '').trim();
    if (!text) return;
    input.value = '';
    sendMessage(text);
  }

  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });
  }
  if (send) {
    send.addEventListener('click', submit);
  }

  // "New chat" pill — clears conversation history and the rendered scroll.
  // Lives in markup as `[data-action="new-chat"]` inside `.chat`. Hidden
  // by default; revealed once the first message is appended. Disabled
  // while streaming to avoid clearing mid-response.
  STATE.newChatEl = document.querySelector('.chat .chat-action[data-action="new-chat"]');
  if (STATE.newChatEl) {
    STATE.newChatEl.addEventListener('click', () => {
      // Only refuse mid-stream. Otherwise always clear — the chat-scroll
      // can carry static sample exchanges baked into the HTML that
      // aren't tracked in STATE.history; "Clear" should mean "clear
      // what I see", not "clear what state thinks I have".
      if (STATE.streaming) return;
      clearChat();
    });
    // Visual state tracks DOM content rather than internal history.
    refreshNewChatVisualState();
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
  setComposerEnabled(false);

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
        if ((finalText || '').length > STATE.currentAssistantBuffer.length) {
          STATE.currentAssistantBuffer = finalText || '';
          body.innerHTML = renderMarkdown(STATE.currentAssistantBuffer);
        }
      }
      STATE.history.push({ role: 'assistant', content: finalText || '' });
    } else {
      // Preview: synthetic echo so the chat feels alive.
      await new Promise((r) => setTimeout(r, 250));
      const reply = `(preview) Echo: ${content}`;
      if (STATE.currentAssistantEl) {
        const body = STATE.currentAssistantEl.querySelector('.exchange-body') || STATE.currentAssistantEl;
        STATE.currentAssistantBuffer = reply;
        body.innerHTML = renderMarkdown(reply);
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
    STATE.currentAssistantBuffer = '';
    setComposerEnabled(true);
    focusInput();
  }
}

function setComposerEnabled(enabled) {
  if (STATE.inputEl) STATE.inputEl.disabled = !enabled;
  if (STATE.sendEl) STATE.sendEl.disabled = !enabled;
  // The "New chat" pill stays clickable always; visual dim tracks
  // whether there's anything to clear and whether we're streaming.
  refreshNewChatVisualState();
}

// Visual dim only — the click handler itself guards behaviour. The
// `is-dim` class drops opacity to 0.35 so the user sees the button is
// inactive, but clicks still reach the handler and are no-op'd inside.
// This is more robust than `disabled` against any quirk where a click
// is silently swallowed by an attribute change between mousedown/up.
//
// "Has content" is read from the DOM, not from STATE — the chat-scroll
// can carry static sample exchanges that aren't in STATE.history.
function refreshNewChatVisualState() {
  if (!STATE.newChatEl) return;
  const scroll = document.querySelector('.chat-scroll');
  const hasContent = !!(scroll && scroll.firstElementChild);
  const inactive = STATE.streaming || !hasContent;
  STATE.newChatEl.classList.toggle('is-dim', inactive);
}

// Clear the rendered transcript and the in-memory history. Re-focuses the
// composer so the next prompt can be typed without clicking back. Does
// nothing while a response is streaming — guard at the call site, but
// repeated here defensively so direct callers can't break the streaming
// invariant.
export function clearChat() {
  if (STATE.streaming) return;
  STATE.history = [];
  STATE.exchangeNum = 0;
  STATE.currentAssistantEl = null;
  STATE.currentAssistantBuffer = '';
  const scroll = document.querySelector('.chat-scroll');
  if (scroll) {
    while (scroll.firstChild) scroll.removeChild(scroll.firstChild);
    scroll.scrollTop = 0;
  }
  refreshNewChatVisualState();
  focusInput();
}

// Pull a short, gutter-friendly speaker label from the active model id.
// `anthropic/claude-sonnet-4.6` -> `Claude` ; `openai/gpt-4o` -> `GPT-4o` ;
// fallback: the part after `/`, capitalised. The full identifier remains
// visible in the top header bar; the per-message label is for legibility
// inside a 56px gutter.
function shortModelLabel(model) {
  if (!model) return 'model';
  const tail = String(model).split('/').pop() || model;
  // Map the common families to a friendly short name.
  if (/claude/i.test(tail)) return 'Claude';
  if (/^gpt[-_]?(\w+)/i.test(tail)) return tail.replace(/^gpt[-_]?/i, 'GPT-');
  if (/gemini/i.test(tail)) return 'Gemini';
  if (/llama/i.test(tail)) return 'Llama';
  if (/mistral/i.test(tail)) return 'Mistral';
  if (/qwen/i.test(tail)) return 'Qwen';
  // Fallback: take the leading word fragment up to first separator.
  const first = tail.split(/[-_.\s]/)[0] || tail;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function nowHms() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}·${pad(d.getMinutes())}·${pad(d.getSeconds())}`;
}

function appendUserMessage(text) {
  const scroll = document.querySelector('.chat-scroll');
  if (!scroll) return;
  STATE.exchangeNum += 1;
  const article = document.createElement('article');
  article.className = 'exchange user';
  const num = String(STATE.exchangeNum).padStart(2, '0');
  article.innerHTML = `
    <header class="exchange-meta">
      <span class="num">${num}</span>
      <span class="who">You</span>
      <span class="time">${nowHms()}</span>
    </header>
    <div class="exchange-body"></div>
  `;
  // User input is rendered as plain text — never run user input through
  // the markdown parser. Preserve newlines as line breaks.
  const body = article.querySelector('.exchange-body');
  body.textContent = text;
  scroll.appendChild(article);
  scroll.scrollTop = scroll.scrollHeight;
  refreshNewChatVisualState();
}

function beginAssistantMessage() {
  const scroll = document.querySelector('.chat-scroll');
  if (!scroll) return;
  STATE.exchangeNum += 1;
  const article = document.createElement('article');
  // The `streaming` class drives the blinking ▍ caret-indicator on the
  // last paragraph. Removed in sendMessage's finally block once the
  // response settles so the caret doesn't keep blinking after the
  // model finishes.
  article.className = 'exchange model streaming';
  const num = String(STATE.exchangeNum).padStart(2, '0');
  const who = escapeHtml(shortModelLabel(_activeModel));
  article.innerHTML = `
    <header class="exchange-meta" title="${escapeHtml(_activeModel)}">
      <span class="num">${num}</span>
      <span class="who">${who}</span>
      <span class="time">${nowHms()}</span>
    </header>
    <div class="exchange-body"></div>
  `;
  scroll.appendChild(article);
  scroll.scrollTop = scroll.scrollHeight;
  STATE.currentAssistantEl = article;
  STATE.currentAssistantBuffer = '';
  refreshNewChatVisualState();
}

function appendChunkToCurrent(chunk) {
  if (!STATE.currentAssistantEl) return;
  const body = STATE.currentAssistantEl.querySelector('.exchange-body') || STATE.currentAssistantEl;
  // Chunks may be { delta: "text" } or just a string — accept both.
  let text = '';
  if (typeof chunk === 'string') text = chunk;
  else if (chunk && typeof chunk.delta === 'string') text = chunk.delta;
  else if (chunk && typeof chunk.content === 'string') text = chunk.content;
  if (text) {
    STATE.currentAssistantBuffer += text;
    // Re-render the full buffer through the markdown parser. Fast enough
    // for a single message; keeps formatting correct while streaming.
    body.innerHTML = renderMarkdown(STATE.currentAssistantBuffer);
  }

  const scroll = document.querySelector('.chat-scroll');
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
