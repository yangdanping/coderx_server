import { readFileSync } from 'node:fs';

interface RouteContract {
  methods: string[];
  path: string;
  chain: string[];
}

const fixture = new URL('../fixtures/http-contracts.json', import.meta.url);
export const { routers } = JSON.parse(readFileSync(fixture, 'utf8')) as {
  routers: Record<string, RouteContract[]>;
};
