// Ollama client — talks to the user's locally-running Ollama daemon
// at localhost:11434. Sensorium does not bundle Ollama; it is a hard
// runtime dependency the user installs themselves.

mod client;

pub use client::{OllamaClient, OllamaStatus, PullProgress};
