import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';

import { runWithCekatVisitor, withCekatVisitor } from '../../src/integrations/nextjs.js';
import { currentVisitorId } from '../../src/node/visitor-context.js';

// This module imports the Node-only adapter only from a Next Node runtime route.
export const runtime = 'nodejs';

type VisitorResponse = { visitorId: string | null };

export const GET = (request: Request): Response => runWithCekatVisitor(request, () => {
  return Response.json({ visitorId: currentVisitorId() });
});

const handler = withCekatVisitor((request: NextApiRequest, response: NextApiResponse<VisitorResponse>) => {
  void request;
  return response.status(200).json({ visitorId: currentVisitorId() ?? null });
});

const pagesApiHandler: NextApiHandler<VisitorResponse> = handler;

export default pagesApiHandler;
