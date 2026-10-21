import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import LANDING, { JS_EN as LANDING_JS } from '../docs/landing/assets/i18n/landing.js';
import DESK, { JS_EN as DESK_JS } from '../docs/landing/assets/i18n/desk.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'docs/landing');
const read = path => readFileSync(join(site, path), 'utf8');
const LANGS = ['ru', 'es', 'fr', 'zh'];
const PAGES = [
  { name: 'landing', html: read('index.html'), dict: LANDING, js: LANDING_JS },
  { name: 'desk', html: read('desk/index.html'), dict: DESK, js: DESK_JS },
];
const keysOf = html => [...html.matchAll(/data-i18n(?:-html|-ph)?="([\w.-]+)"/g)].map(m => m[1]);
const vars = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
const allText = dict => JSON.stringify(dict).toLowerCase();

test('every page key and every script string exists in all five languages', () => {
  for (const { name, html, dict, js } of PAGES) {
    assert.deepEqual(Object.keys(dict).sort(), [...LANGS].sort(), name);
    const keys = new Set([...keysOf(html), 'title', 'description', ...Object.keys(js)]);
    for (const lang of LANGS) {
      for (const key of keys) assert.ok(dict[lang][key] !== undefined, `${name}.${lang} misses ${key}`);
      for (const [key, value] of Object.entries(js)) {
        if (typeof value === 'object') {
          for (const sub of Object.keys(value)) assert.ok(dict[lang][key]?.[sub], `${name}.${lang}.${key} misses ${sub}`);
        } else assert.deepEqual(vars(dict[lang][key]), vars(value), `${name}.${lang}.${key} placeholders`);
      }
    }
  }
});

test('translations use the glossary renderings, not their rejected variants', () => {
  // docs/localization-glossary.md: "Domain Operator Kit" plus the core, seller-direct and eSIM rows.
  const required = {
    ru: ['регистратор', 'регистрант', 'регистратур', 'котировк', 'наценк', 'кошелёк возвратов', 'ключ продавца', 'ключ владельца', 'квитанц', 'федерац', 'рельсы', 'верифиц', 'узел продавца', 'пример деска', 'доменные зоны'],
    es: ['registrador', 'registratario', 'cotizaci', 'margen fijo', 'cartera', 'rails', 'recibo', 'reembols', 'clave del vendedor', 'clave del propietario', 'nodo vendedor', 'tienda de ejemplo', 'federación', 'código abierto'],
    fr: ["bureau d'enregistrement", 'titulaire', 'offre de prix', 'marge fixe', 'portefeuille', 'rails', 'reçu', 'rembours', 'clé du vendeur', 'clé du propriétaire', 'nœud vendeur', "boutique d'exemple", 'fédération', 'open source'],
    zh: ['注册服务机构', '注册人', '注册管理机构', '报价', '固定加价', '钱包', '轨道', '收据', '退款', '卖家密钥', '所有者密钥', '卖家节点', '示例店铺', '智能体', '枢纽', '续费', '域名后缀'],
  };
  const rejected = {
    ru: ['кошелёк для возвратов', 'ключ узла', 'реестр', 'резерв на возвраты'],
    es: ['monedero', 'rieles', 'titular del dominio'],
    fr: ['registraire', 'devis'],
    zh: ['注册商', '代理'],
  };
  for (const lang of LANGS) {
    const text = allText(LANDING[lang]) + allText(DESK[lang]);
    for (const term of required[lang]) assert.ok(text.includes(term.toLowerCase()), `${lang}: glossary term «${term}» missing`);
    for (const term of rejected[lang]) assert.ok(!text.includes(term.toLowerCase()), `${lang}: rejected variant «${term}» used`);
  }
});

test('the glossary carries the Domain Operator Kit rows', { skip: !existsSync(join(root, '../docs/localization-glossary.md')) && 'satellite checkout' }, () => {
  const glossary = readFileSync(join(root, '../docs/localization-glossary.md'), 'utf8');
  const section = glossary.slice(glossary.indexOf('## Domain Operator Kit'));
  for (const term of ['| registrar |', '| registry (of a TLD) |', '| registrant |', '| quote (domain price) |', '| fixed markup |', '| example desk |', 'регистратура', 'registratario', "bureau d'enregistrement", '注册服务机构'])
    assert.ok(section.includes(term), term);
});

test('the import map is allowed by its hash in both CSPs, and every module it loads is on disk', () => {
  const html = read('index.html');
  const map = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1];
  const hash = `'sha256-${createHash('sha256').update(map).digest('base64')}'`;
  assert.ok(read('dev.mjs').includes(hash), 'dev.mjs CSP');
  assert.ok(readFileSync(join(root, 'deploy/nginx/domains.modelmarket.dev.conf'), 'utf8').includes(hash), 'nginx CSP');
  const { imports } = JSON.parse(map);
  assert.ok(existsSync(join(site, imports.three)), imports.three);
  for (const [, spec] of read('assets/scene.js').matchAll(/from "three\/addons\/([^"]+)"/g)) {
    const file = join(site, imports['three/addons/'], spec);
    assert.ok(existsSync(file), spec);
    for (const [, rel] of readFileSync(file, 'utf8').matchAll(/^import[^;]*?from '(\.{1,2}\/[^']+)'/gm)) assert.ok(existsSync(join(dirname(file), rel)), `${spec} → ${rel}`);
  }
  for (const [, rel] of readFileSync(join(site, imports.three), 'utf8').matchAll(/from"(\.\/[^"]+)"/g)) assert.ok(existsSync(join(site, dirname(imports.three), rel)), rel);
});
