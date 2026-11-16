/**
 * Simplifies technical, JSON-serialized, or network error messages into
 * clear, friendly human language for the user.
 */
export function simplifyErrorMessage(raw: unknown): string {
  if (!raw) return 'An unexpected error occurred. Please try again.';

  let msg = typeof raw === 'string' ? raw : (raw as any)?.message || String(raw);

  // Strip common technical error prefixes
  let cleaned = msg.trim();
  const prefixMatch = cleaned.match(/^(?:Error:\s*|\*\*Error:\*\*\s*|\[Agent Error:\s*|Agent Error:\s*|\*\*Execution Error:\*\*\s*)+/i);
  if (prefixMatch) {
    cleaned = cleaned.slice(prefixMatch[0].length).trim();
  }

  // If the error string contains or is JSON, attempt to unpack inner messages
  let parsedObj: any = null;
  let current: any = cleaned;
  for (let i = 0; i < 3; i++) {
    if (typeof current === 'string' && (current.startsWith('{') || current.startsWith('['))) {
      try {
        current = JSON.parse(current);
        parsedObj = current;
      } catch {
        break;
      }
    } else if (current && typeof current === 'object') {
      parsedObj = current;
      if (typeof current.error === 'string') {
        current = current.error;
      } else if (typeof current.error?.message === 'string') {
        current = current.error.message;
      } else if (typeof current.message === 'string') {
        current = current.message;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  const code =
    parsedObj?.code ||
    parsedObj?.error?.code ||
    (raw as any)?.code ||
    (raw as any)?.status;

  const rawText =
    (typeof current === 'string' ? current : null) ||
    parsedObj?.error?.message ||
    parsedObj?.message ||
    cleaned;

  const lower = (String(rawText) + ' ' + String(cleaned)).toLowerCase();

  // 1. High demand / 503 / Service Unavailable
  if (
    code === 503 ||
    code === '503' ||
    lower.includes('503') ||
    lower.includes('high demand') ||
    lower.includes('spikes in demand') ||
    lower.includes('unavailable') ||
    lower.includes('service unavailable') ||
    lower.includes('overloaded')
  ) {
    return 'The model is currently experiencing high demand. Please try again in a few moments.';
  }

  // 2. Rate limit / 429 / Quota
  if (
    code === 429 ||
    code === '429' ||
    lower.includes('429') ||
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('resource_exhausted') ||
    lower.includes('too many requests')
  ) {
    return 'Usage limit reached. Please wait a moment before sending another message.';
  }

  // 3. API Key / 401 / 403 / Permission denied
  if (
    code === 401 ||
    code === 403 ||
    lower.includes('api key') ||
    lower.includes('permission_denied') ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden')
  ) {
    return 'Invalid or missing API key. Please check your GEMINI_API_KEY setting.';
  }

  // 4. DNS / Network offline / Fetch failed
  if (
    lower.includes('enotfound') ||
    lower.includes('fetch failed') ||
    lower.includes('dns lookup failed') ||
    lower.includes('network request failed')
  ) {
    return 'Unable to reach the AI service. Please check your internet connection.';
  }

  // 5. Connection refused / timeout
  if (lower.includes('econnrefused') || lower.includes('connection refused')) {
    return 'Connection refused by the AI service. Please check your firewall or proxy.';
  }
  if (lower.includes('etimedout') || lower.includes('timed out') || lower.includes('timeout')) {
    return 'Connection to the AI service timed out. Please try again in a moment.';
  }

  // 6. Safety block / Content policy
  if (lower.includes('safety') || lower.includes('blocked') || lower.includes('harmful')) {
    return 'This request was blocked by content safety filters. Please try rephrasing your message.';
  }

  // 7. Invalid argument / 400
  if (code === 400 || lower.includes('invalid_argument')) {
    return 'The request could not be processed. Please try rephrasing your message.';
  }

  // 8. Server error / 500 / 502 / 504
  if (code === 500 || code === 502 || code === 504 || lower.includes('internal error')) {
    return 'The AI service encountered a temporary error. Please try again shortly.';
  }

  // If rawText is already clean human text without curly braces or JSON artifacts, return it
  if (typeof rawText === 'string' && !rawText.includes('{') && !rawText.includes('}') && rawText.length < 200) {
    return rawText.trim();
  }

  return 'The AI service is temporarily unavailable. Please try again in a moment.';
}

/**
 * Checks if content is an unformatted error string (like raw JSON) and simplifies it for display.
 */
export function formatMessageForDisplay(content: string): string {
  if (!content) return '';
  const trimmed = content.trim();
  if (
    trimmed.startsWith('{"error"') ||
    trimmed.startsWith('Error: {"error"') ||
    trimmed.startsWith('**Error:** {"error"') ||
    trimmed.startsWith('**Execution Error:**') ||
    trimmed.startsWith('[Agent Error:') ||
    (trimmed.includes('"code": 503') && trimmed.includes('"error"')) ||
    (trimmed.includes('"code":503') && trimmed.includes('"error"'))
  ) {
    return simplifyErrorMessage(trimmed);
  }
  return content;
}
