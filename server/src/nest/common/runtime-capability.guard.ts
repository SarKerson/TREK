import { isVercelRuntime } from '../../runtime';
import { Injectable, HttpException, type CanActivate, type ExecutionContext } from '@nestjs/common';

import type { Request } from 'express';

export function unavailableRuntimeFeature(path: string): string | null {
  if (/^\/api\/docsync\/webhook(?:\/|$)/i.test(path)) return 'Background document sync';
  if (/^\/api\/admin\/addons\/mcp\/?$/i.test(path)) return 'MCP';
  if (/^\/api\/(?:auth|admin)\/mcp-tokens(?:\/|$)/i.test(path)) return 'MCP';
  if (/^\/api\/backup(?:\/|$)/i.test(path)) return 'Full-instance backup and restore';
  if (/^\/(?:api\/(?:admin\/plugins|plugins|plugin-settings|plugin-activity)|plugin-frame)(?:\/|$)/i.test(path))
    return 'Persistent plugins';
  if (/^\/(?:mcp|oauth|api\/oauth)(?:\/|$)/i.test(path)) return 'MCP';
  if (/^\/api\/admin\/rotate-jwt-secret\/?$/i.test(path)) return 'In-app JWT rotation';
  return null;
}

@Injectable()
export class RuntimeCapabilityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!isVercelRuntime()) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const feature = unavailableRuntimeFeature(req.path);
    // Restore uploads reject in the handler after multipart parsing, preserving
    // the normal JSON error response instead of resetting an unread upload.
    if (['/api/backup/upload-restore', '/api/admin/plugins/upload'].includes(req.path.toLowerCase().replace(/\/$/, '')))
      return true;
    if (feature) throw new HttpException({ error: `${feature} is unavailable on this serverless deployment` }, 503);
    return true;
  }
}
