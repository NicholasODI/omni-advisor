/** Read provider SSE without retaining or exposing reasoning content. */
export type AdvisorPhase = 'thinking' | 'answering';
export async function readAdvisorStream(res: Response, api: 'openai' | 'anthropic', phase?: (value: AdvisorPhase) => void) {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('Empty provider response.');
  let buffer = '', text = '', bytes = 0, finished = false, stopped = false;
  let input: number | undefined, output: number | undefined;
  const decoder = new TextDecoder();
  const event = (frame: string) => {
    const raw = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!raw) return;
    if (raw === '[DONE]') { finished = true; return; }
    const data = JSON.parse(raw);
    if (data.error || data.type === 'error') throw new Error('Provider stream failed.');
    if (api === 'anthropic') {
      if (data.type === 'message_start') input = data.message?.usage?.input_tokens;
      if (data.type === 'content_block_start') {
        if (data.content_block?.type === 'thinking') phase?.('thinking');
        if (data.content_block?.type === 'text' && data.content_block.text) { phase?.('answering'); text += data.content_block.text; }
      }
      if (data.type === 'content_block_delta') {
        if (data.delta?.type === 'thinking_delta') phase?.('thinking');
        if (data.delta?.type === 'text_delta' && typeof data.delta.text === 'string') { phase?.('answering'); text += data.delta.text; }
      }
      if (data.type === 'message_delta') {
        output = data.usage?.output_tokens ?? output;
        if (data.delta?.stop_reason === 'max_tokens') throw new Error('Plan truncated.');
        stopped = !!data.delta?.stop_reason;
      }
      if (data.type === 'message_stop') finished = true;
    } else {
      const choice = data.choices?.[0], delta = choice?.delta;
      if (delta?.reasoning || delta?.reasoning_content || delta?.reasoning_details?.length) phase?.('thinking');
      if (typeof delta?.content === 'string' && delta.content) { phase?.('answering'); text += delta.content; }
      if (choice?.finish_reason === 'length') throw new Error('Plan truncated.');
      if (choice?.finish_reason) stopped = true;
      input = data.usage?.prompt_tokens ?? input; output = data.usage?.completion_tokens ?? output;
    }
    if (text.length > 256000) throw new Error('Provider response too large.');
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length; if (bytes > 2000000) throw new Error('Provider stream too large.');
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) { event(buffer.slice(0,boundary)); buffer = buffer.slice(boundary+2); }
    }
    buffer += decoder.decode(); if (buffer.trim()) event(buffer);
  } finally { await reader.cancel(); }
  if (!finished || !stopped || !text.trim()) throw new Error('Provider stream incomplete.');
  return { ok: true, text, ...(Number.isFinite(input) && input! >= 0 && Number.isFinite(output) && output! >= 0 ? { usage: { input: input!, output: output! } } : {}) };
}
