import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';

import { runWithVisitorFromRequest } from '../node/visitor-context.js';

/** Fastify plugin that scopes each request visitor ID during the onRequest hook. */
export const visitorPlugin: FastifyPluginAsync = fp(async (fastify) => {
  fastify.addHook('onRequest', (request, _reply, done) => {
    runWithVisitorFromRequest(request, done);
  });
}, { name: 'cekat-visitor' });
