import { isIP } from 'node:net';
import { only, fail, domainName } from './core.js';

export function validateRecords(domain, records) {
  if (!Array.isArray(records) || records.length < 1 || records.length > 50) fail('invalid_dns_records');
  const seen = new Set();
  for (const r of records) {
    only(r, ['name', 'type', 'value', 'ttl', 'prio']);
    const name = r.name === '@' ? domain : r.name;
    if (typeof name !== 'string' || name.length > 253 || !/^[a-z0-9_.*-]+$/.test(name)
      || !(name === domain || name.endsWith(`.${domain}`)) || name.split('.').some((x, i) => !x || x.length > 63 || (x.includes('*') && !(i === 0 && x === '*')))) fail('dns_name_outside_domain');
    if (!['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA'].includes(r.type) || typeof r.value !== 'string' || r.value.length > 2048
      || /[\x00-\x1f\x7f]/.test(r.value) || !Number.isInteger(r.ttl) || r.ttl < 60 || r.ttl > 86400) fail('invalid_dns_record');
    if (r.type === 'A' && isIP(r.value) !== 4 || r.type === 'AAAA' && isIP(r.value) !== 6) fail('invalid_dns_ip');
    if (['CNAME', 'MX'].includes(r.type)) domainName(r.value.replace(/\.$/, ''));
    if (r.type === 'CNAME' && name === domain) fail('apex_cname_not_supported');
    if (r.type === 'MX' && (!Number.isInteger(r.prio) || r.prio < 0 || r.prio > 65535)) fail('invalid_mx_priority');
    if (r.type === 'CAA' && !/^\d{1,3} (issue|issuewild|iodef) "[^"\r\n]+"$/.test(r.value)) fail('invalid_caa');
    const key = `${name}:${r.type}:${r.value}`; if (seen.has(key)) fail('duplicate_dns_record'); seen.add(key);
    r.name = name; r.prio ??= 0;
  }
  for (const r of records) if (r.type === 'CNAME' && records.some(x => x !== r && x.name === r.name)) fail('cname_conflict');
  return records;
}
