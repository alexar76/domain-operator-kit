// Post-purchase readiness only. No registrar purchase or DNS-write capability
// is accepted here, so propagation retries cannot purchase the domain again.
export async function waitForSetup({
  getDomain, verifyDomain, getConfig, ensureCertificate, checkHttps,
  onProgress = () => {}, timeoutMs = 600_000, intervalMs = 20_000,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 ||
      !Number.isFinite(intervalMs) || intervalMs <= 0) throw Error('invalid_setup_wait_budget');
  const started = now(), deadline = started + timeoutMs;
  let attempt = 0;
  for (;;) {
    let result;
    try {
      let domain = await getDomain();
      if (!domain.verified) {
        try { domain = await verifyDomain(); }
        catch (error) { if (error.status !== 400) throw error; }
      }
      const config = await getConfig();
      result = { verified: domain.verified === true, dnsConfigured: config.misconfigured === false,
        certificate: { pending: true }, https: { pending: true } };
      if (!result.verified || !result.dnsConfigured) {
        result.status = 'waiting_for_dns';
      } else {
        result.certificate = await ensureCertificate();
        if (result.certificate.pending) {
          result.status = 'waiting_for_certificate';
        } else {
          try {
            result.https = await checkHttps();
            result.status = 'ready';
          } catch (error) {
            result.status = error.message?.startsWith('sentinel_') ? 'waiting_for_application' : 'waiting_for_https';
          }
        }
      }
    } catch (error) {
      if (error.status === 429 || error.status >= 500 || error.message === 'vercel_ssh_request_failed') {
        result = { status: 'waiting_for_provider', https: { pending: true } };
      } else {
        await onProgress({ status: 'needs_attention', reason: error.message, attempt: ++attempt, elapsedMs: now() - started });
        throw error;
      }
    }
    result = { ...result, attempt: ++attempt, elapsedMs: now() - started };
    if (result.status === 'ready') {
      await onProgress(result);
      return result;
    }
    if (now() >= deadline) {
      result.timedOut = true;
      result.resumable = true;
      await onProgress(result);
      return result;
    }
    await onProgress(result);
    await sleep(Math.max(0, Math.min(intervalMs, deadline - now())));
  }
}
