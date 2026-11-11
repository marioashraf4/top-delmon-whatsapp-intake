'use strict';

/**
 * WhatsApp Cloud API client.
 * sendText() -> {ok:true} | {ok:false, kind:'retryable'|'permanent', code}
 * Never throws and never returns/logs the response body (it can contain personal data).
 */
function createWhatsAppClient({ token, phoneNumberId, graphVersion = 'v23.0', timeoutMs = 7000, fetchImpl = fetch }) {
  const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`;
  return {
    async sendText(to, body) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        return { ok: false, kind: 'retryable', code: err && err.name === 'TimeoutError' ? 'timeout' : 'network' };
      }
      if (res.ok) return { ok: true };
      let graphCode;
      try { graphCode = (await res.json())?.error?.code; } catch { /* ignore */ }
      const s = res.status;
      // 429 / 5xx / 401 / 403 (bad or expired token = operator problem) are retryable; other 4xx are not.
      const retryable = s === 429 || s >= 500 || s === 401 || s === 403;
      return { ok: false, kind: retryable ? 'retryable' : 'permanent', code: `http_${s}${graphCode ? `_${graphCode}` : ''}` };
    },
  };
}

module.exports = { createWhatsAppClient };
