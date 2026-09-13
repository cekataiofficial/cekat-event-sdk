import { BadGatewayException, Body, Controller, Get, Module, Post, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { CekatVisitorMiddleware } from '../../src/integrations/nestjs.js';
import { currentVisitorId } from '../../src/node/visitor-context.js';

let application: NestFastifyApplication | undefined;

async function waitForTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
}

class VisitorController {
  async visitor(): Promise<{ visitorId: string | null }> {
    await waitForTurn();
    return { visitorId: currentVisitorId() ?? null };
  }

  async order(body: { orderId: string }): Promise<{ visitorId: string | null; orderId: string }> {
    await waitForTurn();
    return { visitorId: currentVisitorId() ?? null, orderId: body.orderId };
  }

  async failure(): Promise<never> {
    await waitForTurn();
    expect(currentVisitorId()).toBe('nest-fastify-error');
    throw new BadGatewayException('downstream failure');
  }
}

Controller()(VisitorController);
Get('visitor')(VisitorController.prototype, 'visitor', Object.getOwnPropertyDescriptor(VisitorController.prototype, 'visitor')!);
Get('failure')(VisitorController.prototype, 'failure', Object.getOwnPropertyDescriptor(VisitorController.prototype, 'failure')!);
Post('orders')(VisitorController.prototype, 'order', Object.getOwnPropertyDescriptor(VisitorController.prototype, 'order')!);
Body()(VisitorController.prototype, 'order', 0);

class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CekatVisitorMiddleware).forRoutes('*');
  }
}

Module({ controllers: [VisitorController] })(AppModule);

async function boot(): Promise<NestFastifyApplication> {
  application = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
  await application.init();
  return application;
}

afterEach(async () => {
  await application?.close();
  application = undefined;
  expect(currentVisitorId()).toBeUndefined();
});

describe('NestJS CekatVisitorMiddleware on Fastify', () => {
  it('uses header precedence and maintains the visitor through awaited downstream work', async () => {
    const app = await boot();
    const response = await app.inject({
      method: 'GET',
      url: '/visitor',
      headers: { 'x-cekat-visitor-id': ' fastify-header ', cookie: '_cekat_visitor_id=fastify-cookie' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ visitorId: 'fastify-header' });
  });

  it('uses cookie fallback and no visitor when neither source is present', async () => {
    const app = await boot();
    const cookieResponse = await app.inject({ method: 'GET', url: '/visitor', headers: { cookie: '_cekat_visitor_id= fastify-cookie ' } });
    expect(cookieResponse.json()).toEqual({ visitorId: 'fastify-cookie' });

    const noVisitorResponse = await app.inject({ method: 'GET', url: '/visitor' });
    expect(noVisitorResponse.json()).toEqual({ visitorId: null });
  });

  it('isolates parallel requests and cleans up after completion', async () => {
    const app = await boot();
    const visitorIds = Array.from({ length: 20 }, (_, index) => `nest-fastify-${index}`);
    const responses = await Promise.all(visitorIds.map((visitorId) => app.inject({
      method: 'GET', url: '/visitor', headers: { 'x-cekat-visitor-id': visitorId },
    })));

    expect(responses.map((response) => response.json())).toEqual(visitorIds.map((visitorId) => ({ visitorId })));
    await app.close();
    application = undefined;
    expect(currentVisitorId()).toBeUndefined();
  });

  it('keeps the visitor through JSON body parsing on parallel POST requests', async () => {
    const app = await boot();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP listener');

    const visitorIds = Array.from({ length: 10 }, (_, index) => `nest-fastify-post-${index}`);
    const responses = await Promise.all(visitorIds.map((visitorId, index) => fetch(`http://127.0.0.1:${address.port}/orders`, {
      method: 'POST',
      headers: { 'x-cekat-visitor-id': visitorId, 'content-type': 'application/json' },
      body: JSON.stringify({ orderId: `order-${index}`, padding: 'x'.repeat(64_000) }),
    })));

    expect(responses.map((response) => response.status)).toEqual(visitorIds.map(() => 201));
    await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual(
      visitorIds.map((visitorId, index) => ({ visitorId, orderId: `order-${index}` })),
    );
  });

  it('preserves downstream thrown HTTP error semantics', async () => {
    const app = await boot();
    const response = await app.inject({
      method: 'GET', url: '/failure', headers: { 'x-cekat-visitor-id': 'nest-fastify-error' },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ message: 'downstream failure', statusCode: 502 });
  });
});
