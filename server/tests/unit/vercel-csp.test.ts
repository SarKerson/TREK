import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('keeps the static document CSP aligned with the default Helmet directives', () => {
  const root = resolve(__dirname, '../../..');
  const config = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
  const headers = config.headers.find((entry: { source: string }) => entry.source === '/:path*').headers;
  const csp = headers.find((header: { key: string }) => header.key === 'Content-Security-Policy').value as string;
  const directives = new Map(csp.split(';').map(part => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name, values];
  }));
  const source = ts.createSourceFile('globalMiddleware.ts', readFileSync(resolve(root, 'server/src/middleware/globalMiddleware.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  let checked = 0;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'directives' && ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isArrayLiteralExpression(property.initializer)) continue;
        const name = property.name.getText(source).replace(/[A-Z]/g, char => `-${char.toLowerCase()}`);
        const values: string[] = [];
        for (const element of property.initializer.elements) {
          if (ts.isStringLiteral(element)) values.push(element.text);
          else {
            // Custom routing origins are runtime configuration, documented separately.
            expect(element.getText(source)).toBe('...extraConnectSrc');
          }
        }
        expect(directives.get(name), name).toEqual(values);
        checked++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(checked).toBe(13);
  expect(directives.get('base-uri')).toEqual(["'self'"]);
  expect(directives.get('script-src-attr')).toEqual(["'none'"]);
  expect(directives.has('upgrade-insecure-requests')).toBe(true);
  expect(headers).toContainEqual({ key: 'X-Content-Type-Options', value: 'nosniff' });
});
