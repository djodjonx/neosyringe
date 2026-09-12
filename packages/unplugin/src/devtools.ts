import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildStandaloneHtml } from '@djodjonx/neosyringe-ui';
import type { SerializableGraph } from '@djodjonx/neosyringe-ui';

type Next = () => void;
type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

/**
 * Creates an HTTP middleware that serves NeoSyringe devtools at /__neosyringe/.
 *
 * Routes:
 *   GET /__neosyringe/          → HTML visualization page
 *   GET /__neosyringe/data.json → raw SerializableGraph[] JSON
 */
export function createDevtoolsMiddleware(getGraphs: () => SerializableGraph[]): Middleware {
  return (req, res, next) => {
    const url = req.url ?? '';

    if (url === '/__neosyringe/' || url === '/__neosyringe') {
      const html = buildStandaloneHtml(getGraphs());
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
      return;
    }

    if (url === '/__neosyringe/data.json') {
      const json = JSON.stringify(getGraphs(), null, 2);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(json);
      return;
    }

    next();
  };
}
