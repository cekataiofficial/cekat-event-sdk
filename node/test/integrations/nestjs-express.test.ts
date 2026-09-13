import { BadGatewayException, Body, Controller, Get, Module, Post, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter, type NestExpressApplication } from '@nestjs/platform-express';
import { afterEach, describe, expect, it } from 'vitest';

import { CekatVisitorMiddleware } from '../../src/integrations/nestjs.js';
import { currentVisitorId } from '../../src/node/visitor-context.js';

let application: NestExpressApplication | undefined;

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
    expect(currentVisitorId()).toBe('nest-express-error');
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

async function boot(): Promise<NestExpressApplication> {
  application = await NestFactory.create<NestExpressApplication>(AppModule, new ExpressAdapter(), { logger: false });
  await application.init();
  return application;
}

async function request(path: string, headers: Record<string, string> = {}): Promise<Response> {
  if (application === undefined) throw new Error('Application was not booted');
  const server = application.getHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP listener');
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { headers });
  await application.close();
  application = undefined;
  return response;
}

afterEach(async () => {
  await application?.close();
  application = undefined;
  expect(currentVisitorId()).toBeUndefined();
});

describe('NestJS CekatVisitorMiddleware on Express', () => {
  it('uses header precedence, preserves awaited continuity, and has no instance state', async () => {
    expect(Object.keys(new CekatVisitorMiddleware())).toEqual([]);

    await boot();
    const response = await request('/visitor', {
      'x-cekat-visitor-id': ' express-header ',
      cookie: '_cekat_visitor_id=express-cookie',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ visitorId: 'express-header' });
  });

  it('uses the cookie or no visitor when the header is absent', async () => {
    await boot();
    const cookieResponse = await request('/visitor', { cookie: '_cekat_visitor_id= express-cookie ' });
    expect(cookieResponse.status).toBe(200);
    await expect(cookieResponse.json()).resolves.toEqual({ visitorId: 'express-cookie' });

    await boot();
    const noVisitorResponse = await request('/visitor');
    await expect(noVisitorResponse.json()).resolves.toEqual({ visitorId: null });
  });

  it('isolates parallel requests and cleans scope after every request', async () => {
    const app = await boot();
    const server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP listener');

    const visitorIds = Array.from({ length: 20 }, (_, index) => `nest-express-${index}`);
    const responses = await Promise.all(visitorIds.map((visitorId) => fetch(`http://127.0.0.1:${address.port}/visitor`, {
      headers: { 'x-cekat-visitor-id': visitorId },
    })));

    await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual(
      visitorIds.map((visitorId) => ({ visitorId })),
    );
    await app.close();
    application = undefined;
    expect(currentVisitorId()).toBeUndefined();
  });

  it('keeps the visitor through JSON body parsing on parallel POST requests', async () => {
    const app = await boot();
    const server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP listener');

    const visitorIds = Array.from({ length: 10 }, (_, index) => `nest-express-post-${index}`);
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

  it('preserves the downstream thrown HTTP error semantics', async () => {
    await boot();
    const response = await request('/failure', { 'x-cekat-visitor-id': 'nest-express-error' });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ message: 'downstream failure', statusCode: 502 });
  });
});
