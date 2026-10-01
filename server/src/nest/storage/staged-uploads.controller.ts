import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { fileDirectUploadGrantSchema } from '@trek/shared';
import type { User } from '../../types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { StagedUploadsService } from './staged-uploads.service';

class StagedGrantDto extends createZodDto(fileDirectUploadGrantSchema) {}

@Controller('api/uploads')
@UseGuards(JwtAuthGuard)
export class StagedUploadsController {
  constructor(private readonly uploads: StagedUploadsService) {}

  @Post('grant')
  @HttpCode(200)
  grant(@CurrentUser() user: User, @Body() body: StagedGrantDto, @Req() request: Request) {
    return this.uploads.grant(user, body, request);
  }
}
