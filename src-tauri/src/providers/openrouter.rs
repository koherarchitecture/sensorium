use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

const BASE_URL: &str = "https://openrouter.ai/api/v1";
const HTTP_TIMEOUT: Duration = Duration::from_secs(60);

/// Fixed narration model — never user-overridable per spec §6.1.
pub const NARRATOR_MODEL: &str = "anthropic/claude-haiku-4.5";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub context_length: Option<u32>,
    pub pricing_in: Option<f64>,
    pub pricing_out: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionResult {
    pub text: String,
    pub tokens_in: u32,
    pub tokens_out: u32,
    pub latency_ms: u64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatChunk {
    pub delta: String,
    pub done: bool,
}

#[derive(Debug, Clone)]
pub struct ChatOpts {
    pub max_tokens: Option<u32>,
    pub temperature: f32,
    pub stop: Option<Vec<String>>,
}

impl Default for ChatOpts {
    fn default() -> Self {
        Self { max_tokens: None, temperature: 0.7, stop: None }
    }
}

pub struct OpenRouterClient {
    api_key: String,
    http: reqwest::Client,
}

impl OpenRouterClient {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            http: reqwest::Client::builder()
                .timeout(HTTP_TIMEOUT)
                .build()
                .expect("reqwest client"),
        }
    }

    pub async fn list_models(&self) -> Result<Vec<ModelInfo>> {
        let url = format!("{}/models", BASE_URL);
        let resp: ModelsResponse = self
            .http
            .get(&url)
            .bearer_auth(&self.api_key)
            .header("HTTP-Referer", "https://koher.app/sensorium")
            .header("X-Title", "Sensorium")
            .send()
            .await
            .context("openrouter list_models request failed")?
            .json()
            .await
            .context("openrouter list_models JSON parse failed")?;

        Ok(resp
            .data
            .into_iter()
            .map(|m| ModelInfo {
                id: m.id,
                name: m.name.unwrap_or_default(),
                context_length: m.context_length,
                pricing_in: m.pricing.as_ref().and_then(|p| p.prompt.parse().ok()),
                pricing_out: m.pricing.as_ref().and_then(|p| p.completion.parse().ok()),
            })
            .collect())
    }

    /// Single-shot completion. Used by the probe runner.
    pub async fn complete(
        &self,
        model: &str,
        prompt: &str,
        opts: ChatOpts,
    ) -> Result<CompletionResult> {
        let body = ChatRequest {
            model: model.to_string(),
            messages: vec![ChatRequestMessage {
                role: "user".into(),
                content: prompt.to_string(),
            }],
            max_tokens: opts.max_tokens,
            temperature: opts.temperature,
            stream: false,
            stop: opts.stop,
        };

        let started = Instant::now();
        let url = format!("{}/chat/completions", BASE_URL);
        let resp: ChatCompletionResponse = self
            .http
            .post(&url)
            .bearer_auth(&self.api_key)
            .header("HTTP-Referer", "https://koher.app/sensorium")
            .header("X-Title", "Sensorium")
            .json(&body)
            .send()
            .await
            .context("openrouter complete request failed")?
            .json()
            .await
            .context("openrouter complete JSON parse failed")?;

        let latency_ms = started.elapsed().as_millis() as u64;

        let choice = resp
            .choices
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("openrouter response had no choices"))?;
        let text = choice.message.content.unwrap_or_default();
        let usage = resp.usage.unwrap_or_default();

        // Cost computed from pricing tables would be more accurate;
        // for v0.1 the estimate is good enough for budget tracking.
        // Real cost arrives in usage.cost when OpenRouter provides it.
        let cost_usd = usage.cost.unwrap_or(0.0);

        Ok(CompletionResult {
            text,
            tokens_in: usage.prompt_tokens.unwrap_or(0),
            tokens_out: usage.completion_tokens.unwrap_or(0),
            latency_ms,
            cost_usd,
        })
    }

    /// Streaming chat completion. Yields ChatChunks until done.
    pub async fn chat_stream<F>(
        &self,
        model: &str,
        messages: &[ChatMessageInput],
        opts: ChatOpts,
        mut on_chunk: F,
    ) -> Result<CompletionResult>
    where
        F: FnMut(ChatChunk),
    {
        let request_messages: Vec<ChatRequestMessage> = messages
            .iter()
            .map(|m| ChatRequestMessage {
                role: m.role.clone(),
                content: m.content.clone(),
            })
            .collect();

        let body = ChatRequest {
            model: model.to_string(),
            messages: request_messages,
            max_tokens: opts.max_tokens,
            temperature: opts.temperature,
            stream: true,
            stop: opts.stop,
        };

        let started = Instant::now();
        let url = format!("{}/chat/completions", BASE_URL);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.api_key)
            .header("HTTP-Referer", "https://koher.app/sensorium")
            .header("X-Title", "Sensorium")
            .json(&body)
            .send()
            .await
            .context("openrouter chat_stream request failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!("openrouter chat_stream status {}: {}", status, body));
        }

        let mut text = String::new();
        let mut tokens_in = 0u32;
        let mut tokens_out = 0u32;
        let mut buffer = String::new();

        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.context("stream read error")?;
            buffer.push_str(&String::from_utf8_lossy(&bytes));

            // SSE frames are separated by "\n\n"; each line begins with "data: "
            while let Some(idx) = buffer.find("\n\n") {
                let frame = buffer[..idx].to_string();
                buffer = buffer[idx + 2..].to_string();
                for line in frame.lines() {
                    let line = line.trim();
                    if !line.starts_with("data: ") {
                        continue;
                    }
                    let payload = &line[6..];
                    if payload == "[DONE]" {
                        on_chunk(ChatChunk { delta: String::new(), done: true });
                        continue;
                    }
                    let parsed: serde_json::Value = match serde_json::from_str(payload) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if let Some(choices) = parsed.get("choices").and_then(|v| v.as_array()) {
                        if let Some(c) = choices.first() {
                            if let Some(delta) =
                                c.get("delta").and_then(|d| d.get("content")).and_then(|c| c.as_str())
                            {
                                if !delta.is_empty() {
                                    text.push_str(delta);
                                    on_chunk(ChatChunk { delta: delta.to_string(), done: false });
                                }
                            }
                        }
                    }
                    if let Some(usage) = parsed.get("usage") {
                        if let Some(p) = usage.get("prompt_tokens").and_then(|v| v.as_u64()) {
                            tokens_in = p as u32;
                        }
                        if let Some(c) = usage.get("completion_tokens").and_then(|v| v.as_u64()) {
                            tokens_out = c as u32;
                        }
                    }
                }
            }
        }

        let latency_ms = started.elapsed().as_millis() as u64;
        Ok(CompletionResult {
            text,
            tokens_in,
            tokens_out,
            latency_ms,
            cost_usd: 0.0, // streamed responses don't include cost in SSE; compute from pricing tables
        })
    }
}

#[derive(Debug, Clone)]
pub struct ChatMessageInput {
    pub role: String,
    pub content: String,
}

// ── HTTP body shapes ──────────────────────────────────────────────

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatRequestMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    temperature: f32,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize)]
struct ChatRequestMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
    usage: Option<Usage>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatChoiceMessage,
}

#[derive(Deserialize)]
struct ChatChoiceMessage {
    content: Option<String>,
}

#[derive(Default, Deserialize)]
struct Usage {
    prompt_tokens: Option<u32>,
    completion_tokens: Option<u32>,
    cost: Option<f64>,
}

#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<ModelInfoRaw>,
}

#[derive(Deserialize)]
struct ModelInfoRaw {
    id: String,
    name: Option<String>,
    context_length: Option<u32>,
    pricing: Option<PricingRaw>,
}

#[derive(Deserialize)]
struct PricingRaw {
    prompt: String,
    completion: String,
}

// Auth-key endpoint shape — describes the user's current usage and
// any rate / spend limits OpenRouter has on their key.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageInfo {
    /// Cumulative spend in USD for the current period (across the key).
    pub usage: f64,
    /// Hard limit in USD; None means no fixed ceiling.
    pub limit: Option<f64>,
    /// Optional human label OpenRouter stores against the key.
    pub label: Option<String>,
    /// Whether the underlying key is configured as free-tier (true) or
    /// paid (false / null on response). Surfaced for UI hint only.
    pub is_free_tier: Option<bool>,
}

#[derive(Deserialize)]
struct AuthKeyResponse {
    data: AuthKeyData,
}

#[derive(Deserialize)]
struct AuthKeyData {
    usage: Option<f64>,
    limit: Option<f64>,
    label: Option<String>,
    is_free_tier: Option<bool>,
}

impl OpenRouterClient {
    /// Query OpenRouter's `/api/v1/auth/key` endpoint for the key's
    /// current usage + limit. Used to populate the user-side cost
    /// surface (the cost-line on the cartography panel).
    ///
    /// Telemetry-not-introspection: the position is about the model;
    /// the user's own spend is fair to surface.
    pub async fn usage(&self) -> Result<UsageInfo> {
        let url = format!("{}/auth/key", BASE_URL);
        let resp: AuthKeyResponse = self
            .http
            .get(&url)
            .bearer_auth(&self.api_key)
            .header("HTTP-Referer", "https://koher.app/sensorium")
            .header("X-Title", "Sensorium")
            .send()
            .await
            .context("openrouter usage request failed")?
            .json()
            .await
            .context("openrouter usage JSON parse failed")?;
        Ok(UsageInfo {
            usage: resp.data.usage.unwrap_or(0.0),
            limit: resp.data.limit,
            label: resp.data.label,
            is_free_tier: resp.data.is_free_tier,
        })
    }
}
