// calibration-strip.js — bottom status strip live state.
//
// The strip shows runtime connection status: calibration progress,
// Ollama reachability, OpenRouter connection. The CALIBRATION value
// is the only one driven by the Fingerprint in v0.1; OLLAMA and
// OPENROUTER are updated by polling the corresponding IPC commands
// when they're called from elsewhere (settings modal, first-run,
// etc.). Persistence + tracking-since-launch is deferred to v0.2.

export function applyFingerprint(fp) {
  if (!fp) return;
  const calibrationVal = findVal('CALIBRATION');
  if (calibrationVal) {
    const total = fp.total_probes || 0;
    calibrationVal.textContent = `complete · ${total}/${total}`;
  }
}

export function setCalibrationRunning() {
  const v = findVal('CALIBRATION');
  if (v) v.textContent = 'running…';
}

// Status object is the Rust OllamaStatus serde shape:
//   { reachable, base_url, installed_models, default_model_present,
//     recommended_model, error }
export function setOllama(status) {
  const v = findVal('OLLAMA');
  if (!v) return;
  if (!status) { v.textContent = 'unknown'; return; }
  const model = status.recommended_model || 'qwen2.5';
  if (status.reachable && status.default_model_present) v.textContent = `${model} · reachable`;
  else if (status.reachable) v.textContent = `${model} · not pulled`;
  else v.textContent = 'daemon down';
}

export function setOpenRouter(connected) {
  const v = findVal('OPENROUTER');
  if (!v) return;
  v.textContent = connected ? 'connected' : 'no key';
}

function findVal(keyText) {
  const indicators = document.querySelectorAll('.status .indicator');
  for (const ind of indicators) {
    const key = ind.querySelector('.key');
    if (key && key.textContent.trim().toUpperCase() === keyText.toUpperCase()) {
      return ind.querySelector('.val');
    }
  }
  return null;
}
