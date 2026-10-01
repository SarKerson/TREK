import { Body, Controller, Headers, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { collabNoteDirectUploadSchema, collabMessageDirectUploadSchema, fileDirectUploadCompleteSchema } from '@trek/shared';
import type { User } from '../../types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CollabDirectUploadService } from './collab-direct-upload.service';

class NoteUploadDto extends createZodDto(collabNoteDirectUploadSchema) {}
class MessageUploadDto extends createZodDto(collabMessageDirectUploadSchema) {}
class CompleteDto extends createZodDto(fileDirectUploadCompleteSchema) {}

@Controller('api/trips/:tripId/collab')
@UseGuards(JwtAuthGuard)
export class CollabDirectUploadController {
  constructor(private readonly uploads: CollabDirectUploadService) {}

  @Post('notes/:noteId/files/direct-upload')
  createNote(@CurrentUser() user: User, @Param('tripId') trip: string, @Param('noteId') note: string, @Body() body: NoteUploadDto) {
    return this.uploads.createNote(trip, note, user, body);
  }

  @Post('notes/:noteId/files/direct-upload/complete')
  @HttpCode(200)
  completeNote(@CurrentUser() user: User, @Param('tripId') trip: string, @Param('noteId') note: string,
    @Body() body: CompleteDto, @Headers('x-socket-id') socketId?: string) {
    return this.uploads.completeNote(trip, note, user, body.id, socketId);
  }

  @Post('messages/direct-upload')
  createMessage(@CurrentUser() user: User, @Param('tripId') trip: string, @Body() body: MessageUploadDto) {
    return this.uploads.createMessage(trip, user, body);
  }

  @Post('messages/direct-upload/complete')
  @HttpCode(200)
  completeMessage(@CurrentUser() user: User, @Param('tripId') trip: string, @Body() body: CompleteDto,
    @Headers('x-socket-id') socketId?: string) {
    return this.uploads.completeMessage(trip, user, body.id, socketId);
  }
}
