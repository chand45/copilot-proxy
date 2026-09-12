import { ProxyError } from './errors.js';

const MAX_EVENT_CHARS = 64 * 1024 * 1024;
const encoder = new TextEncoder();

// Some Copilot Responses streams re-encode the same opaque ID for every event.
// output_index is stable within a response, so retain the first provider ID for
// each index. Keep provider-issued IDs (rather than synthetic IDs) for replay.
// call_id and encrypted_content are deliberately untouched.
export function stabilizeResponseIds(response) {
  if (!response.ok || !response.body
    || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) return response;

  const itemIds = new Map();
  let responseId;
  let pending = '';

  function canonicalItemId(index, id) {
    if (!Number.isSafeInteger(index) || index < 0 || typeof id !== 'string' || !id) return id;
    if (!itemIds.has(index)) itemIds.set(index, id);
    return itemIds.get(index);
  }

  function frame(text, delimiter, controller) {
    const lines = text.split(/\r\n|\r|\n/);
    const dataLines = lines.flatMap((line, index) => line === 'data' || line.startsWith('data:') ? [index] : []);
    const data = dataLines.map(index => lines[index].slice(5).replace(/^ /, '')).join('\n');
    if (!data.trim() || data.trim() === '[DONE]') {
      controller.enqueue(encoder.encode(text + delimiter));
      return;
    }
    let event;
    try { event = JSON.parse(data); } catch {
      throw new ProxyError(502, 'invalid_responses_stream', 'Copilot returned an invalid Responses SSE event.', 'server_error');
    }
    let changed = false;
    function setId(object, field, id) {
      if (id !== undefined && object[field] !== id) {
        object[field] = id;
        changed = true;
      }
    }
    function setResponseId(object, field) {
      if (typeof object[field] !== 'string' || !object[field]) return;
      responseId ??= object[field];
      setId(object, field, responseId);
    }
    if (typeof event?.type === 'string' && event.type.startsWith('response.')) {
      if (event.item && typeof event.item === 'object') {
        setId(event.item, 'id', canonicalItemId(event.output_index, event.item.id));
      }
      if (typeof event.item_id === 'string') {
        setId(event, 'item_id', canonicalItemId(event.output_index, event.item_id));
      }
      setResponseId(event, 'response_id');
      if (event.response && typeof event.response === 'object') {
        setResponseId(event.response, 'id');
        if (Array.isArray(event.response.output)) {
          event.response.output.forEach((item, index) => {
            if (item && typeof item === 'object') setId(item, 'id', canonicalItemId(index, item.id));
          });
        }
      }
    }
    if (!changed) {
      controller.enqueue(encoder.encode(text + delimiter));
      return;
    }
    // Preserve SSE comments, event type, retry and transport id fields. Replace
    // only the JSON data lines when IDs actually changed; stable frames retain
    // their original bytes, including formatting and line endings.
    const dataIndexes = new Set(dataLines);
    const newline = text.match(/\r\n|\r|\n/)?.[0] ?? '\n';
    const output = lines.flatMap((line, index) => index === dataLines[0]
      ? [`data: ${JSON.stringify(event)}`] : dataIndexes.has(index) ? [] : [line]);
    controller.enqueue(encoder.encode(output.join(newline) + delimiter));
  }

  const stream = new TransformStream({
    transform(chunk, controller) {
      pending += chunk;
      // A CR at a chunk boundary may be the first half of CRLF. Waiting for
      // the next character prevents an extra empty frame or lost separator.
      const complete = pending.endsWith('\r') ? pending.slice(0, -1) : pending;
      const separators = /(?:\r\n|\r(?!\n)|\n){2}/g;
      let match;
      let start = 0;
      while ((match = separators.exec(complete))) {
        if (match.index - start > MAX_EVENT_CHARS) throw oversizedEvent();
        frame(pending.slice(start, match.index), match[0], controller);
        start = match.index + match[0].length;
      }
      pending = pending.slice(start);
      if (pending.length > MAX_EVENT_CHARS) throw oversizedEvent();
    },
    flush(controller) {
      if (pending) frame(pending, '', controller);
    },
  });
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(response.body.pipeThrough(new TextDecoderStream()).pipeThrough(stream), {
    status: response.status, statusText: response.statusText, headers,
  });
}

function oversizedEvent() {
  return new ProxyError(502, 'invalid_responses_stream', 'Copilot returned an oversized Responses SSE event.', 'server_error');
}
