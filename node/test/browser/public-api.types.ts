import { readVisitorId, withVisitor, withVisitorRequest } from '../../src/browser/index.js';
import { createAxiosVisitorInterceptor } from '../../src/browser/axios.js';
import type { InternalAxiosRequestConfig } from 'axios';
import * as BrowserApi from '../../src/browser/index.js';

type Assert<T extends true> = T;
type ExpectedValueExportName = 'readVisitorId' | 'withVisitor' | 'withVisitorRequest';
type _NoUnexpectedValueExports = Assert<Exclude<keyof typeof BrowserApi, ExpectedValueExportName> extends never ? true : false>;
type _AllExpectedValueExports = Assert<ExpectedValueExportName extends keyof typeof BrowserApi ? true : false>;

type ReadVisitorId = (cookieSource?: string) => string | undefined;
type WithVisitor = (init?: RequestInit) => RequestInit;
type WithVisitorRequest = (request: Request) => Request;
type AxiosVisitorInterceptor = () => (config: InternalAxiosRequestConfig) => InternalAxiosRequestConfig;

const read: ReadVisitorId = readVisitorId;
const enrich: WithVisitor = withVisitor;
const enrichRequest: WithVisitorRequest = withVisitorRequest;
const createInterceptor: AxiosVisitorInterceptor = createAxiosVisitorInterceptor;

void [read, enrich, enrichRequest, createInterceptor];
