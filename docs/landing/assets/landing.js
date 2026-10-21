// The landing: a live name check against this origin's seller node, drawn into the 3D scene, the raw
// answer an agent gets, and the node's own /healthz. English lives in index.html; the other four
// languages and the script-built strings in i18n/landing.js.
import { listing, health, checkAll, parseName, resultRow, languages, el, usd, shortKey, post, quote, tldsOf, nodeOrigin } from "./kit.js";
import L10N, { JS_EN } from "./i18n/landing.js";

const T = { en: { ...JS_EN }, ...L10N };
const $ = (id) => document.getElementById(id);
let t = (k) => k;
let ready = false;
let lastResults = [];
let tryDomain = "my-first-agent-app.com";
let node = null;
let seller = null;
let lastTry = null;
let scene = null;

const stateOf = (r) => (!r.ok ? "unknown" : r.available ? "free" : "taken");

function renderResults() {
  $("hero-results").replaceChildren(...lastResults.map((r) => resultRow(r, t, (x) =>
    el("a", { href: `desk/?q=${encodeURIComponent(x.domain)}`, style: "font-size:13px", text: t("in_desk") }))));
}

function renderCurl() {
  $("try-curl").innerHTML = `<span class="p">curl</span> -s ${esc(nodeOrigin())}/quote \\\n  -H <span class="s">'content-type: application/json'</span> \\\n  -d <span class="s">'{"domain":"${esc(tryDomain)}"}'</span>`;
  $("try-quote").textContent = t("try_quote", { domain: tryDomain });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** Pretty JSON with keys, strings and literals coloured. Escaped first: nothing from the node is markup. */
const highlight = (value) => esc(JSON.stringify(value, null, 2))
  .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?/g, (_, str, colon) => colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`)
  .replace(/\b(true|false|null|-?\d+(?:\.\d+)?)\b(?![^<]*<\/span>)/g, '<span class="n">$1</span>');

function showAnswer(status, body, note = "") {
  $("try-out").innerHTML = `${note ? `<span class="c">${esc(note)}</span>\n` : ""}<span class="c">// HTTP ${status}</span>\n${highlight(body)}`;
}

function showSignature(r) {
  const line = $("try-sig");
  if (!r?.ok || !r.available) { line.hidden = true; return; }
  line.hidden = false;
  line.className = `sig ${r.verified === true ? "" : r.verified === false ? "no" : "na"}`;
  line.textContent = t(r.verified === true ? "sig_line_ok" : r.verified === false ? "sig_line_bad" : "sig_line_na", { key: shortKey(r.seller?.provider_pubkey) });
}

function useForTry(r) {
  lastTry = r;
  tryDomain = r.domain;
  renderCurl();
  if (r.raw) showAnswer(r.status || 200, r.raw);
  showSignature(r);
}

async function search(ev) {
  ev.preventDefault();
  const err = $("hero-err");
  err.hidden = true;
  const tlds = tldsOf(await listing());
  const parsed = parseName($("hero-name").value, tlds);
  if (parsed.problem) { err.textContent = t(`p_${parsed.problem}`); err.hidden = false; return; }
  if (parsed.otherTld) { err.textContent = t("other_tld", { tlds: tlds.map((x) => `.${x}`).join(" "), tld: parsed.otherTld }); err.hidden = false; }
  const order = parsed.tld ? [parsed.tld, ...tlds.filter((x) => x !== parsed.tld)] : tlds;
  const button = ev.submitter || $("hero-q").querySelector("button");
  button.disabled = true;
  const names = order.map((x) => `${parsed.name}.${x}`);
  scene?.check(names);
  const told = new Set();
  const results = await checkAll(names, (rs) => {
    lastResults = rs;
    renderResults();
    for (const r of rs) if (!r.pending && !told.has(r.domain)) { told.add(r.domain); scene?.result(r.domain, stateOf(r)); }
  });
  button.disabled = false;
  useForTry(results.find((r) => r.ok && r.available) || results[0]);
}

function renderStatus() {
  const kv = $("st-kv"), missing = $("st-missing");
  if (!node) { kv.replaceChildren(el("dt", { text: t("st_mode") }), el("dd", { text: t("st_unreachable") })); missing.replaceChildren(); return; }
  const row = (k, v) => [el("dt", { text: k }), el("dd", { text: v })];
  kv.replaceChildren(
    ...row(t("st_mode"), t(`m_${node.mode}`)),
    ...row(t("st_orders"), t(`o_${node.orders}`)),
    ...row(t("st_supplier"), node.supplier === "demo" ? t("sup_rdap") : node.supplier),
    ...row(t("st_payments"), node.real_payments ? t("pay_on") : t("pay_off")),
    ...row(t("st_key"), shortKey(node.provider_pubkey)));
  const names = node.live_missing || [];
  const miss = T[document.documentElement.lang]?.miss || T.en.miss;
  missing.replaceChildren(...(names.length ? names.map((n) => el("li", {}, el("code", { text: n }), ` — ${miss[n] || T.en.miss[n] || ""}`))
    : [el("li", { text: t("st_none") })]));
}

function renderStats() {
  if (node) $("s-mode").textContent = node.mode;
  if (seller) {
    $("s-tlds").textContent = tldsOf(seller).map((x) => `.${x}`).join(" ");
    if (seller.pricing?.fixed_markup_usd) $("s-markup").textContent = `$${usd(seller.pricing.fixed_markup_usd)}`;
  }
}

// A spotlight that follows the pointer across the cards.
document.addEventListener("pointermove", (e) => {
  const card = e.target.closest?.(".card");
  if (!card) return;
  const b = card.getBoundingClientRect();
  card.style.setProperty("--mx", `${e.clientX - b.left}px`);
  card.style.setProperty("--my", `${e.clientY - b.top}px`);
}, { passive: true });

// The hero input types example names while nobody is typing in it.
function typePlaceholder() {
  const input = $("hero-name");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return;
  const names = ["agent-built-app", "shipfast", "acme-labs", "tiny-saas", "launch-day"];
  let i = 0, pos = 0, back = false, pause = 0;
  setInterval(() => {
    if (document.activeElement === input || input.value) return;
    if (pause > 0) { pause--; return; }
    const word = names[i % names.length];
    pos += back ? -1 : 1;
    if (pos > word.length) { back = true; pause = 18; pos = word.length; }
    if (pos < 0) { back = false; pos = 0; i++; input.placeholder = t("check_ph"); pause = 10; return; }
    input.placeholder = word.slice(0, pos) + "▍";
  }, 90);
  input.addEventListener("focus", () => { input.placeholder = t("check_ph"); });
}

const i18n = languages(T, (_lang, translate) => {
  t = translate;
  if (!ready) return;
  renderResults(); renderCurl(); renderStatus(); showSignature(lastTry);
});
t = i18n.t;
ready = true;
window.__i18n = i18n;
renderCurl();
typePlaceholder();

$("hero-q").addEventListener("submit", search);
$("try-quote").addEventListener("click", async () => {
  const r = await quote(tryDomain);
  lastTry = r;
  showAnswer(r.status || 200, r.raw ?? { success: false, error: r.error });
  showSignature(r);
  scene?.check([r.domain]);
  scene?.result(r.domain, stateOf(r));
});
$("try-buy").addEventListener("click", async () => {
  try {
    const { status, data } = await post("/register", {});
    showAnswer(status, data, data?.error === "demo_mode" ? t("buy_demo") : data?.error === "owner_auth_required" ? t("buy_auth") : "");
  } catch { showAnswer(0, { success: false, error: "network" }); }
  $("try-sig").hidden = true;
});

[node, seller] = await Promise.all([health(), listing()]);
renderStats();
renderStatus();

// The nav goes dark while it floats over the hero's dark stage.
const heroEl = document.querySelector(".hero");
new IntersectionObserver(([e]) => document.body.classList.toggle("over-hero", e.isIntersecting), { rootMargin: "-64px 0px -88% 0px" }).observe(heroEl);

// The 3D scene loads on its own: without WebGL (or if three.js fails) the hero keeps a still glow.
const hero = document.querySelector(".hero");
try {
  const { startScene } = await import("./scene.js");
  scene = startScene($("scene"), { tlds: tldsOf(seller) });
} catch (error) {
  console.warn("3D scene unavailable:", error?.message || error);
  hero.classList.add("no3d");
  $("scene").hidden = true;
}
