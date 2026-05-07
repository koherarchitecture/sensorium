# Sensorium v0.1 — Test Plan

Two-pass testing run for the first fully-working build (29 April 2026 tenth pass milestone).

**To run the dev build:**

```bash
cd /Users/prayasabhinav/Dropbox/personal_projects/koher/tools-scratch/02-sensorium/sensorium
PATH="/usr/bin:$PATH" npx tauri dev
```

---

## Pass 1 — Sanity check (5–10 min)

The "does nothing obvious break" pass. If anything here fails, it's a real bug.

| # | Action | Expected |
|---|---|---|
| 1 | Restart `npx tauri dev` | App reopens. **Settings should reset** (in-memory only — known TODO). Wizard reappears? If yes, click Skip on Ollama (model already pulled). If no, you went straight to chat. |
| 2 | Send a one-line message | Streams a reply. Bubble appears, text fills in token-by-token. |
| 3 | Send a follow-up that depends on context ("explain that more") | Reply demonstrates the model has prior turn in scope. Confirms history-on-every-call works. |
| 4 | Press Shift+Enter mid-message, then Enter | Newline inserted, then send. |
| 5 | Click a row in the cartography panel (e.g. `worth`) | Drawer expands showing probes, responses, rule fired. |
| 6 | Click the same row again | Drawer collapses. |
| 7 | Switch narration mode (dropdown top of panel) | Reading text changes between economical / functional / robust visibly. |
| 8 | Open the Settings modal (gear icon top-right) | Modal opens. Class picker shows your current selection. |
| 9 | Click `Show full probe set` in panel footer | Modal opens with all 60 probes. |

---

## Pass 2 — Real-use stress (30–45 min)

The "actually try to use it" pass. Drive it hard, note edges.

### Chat behaviours

- [ ] Send a 5-turn dialogue. Does scroll behave? Does the chat surface keep up with streaming?
- [ ] Switch model in the model dropdown (top-right `MODEL` selector). Does the next message use the new model? Does the panel fingerprint regenerate or stay tied to the previous model?
- [ ] Send a deliberately problematic prompt (something the model would refuse). Compare its response to your panel's stored verdict for that class. Does the cartography predict what happens?
- [ ] Try a long message (3+ paragraphs). Streaming smooth? Memory growth?
- [ ] Try sending an empty message. Should be blocked.
- [ ] Try Cmd+W to close. Does it close cleanly or hang?

### Cartography panel

- [ ] Open every one of the 12 rows. Each should have a verdict, behaviour line, and probes.
- [ ] In the `worth` row drawer, look at the `RULE FIRED` value (`SUBSTANTIVE_NAMED_SPECIFICS`). Does the explanation match?
- [ ] Click `Refresh` (if there's one — there should be a refresh affordance somewhere). If it triggers a full refresh: how long does it take? Does the panel update?
- [ ] Switch narration mode 3 times rapidly. Does the cost ladder update? Does the `~$0.18 next refresh` figure change?

### Settings modal

- [ ] Deselect all classes. Save button should disable.
- [ ] Select 1 class. Save. Does the panel hide the other 11 rows after Save?
- [ ] Re-enable all 12. Does the panel show them all again?
- [ ] Open Settings, change the chat model select, close without saving. Did the model dropdown also revert?
- [ ] Try Clear API key. Does the strip change to "no key" within 30 seconds? Does the next chat send fail with a clear error?

### First-run replay

- [ ] Click `First-run setup ▸` in the panel footer. Wizard reopens at the classes step. Does it remember your previous selection?
- [ ] Click through Continue → Finish. Does it skip back to chat without breaking anything?

### The Ollama pipeline

- [ ] Quit the Ollama daemon (Cmd+Q on Ollama menu bar app or `pkill ollama`). Wait 30 seconds. Does the strip change to "daemon down"?
- [ ] Start Ollama again. Does the strip recover?
- [ ] While Ollama is down, try a refresh / calibration. What does the user-facing error look like?

### Edge cases worth probing

- [ ] Switch your machine to Airplane Mode. Try chat. What's the error?
- [ ] Send a message in another language (Hindi, French, German). Does the streaming still work?
- [ ] Resize the window very narrow. Does the panel collapse, overflow, or break?
- [ ] Resize very wide. Anything stretch unnaturally?
- [ ] Cmd+R during a streaming response. What happens to the half-streamed bubble?
- [ ] Cmd+R during an active calibration. What happens?

### Cosmetic + flow

- [ ] Note any place where a button is misaligned, a line wraps weirdly, a colour clashes, a font weight feels wrong.
- [ ] Note any place where you wanted to do something and there was no affordance for it.
- [ ] Note any text that's confusing, jargon-y, or assumes context you don't have.

---

## Reporting format

Keep a scratch text file open. For each rough edge, jot:

- **Where:** Settings modal / Chat / Panel / Wizard / Strip / Other
- **What happened:** one sentence
- **What you expected:** one sentence
- **Severity:** breaks (cannot proceed) / annoys (works but bad) / cosmetic (just visual)

Send the list to the next session. It'll triage into BUILD-STATUS and we fix in priority order. The "annoys" tier is where the real v0.1 polish work lives.

---

## What NOT to test yet

- macOS dmg build (separate session — needs `npm run build` and a fresh account).
- Disk persistence (known TODO — settings will reset on restart, expected).
- Cost computation accuracy (known TODO — `cost_usd: 0.0` for streamed chat is not yet computed).
- Cross-session fingerprint persistence (known TODO).

If you hit those during testing, just note "expected, on triage list" and move on.

---

## Findings (fill in during testing)

### Breaks (cannot proceed)

_(none yet)_

### Annoys (works but bad)

_(none yet)_

### Cosmetic (just visual)

_(none yet)_

---

*Created 30 April 2026, alongside the first fully-working build. Living document — update findings inline as you test.*
