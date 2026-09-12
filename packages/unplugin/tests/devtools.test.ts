import { describe, it, expect, vi } from 'vitest';
import { createDevtoolsMiddleware } from '../src/devtools';
import type { SerializableGraph } from '@djodjonx/neosyringe-ui';

const stubGraph: SerializableGraph = {
  containerId: 'App',
  containerName: 'AppContainer',
  nodes: [],
  roots: [],
};

function makeReq(url: string) {
  return { url } as { url: string };
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(k: string, v: string) { this.headers[k] = v; },
    end(b: string) { this.body = b; },
  };
  return res;
}

describe('createDevtoolsMiddleware', () => {
  it('serves HTML at /__neosyringe/', () => {
    const middleware = createDevtoolsMiddleware(() => [stubGraph]);
    const req = makeReq('/__neosyringe/');
    const res = makeRes();
    const next = vi.fn();
    middleware(req as never, res as never, next);
    expect(res.headers['Content-Type']).toContain('text/html');
    expect(res.body).toMatch(/<!DOCTYPE html>/);
    expect(next).not.toHaveBeenCalled();
  });

  it('serves JSON at /__neosyringe/data.json', () => {
    const middleware = createDevtoolsMiddleware(() => [stubGraph]);
    const req = makeReq('/__neosyringe/data.json');
    const res = makeRes();
    const next = vi.fn();
    middleware(req as never, res as never, next);
    expect(res.headers['Content-Type']).toContain('application/json');
    const data = JSON.parse(res.body);
    expect(Array.isArray(data)).toBe(true);
    expect(data[0].containerId).toBe('App');
  });

  it('calls next() for unrelated paths', () => {
    const middleware = createDevtoolsMiddleware(() => []);
    const req = makeReq('/src/main.ts');
    const res = makeRes();
    const next = vi.fn();
    middleware(req as never, res as never, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
