// First occurrence wins: current discovery has priority over configured tags.
export function mergeSources(discovered = [], configured = []) {
  const sources = new Map();
  for (const group of [...discovered, ...configured]) {
    if (!group || !Array.isArray(group.tags)) continue;
    for (const value of group.tags) {
      if (typeof value !== 'string') continue;
      const tag = value.trim().replace(/^#+/, '').trim();
      if (!tag) continue;
      if (excludedSource({ ...group, tag })) continue;
      const key = tag.toLowerCase();
      if (!sources.has(key)) sources.set(key, {
        tag, region: group.region || 'GLOBAL', lang: group.lang || 'en',
      });
    }
  }
  return [...sources.values()];
}
import { excludedSource } from './content-filter.mjs';
