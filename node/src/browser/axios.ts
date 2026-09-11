import { AxiosHeaders } from 'axios';
import type { InternalAxiosRequestConfig } from 'axios';

import { VISITOR_HEADER } from './constants.js';
import { readVisitorId } from './cookie.js';

/**
 * Creates an Axios request interceptor for a dedicated Axios instance.
 * The interceptor never mutates the supplied config or its headers.
 */
export function createAxiosVisitorInterceptor(): (config: InternalAxiosRequestConfig) => InternalAxiosRequestConfig {
  return (config) => {
    const headers = AxiosHeaders.from(config.headers).concat();
    const visitorId = readVisitorId();
    if (visitorId !== undefined && !headers.has(VISITOR_HEADER)) headers.set(VISITOR_HEADER, visitorId);
    return { ...config, headers };
  };
}
