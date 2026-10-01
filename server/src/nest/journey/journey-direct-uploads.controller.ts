import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { journeyDirectUploadRequestSchema } from '@trek/shared';
import type { User } from '../../types';
import { ADDON_IDS } from '../../addons';
import { AddonGuard } from '../addons/addon.guard';
import { RequireAddon } from '../addons/require-addon.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FileDirectUploadCompleteDto } from '../files/files.dto';
import { JourneyDirectUploadsService } from './journey-direct-uploads.service';

export class JourneyDirectUploadDto extends createZodDto(journeyDirectUploadRequestSchema) {}

/** JSON-only siblings of multipart routes; existing routes stay byte-compatible. */
@Controller('api/journeys')
@UseGuards(AddonGuard, JwtAuthGuard)
@RequireAddon(ADDON_IDS.JOURNEY, 'Journey')
export class JourneyDirectUploadsController {
  constructor(private readonly uploads: JourneyDirectUploadsService) {}

  @Post('entries/:entryId/photos/direct-upload')
  createEntryPhotos(@CurrentUser() user: User, @Param('entryId') id: string, @Body() body: JourneyDirectUploadDto) {
    return this.uploads.create('journey-entry-photos', id, user, body);
  }

  @Post('entries/:entryId/photos/direct-upload/complete')
  completeEntryPhotos(@CurrentUser() user: User, @Param('entryId') id: string, @Body() body: FileDirectUploadCompleteDto) {
    return this.uploads.complete('journey-entry-photos', id, user, body.id);
  }

  @Post('entries/:entryId/video/direct-upload')
  createEntryVideo(@CurrentUser() user: User, @Param('entryId') id: string, @Body() body: JourneyDirectUploadDto) {
    return this.uploads.create('journey-entry-video', id, user, body);
  }

  @Post('entries/:entryId/video/direct-upload/complete')
  completeEntryVideo(@CurrentUser() user: User, @Param('entryId') id: string, @Body() body: FileDirectUploadCompleteDto) {
    return this.uploads.complete('journey-entry-video', id, user, body.id);
  }

  @Post(':id/gallery/photos/direct-upload')
  createGalleryPhotos(@CurrentUser() user: User, @Param('id') id: string, @Body() body: JourneyDirectUploadDto) {
    return this.uploads.create('journey-gallery-photos', id, user, body);
  }

  @Post(':id/gallery/photos/direct-upload/complete')
  completeGalleryPhotos(@CurrentUser() user: User, @Param('id') id: string, @Body() body: FileDirectUploadCompleteDto) {
    return this.uploads.complete('journey-gallery-photos', id, user, body.id);
  }

  @Post(':id/gallery/video/direct-upload')
  createGalleryVideo(@CurrentUser() user: User, @Param('id') id: string, @Body() body: JourneyDirectUploadDto) {
    return this.uploads.create('journey-gallery-video', id, user, body);
  }

  @Post(':id/gallery/video/direct-upload/complete')
  completeGalleryVideo(@CurrentUser() user: User, @Param('id') id: string, @Body() body: FileDirectUploadCompleteDto) {
    return this.uploads.complete('journey-gallery-video', id, user, body.id);
  }

  @Post(':id/cover/direct-upload')
  createCover(@CurrentUser() user: User, @Param('id') id: string, @Body() body: JourneyDirectUploadDto) {
    return this.uploads.create('journey-cover', id, user, body);
  }

  @Post(':id/cover/direct-upload/complete')
  @HttpCode(200)
  completeCover(@CurrentUser() user: User, @Param('id') id: string, @Body() body: FileDirectUploadCompleteDto) {
    return this.uploads.complete('journey-cover', id, user, body.id);
  }
}
