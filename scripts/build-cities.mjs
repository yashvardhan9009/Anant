import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
// Source: https://download.geonames.org/export/dump/cities15000.zip (CC BY 4.0).
// Extract cities15000.txt to .asset-cache/earth before running this optional rebuild.
const rows = readFileSync('.asset-cache/earth/cities15000.txt', 'utf8').trim().split('\n').map(s => s.split('\t'));
rows.sort((a, b) => Number(b[14]) - Number(a[14]));
const cities = rows.map(r => [r[1], r[8], Number(r[4]), Number(r[5])]);
mkdirSync('public/assets/earth', { recursive: true });
writeFileSync('public/assets/earth/cities.json', JSON.stringify(cities));
console.log(`${cities.length} city locations. Attribution: GeoNames, CC BY 4.0.`);
