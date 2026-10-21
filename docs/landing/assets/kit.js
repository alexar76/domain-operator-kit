// Shared by the landing (/) and the example desk (/desk/): the seller node's public routes, the quote
// signature check, name parsing and the language switch. No key, cookie or personal data is held here.
// The node is the page's own origin unless <meta name="domain-node" content="https://..."> says otherwise.
const meta = document.querySelector('meta[name="domain-node"]');
export const NODE = (meta?.content || "").replace(/\/+$/, "");
export const nodeOrigin = () => NODE || location.origin;

export async function getJSON(path) {
  const response = await fetch(NODE + path, { headers: { accept: "application/json" } });
  if (!response.ok) throw Object.assign(new Error(`http_${response.status}`), { status: response.status });
  return response.json();
}

export async function post(path, body) {
  const response = await fetch(NODE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let data = null;
  try { data = await response.json(); } catch { /* An empty or non-JSON error body. */ }
  return { status: response.status, data };
}

let listingRead;
/** The seller's public listing (name, key, TLDs, markup, capabilities), or null when unreachable. */
export const listing = () => (listingRead ??= getJSON("/listing.json").catch(() => null));
export const health = () => getJSON("/healthz").catch(() => null);
export const tldsOf = (l) => (Array.isArray(l?.provider?.tlds) && l.provider.tlds.length ? l.provider.tlds : ["com", "net", "org"]);

// The node signs canonical JSON (keys sorted) of the public quote: the result without `available`
// and without the signature itself (src/service.js quote()).
export const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
  : JSON.stringify(v ?? null);
const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const keys = new Map();
/** true or false, or null where this browser has no Ed25519 in WebCrypto. */
export async function verifyQuote(q) {
  const { available: _a, quote_signature: signature, ...signed } = q;
  const pub = q.seller?.provider_pubkey;
  if (!pub || !signature) return false;
  let key;
  try {
    key = keys.get(pub) || await crypto.subtle.importKey("raw", bytes(pub), { name: "Ed25519" }, false, ["verify"]);
    keys.set(pub, key);
  } catch { return null; }
  try { return await crypto.subtle.verify({ name: "Ed25519" }, key, bytes(signature), new TextEncoder().encode(canonical(signed))); }
  catch { return false; }
}

/** domains.quote@v1 straight at the node: { ok, available, ...quote, verified } or { ok:false, error }. */
export async function quote(domain) {
  try {
    const { status, data } = await post("/quote", { domain });
    if (status === 200 && data?.success && data.result) {
      const q = data.result;
      return { ...q, ok: true, raw: data, verified: q.available ? await verifyQuote(q) : null };
    }
    return { ok: false, domain, status, raw: data, error: data?.error || (status === 429 ? "rate_limited" : `http_${status}`) };
  } catch { return { ok: false, domain, status: 0, error: "network" }; }
}

/** Quotes every name at once and reports each answer as it lands. */
export async function checkAll(domains, onUpdate) {
  const results = domains.map((domain) => ({ domain, pending: true }));
  onUpdate(results);
  await Promise.all(domains.map(async (domain, i) => { results[i] = await quote(domain); onUpdate(results); }));
  return results;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** What a person types → one registrable label. "My Project", "https://www.my-project.org/x" → my-project (+ org). */
export function parseName(raw, tlds) {
  const s = String(raw || "").trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#:@]/)[0];
  if (/[^\x00-\x7f]/.test(s)) return { problem: "idn" };
  const labels = s.split(".").map((l) => l.trim()).filter(Boolean);
  const tld = labels.length > 1 ? labels.pop() : null;
  const name = (labels[labels.length - 1] || "").replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");
  if (!name) return { problem: "empty" };
  if (name.length > 63 || !LABEL.test(name)) return { problem: "invalid" };
  if (name.startsWith("xn--")) return { problem: "idn" };
  return { name, tld: tld && tlds.includes(tld) ? tld : null, otherTld: tld && !tlds.includes(tld) ? tld : null };
}

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid instanceof Node ? kid : String(kid));
  return e;
}
export const usd = (s) => { const n = Number(s); return Number.isFinite(n) ? n.toFixed(2) : String(s ?? ""); };
export const shortKey = (k) => (k ? `${k.slice(0, 8)}…${k.slice(-4)}` : "");

export const sigLabel = (r, t) => el("span", { class: `sig ${r.verified === true ? "" : r.verified === false ? "no" : "na"}`,
  text: t(r.verified === true ? "sig_ok" : r.verified === false ? "sig_bad" : "sig_na") });

/** One answer as a row; `action(result)` supplies what sits under the price of an available name. */
export function resultRow(r, t, action) {
  const head = (pill, ...meta) => el("div", {}, el("div", { class: "name", text: r.domain }), el("div", { class: "meta" }, pill, ...meta));
  if (r.pending) return el("div", { class: "row wait" }, head(el("span", { class: "pill wait", text: t("checking") })));
  if (!r.ok) return el("div", { class: "row" }, head(el("span", { class: "pill unknown", text: t(r.error === "rate_limited" ? "busy" : "unknown") })));
  if (!r.available) return el("div", { class: "row taken" }, head(el("span", { class: "pill taken", text: t("taken") })));
  return el("div", { class: "row" },
    head(el("span", { class: "pill free", text: t("free") }), sigLabel(r, t),
      el("span", { text: t("breakdown", { cost: usd(r.cost_usd), markup: usd(r.markup_usd) }) })),
    el("div", { class: "act" }, el("div", { class: "price" }, usd(r.price_usd), el("small", { text: r.currency })), action?.(r)));
}

/**
 * Two languages. English is written once, in the HTML: its data-i18n texts become T.en before the
 * first switch, so the dictionaries only carry Russian and the strings the scripts build.
 */
export function languages(T, onChange) {
  const langs = Object.keys(T);
  let lang = "en";
  for (const e of document.querySelectorAll("[data-i18n]")) T.en[e.dataset.i18n] ??= e.textContent.trim();
  for (const e of document.querySelectorAll("[data-i18n-html]")) T.en[e.dataset.i18nHtml] ??= e.innerHTML.trim();
  for (const e of document.querySelectorAll("[data-i18n-ph]")) T.en[e.dataset.i18nPh] ??= e.placeholder;
  T.en.title ??= document.title;
  T.en.description ??= document.querySelector('meta[name="description"]')?.content;
  const t = (key, vars = {}) => String(T[lang][key] ?? T.en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
  const pick = () => {
    const asked = new URLSearchParams(location.search).get("lang");
    if (langs.includes(asked)) return asked;
    try { const saved = localStorage.getItem("domains-lang"); if (langs.includes(saved)) return saved; } catch { /* no storage */ }
    return (navigator.languages || [navigator.language]).map((l) => String(l).slice(0, 2)).find((l) => langs.includes(l)) || "en";
  };
  const apply = (l) => {
    lang = l;
    document.documentElement.lang = l;
    for (const e of document.querySelectorAll("[data-i18n]")) e.textContent = t(e.dataset.i18n);
    for (const e of document.querySelectorAll("[data-i18n-html]")) e.innerHTML = t(e.dataset.i18nHtml);
    for (const e of document.querySelectorAll("[data-i18n-ph]")) e.placeholder = t(e.dataset.i18nPh);
    for (const b of document.querySelectorAll("[data-lang]")) b.setAttribute("aria-pressed", String(b.dataset.lang === l));
    document.title = t("title");
    const description = document.querySelector('meta[name="description"]');
    if (description) description.content = t("description");
    onChange?.(l, t);
  };
  for (const b of document.querySelectorAll("[data-lang]")) b.addEventListener("click", () => {
    try { localStorage.setItem("domains-lang", b.dataset.lang); } catch { /* no storage */ }
    apply(b.dataset.lang);
  });
  apply(pick());
  return { t, apply, get lang() { return lang; } };
}
