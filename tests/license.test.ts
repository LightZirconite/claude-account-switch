import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('AGPL package metadata, license, attribution and commercial notice stay consistent', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as { license?: string };
  const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8')) as {
    packages?: Record<string, { license?: string }>;
  };
  const license = fs.readFileSync(path.join(projectRoot, 'LICENSE'), 'utf8');
  const notice = fs.readFileSync(path.join(projectRoot, 'NOTICE'), 'utf8');
  const commercial = fs.readFileSync(path.join(projectRoot, 'COMMERCIAL-LICENSE.md'), 'utf8');

  assert.equal(pkg.license, 'AGPL-3.0-or-later');
  assert.equal(lock.packages?.['']?.license, pkg.license);
  assert.match(license, /^GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3, 19 November 2007/);
  assert.match(license, /13\. Remote Network Interaction/);
  assert.doesNotMatch(license, /PolyForm Noncommercial/);
  assert.match(notice, /Copyright \(C\) 2026 LightZirconite/);
  assert.match(notice, /git\.justw\.tf\/LightZirconite\/claude-account-switch/);
  assert.match(commercial, /does not itself\s+grant proprietary rights/);
});
