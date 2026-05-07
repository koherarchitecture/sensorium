// Provider integration. v0.1: OpenRouter only.
// One key, two purposes — chat (any model) + narration (Haiku 4.5 fixed).

mod openrouter;

pub use openrouter::{
    ChatChunk, ChatMessageInput, ChatOpts, CompletionResult, ModelInfo,
    OpenRouterClient, NARRATOR_MODEL,
};
