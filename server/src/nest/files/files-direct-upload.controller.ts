import { Body, Controller, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { Request } from 'express';
import type { User } from '../../types';
import { FileDirectUploadDto, FileDirectUploadCompleteDto, FileDirectUploadGrantDto } from './files.dto';
import { FilesDirectUploadService } from './files-direct-upload.service';

/** JSON-only endpoints retain TREK's global authentication, MFA, and idempotency guards. */
@Controller('api/trips/:tripId/files/direct-upload')
@UseGuards(JwtAuthGuard)
export class FilesDirectUploadController {
  constructor(private readonly uploads: FilesDirectUploadService) {}

  @Post()
  create(@CurrentUser() user: User, @Param('tripId') tripId: string, @Body() body: FileDirectUploadDto) {
    return this.uploads.create(tripId, user, body);
  }

  @Post('grant')
  @HttpCode(200)
  grant(@CurrentUser() user: User, @Param('tripId') tripId: string,
    @Body() body: FileDirectUploadGrantDto, @Req() request: Request) {
    return this.uploads.grant(tripId, user, body, request);
  }

  @Post('complete')
  @HttpCode(200)
  complete(@CurrentUser() user: User, @Param('tripId') tripId: string,
    @Body() body: FileDirectUploadCompleteDto, @Headers('x-socket-id') socketId?: string) {
    return this.uploads.complete(tripId, user, body.id, socketId);
  }
}
