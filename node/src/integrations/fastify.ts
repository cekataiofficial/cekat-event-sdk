import type { FastifyPluginCallback } from 'fastify';

import { runWithVisitorFromRequest } from '../node/visitor-context.js';

const registerVisitorHook: FastifyPluginCallback = (fastify, _options, done) => {
  fastify.addHook('onRequest', (request, _reply, next) => {
    runWithVisitorFromRequest(request, next);
  });
  done();
};

/**
 * Fastify plugin that scopes each request visitor ID during the onRequest hook.
 * It opts out of encapsulation (the `fastify-plugin` convention, applied without
 * that dependency) so the hook covers routes registered beside it.
 */
export const visitorPlugin: FastifyPluginCallback = Object.assign(registerVisitorHook, {
  [Symbol.for('skip-override')]: true,
  [Symbol.for('fastify.display-name')]: 'cekat-visitor',
  [Symbol.for('plugin-meta')]: { name: 'cekat-visitor' },
});
