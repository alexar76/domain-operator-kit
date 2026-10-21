// The example desk: a seller's storefront over its own node. Search → signed quotes → the order an
// agent would place. It never sends personal data: the order button posts an empty body, and a demo
// node refuses it with demo_mode before reading anything. English lives in desk/index.html; the other
// four languages and the script-built strings in i18n/desk.js.
import { listing, health, checkAll, parseName, resultRow, languages, el, usd, shortKey, post, quote, tldsOf, NODE, nodeOrigin } from "./kit.js";
import L10N, { JS_EN } from "./i18n/desk.js";

const T = { en: { ...JS_EN }, ...L10N };

const $ = (id) => document.getElementById(id);
let t = (k) => k;
let ready = false;
let seller = null, node = null, tlds = ["com", "net", "org"];
const chosen = new Set(tlds);
let base = "", results = [], ideas = [], current = null, ticker = null;

const register = (r) => el("button", { type: "button", class: "btn primary", style: "margin-top:6px;padding:9px 14px", text: t("register"), onclick: () => openCheckout(r) });

function renderResults() {
  $("results").replaceChildren(...results.map((r) => resultRow(r, t, register)));
  $("ideas").replaceChildren(...ideas.map((r) => resultRow(r, t, register)));
  $("ideas-head").hidden = !results.length;
}

function renderChips() {
  const box = $("tlds");
  box.querySelectorAll(".chip").forEach((c) => c.remove());
  for (const x of tlds) box.append(el("button", { type: "button", class: "chip", "aria-pressed": String(chosen.has(x)), text: `.${x}`,
    onclick: () => { if (chosen.has(x) && chosen.size === 1) return; chosen.has(x) ? chosen.delete(x) : chosen.add(x); renderChips(); } }));
}

function renderSeller() {
  const name = seller?.seller?.name || "Domain desk";
  $("seller-name").textContent = name;
  $("eyebrow").textContent = t("eyebrow", { seller: name });
  const list = tlds.map((x) => `.${x}`);
  $("lead").textContent = t("lead", { tlds: list.length > 1 ? `${list.slice(0, -1).join(t("sep"))} ${t("and")} ${list.at(-1)}` : list[0],
    markup: `$${usd(seller?.pricing?.fixed_markup_usd ?? "2.00")}` });
  $("banner").hidden = !node || node.orders !== "refused_demo";
  $("foot-key").textContent = seller ? t("foot_key", { key: shortKey(seller.seller?.provider_pubkey), mode: seller.mode }) : "";
}

async function search(ev) {
  ev?.preventDefault();
  const err = $("err");
  err.hidden = true;
  const parsed = parseName($("name").value, tlds);
  if (parsed.problem) { err.textContent = t(`p_${parsed.problem}`); err.hidden = false; return; }
  if (parsed.otherTld) { err.textContent = t("other_tld", { tlds: tlds.map((x) => `.${x}`).join(" "), tld: parsed.otherTld }); err.hidden = false; }
  if (parsed.tld) chosen.add(parsed.tld);
  renderChips();
  const order = tlds.filter((x) => chosen.has(x)).sort((a, b) => (a === parsed.tld ? -1 : b === parsed.tld ? 1 : 0));
  base = parsed.name;
  ideas = [];
  const url = new URL(location.href);
  url.searchParams.set("q", parsed.tld ? `${base}.${parsed.tld}` : base);
  history.replaceState(null, "", url);
  await checkAll(order.map((x) => `${base}.${x}`), (rs) => { results = rs; renderResults(); });
}

async function moreIdeas() {
  if (!base) return;
  const tld = tlds.find((x) => chosen.has(x)) || tlds[0];
  const names = [`get${base}`, `${base}app`, `${base}hq`, `try${base}`].filter((n) => n.length <= 63);
  $("more").disabled = true;
  await checkAll(names.map((n) => `${n}.${tld}`), (rs) => { ideas = rs; renderResults(); });
  $("more").disabled = false;
}

function renderCheckout() {
  const r = current;
  if (!r) return;
  $("co-domain").textContent = r.domain;
  const row = (k, v, cls) => [el("dt", { text: k }), el("dd", { class: cls, text: v })];
  $("co-price").replaceChildren(
    ...row(t("k_cost"), `$${usd(r.cost_usd)}`), ...row(t("k_markup"), `$${usd(r.markup_usd)}`),
    ...row(t("k_total"), `${usd(r.price_usd)} ${r.currency}`, "total"), ...row(t("k_renewal"), t("renewal_note", { price: `$${usd(r.renewal_estimate_usd)}` })),
    ...row(t("k_hub"), "$0"));
  $("co-sig").className = `fine sig ${r.verified === true ? "" : r.verified === false ? "no" : "na"}`;
  $("co-sig").textContent = t(r.verified === true ? "sig_line_ok" : r.verified === false ? "sig_line_bad" : "sig_line_na", { key: shortKey(r.seller?.provider_pubkey) });
  $("co-pay").textContent = t("pay", { total: usd(r.price_usd), currency: r.currency });
  // A demo node's placeholder terms live on .invalid, which never resolves: no link to nowhere.
  let real = false;
  try { real = !new URL(r.terms_url).hostname.endsWith(".invalid"); } catch { /* missing or relative */ }
  $("co-terms-text").replaceChildren(t("terms", { version: r.terms_version }), " ",
    real ? el("a", { href: r.terms_url, target: "_blank", rel: "noopener", text: t("terms_read") }) : el("span", { class: "muted", text: t("terms_demo") }));
  $("co-agent").textContent = `${t("agent_note")}\n${JSON.stringify({ method: "tools/call", params: { name: "register", arguments: {
    quote_id: r.quote_id, client_order_id: "<16–80 chars, the same on every retry>", accept_terms: true, terms_version: r.terms_version } } }, null, 2)}`;
  tick();
}

function tick() {
  const r = current;
  if (!r) return;
  const left = Date.parse(r.expires_at) - Date.now();
  const box = $("co-expiry");
  if (left <= 0) {
    clearInterval(ticker);
    $("co-place").disabled = true;
    box.replaceChildren(t("expired"), " ", el("button", { type: "button", class: "btn", style: "padding:6px 12px;margin-left:6px", text: t("requote"),
      onclick: async () => { const q = await quote(r.domain); if (q.ok && q.available) openCheckout(q); } }));
    return;
  }
  const s = Math.ceil(left / 1000);
  box.textContent = t("expires", { time: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` });
  $("co-place").disabled = !$("co-terms").checked;
}

function openCheckout(r) {
  current = r;
  $("co-terms").checked = false;
  $("co-answer").hidden = true;
  $("checkout").hidden = false;
  renderCheckout();
  clearInterval(ticker);
  ticker = setInterval(tick, 1000);
  $("checkout").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function place() {
  $("co-place").disabled = true;
  let status = 0, data = null;
  try { ({ status, data } = await post("/register", {})); } catch { /* shown below */ }
  $("co-answer").hidden = false;
  $("co-out").textContent = status ? `POST ${nodeOrigin()}/register\n// HTTP ${status}\n${JSON.stringify(data, null, 2)}` : "";
  $("co-out").hidden = !status;
  const error = data?.error;
  $("co-explain").textContent = !status ? t("node_down") : error === "demo_mode" ? t("placed_demo") : error === "owner_auth_required" ? t("placed_auth") : t("placed_other", { error: error || status });
  if (error === "owner_auth_required") $("co-agent").closest("details").open = true;
  tick();
}

const i18n = languages(T, (_lang, translate) => {
  t = translate;
  if (!ready) return;
  renderSeller(); renderResults(); renderCheckout();
});
t = i18n.t;
ready = true;
window.__i18n = i18n;

// A spotlight that follows the pointer across the cards.
document.addEventListener("pointermove", (e) => {
  const card = e.target.closest?.(".card");
  if (!card) return;
  const b = card.getBoundingClientRect();
  card.style.setProperty("--mx", `${e.clientX - b.left}px`);
  card.style.setProperty("--my", `${e.clientY - b.top}px`);
}, { passive: true });

$("q").addEventListener("submit", search);
$("more").addEventListener("click", moreIdeas);
$("co-terms").addEventListener("change", tick);
$("co-place").addEventListener("click", place);
$("co-back").addEventListener("click", () => { clearInterval(ticker); current = null; $("checkout").hidden = true; $("results").scrollIntoView({ behavior: "smooth", block: "center" }); });
for (const a of document.querySelectorAll('footer a[href^="../listing"], footer a[href^="../healthz"]')) if (NODE) a.href = NODE + a.getAttribute("href").slice(2);
renderChips();

[seller, node] = await Promise.all([listing(), health()]);
tlds = tldsOf(seller);
chosen.clear();
tlds.forEach((x) => chosen.add(x));
renderChips();
renderSeller();
const asked = new URLSearchParams(location.search).get("q");
if (asked) { $("name").value = asked; search(); }
