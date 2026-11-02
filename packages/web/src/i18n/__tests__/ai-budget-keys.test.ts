import en from '../locales/en.json';
import pl from '../locales/pl.json';
import ru from '../locales/ru.json';

function collectKeys(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return [prefix];
  return Object.entries(obj as Record<string, unknown>)
    .flatMap(([k, v]) => collectKeys(v, prefix ? `${prefix}.${k}` : k))
    .sort();
}

function strings(o: unknown): string[] {
  return typeof o === 'string' ? [o] : Object.values(o as object).flatMap(strings);
}

test.each([['en', en], ['ru', ru]])('%s has every aiBudget key from pl', (_l, t) => {
  expect(collectKeys(t.aiBudget)).toEqual(collectKeys(pl.aiBudget));
});

test.each([['en', en], ['pl', pl], ['ru', ru]])('%s has no empty aiBudget string', (_l, t) => {
  expect(strings(t.aiBudget).filter((s) => s.length === 0)).toEqual([]);
});
